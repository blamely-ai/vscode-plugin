// Working-log + baseline storage — TypeScript port of internal/authorship/store.go.
// Plain files under the checkout-local Git directory so the editor and CLI share one working
// log with no daemon/DB. Same layout, sanitization, atomic temp+rename, and
// portable lockfile as the Go implementation; async so the extension host never
// blocks. Behaves identically on Windows, Linux, and macOS.

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Author, WorkingLog, WORKING_LOG_SCHEMA, attribute } from './attribute';
import { checkoutGitDir } from '../git/GitPaths';

export function sanitizeComponent(s: string): string {
    if (!s) {
        return '_';
    }
    // Branch names contain '/', and Windows forbids \ : * ? " < > | and controls.
    return s.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-');
}

export function cleanRel(rel: string): string {
    return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function workingLogDir(repoRoot: string, branch: string, baseSha: string): string {
    return path.join(checkoutGitDir(repoRoot), 'blamely', 'working_logs', sanitizeComponent(branch), sanitizeComponent(baseSha));
}

export function workingLogPath(repoRoot: string, branch: string, baseSha: string, relPath: string): string {
    return path.join(workingLogDir(repoRoot, branch, baseSha), cleanRel(relPath).split('/').join(path.sep) + '.json');
}

export function baselinePath(repoRoot: string, branch: string, baseSha: string, relPath: string): string {
    return path.join(workingLogDir(repoRoot, branch, baseSha), '.baselines', cleanRel(relPath).split('/').join(path.sep));
}

async function atomicWrite(p: string, data: string): Promise<void> {
    const dir = path.dirname(p);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.wl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p); // atomic + replace-existing on all three OSes
}

export async function loadWorkingLog(repoRoot: string, branch: string, baseSha: string, relPath: string): Promise<WorkingLog | null> {
    try {
        return JSON.parse(await fsp.readFile(workingLogPath(repoRoot, branch, baseSha, relPath), 'utf8')) as WorkingLog;
    } catch {
        return null; // missing or unreadable → no prior state
    }
}

export async function loadBaseline(p: string): Promise<string | null> {
    try {
        return await fsp.readFile(p, 'utf8');
    } catch {
        return null;
    }
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;
const LOCK_POLL_MS = 15;

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// withFileLock serializes the read-modify-write across the two writers (this
// plugin and the CLI). O_EXCL lockfile (no portable flock); a lock older than
// LOCK_STALE_MS is treated as orphaned and stolen. Mirrors store.go.
async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const lock = target + '.lock';
    await fsp.mkdir(path.dirname(lock), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            fs.closeSync(fs.openSync(lock, 'wx')); // wx = O_CREAT|O_EXCL
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw e;
            }
            try {
                const st = fs.statSync(lock);
                if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                    fs.unlinkSync(lock);
                    continue;
                }
            } catch { /* lock vanished — retry */ }
            if (Date.now() > deadline) {
                throw new Error(`authorship: timed out acquiring lock ${lock}`);
            }
            await delay(LOCK_POLL_MS);
            continue;
        }
        try {
            return await fn();
        } finally {
            try { fs.unlinkSync(lock); } catch { /* already gone */ }
        }
    }
}

/**
 * save persists an already-computed working log + its content baseline (the
 * editor live-tracker holds the log in memory and applies edits per-change; this
 * just writes the latest state on flush). Locked + atomic, same files as update.
 */
export async function save(
    repoRoot: string, branch: string, baseSha: string, relPath: string,
    wl: WorkingLog, content: string,
): Promise<void> {
    const rel = cleanRel(relPath);
    const wlPath = workingLogPath(repoRoot, branch, baseSha, relPath);
    const basePath = baselinePath(repoRoot, branch, baseSha, relPath);
    wl.schema = WORKING_LOG_SCHEMA;
    wl.file = rel;
    wl.base_sha = baseSha;
    await withFileLock(wlPath, async () => {
        await atomicWrite(wlPath, JSON.stringify(wl, null, 2));
        await atomicWrite(basePath, content);
    });
}

/**
 * update applies one observed edit to relPath's working log under a per-file lock:
 * diff the stored baseline against newContent, attribute changed lines to author,
 * persist the updated log + newContent as the next baseline. fallbackBaseline is
 * the diff's old side only on the first edit (no stored baseline). Mirrors
 * store.go Update.
 */
export async function update(
    repoRoot: string, branch: string, baseSha: string, relPath: string,
    newContent: string, fallbackBaseline: string, author: Author, nowMs = 0,
): Promise<WorkingLog> {
    const rel = cleanRel(relPath);
    const wlPath = workingLogPath(repoRoot, branch, baseSha, relPath);
    const basePath = baselinePath(repoRoot, branch, baseSha, relPath);

    return withFileLock(wlPath, async () => {
        const prior = await loadWorkingLog(repoRoot, branch, baseSha, relPath);
        const stored = await loadBaseline(basePath);
        const baseline = stored !== null ? stored : fallbackBaseline;

        const wl = attribute(prior, baseline, newContent, author, nowMs);
        wl.schema = WORKING_LOG_SCHEMA;
        wl.file = rel;
        wl.base_sha = baseSha;

        await atomicWrite(wlPath, JSON.stringify(wl, null, 2));
        await atomicWrite(basePath, newContent);
        return wl;
    });
}

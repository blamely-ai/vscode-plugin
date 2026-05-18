import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as Logger from '../utils/Logger';
import { isWindows } from '../utils/Platform';

/**
 * Blamely user data root (~/.blamely).
 * Precedence matches blamely-cli `blamelydir.UserBase` exactly: BLAMELY_HOME, BLAMELY_DATA_HOME, else ~/.blamely.
 * (`BLAMELY_SESSION_HOME` is used only for legacy paths in `BlamelyRepoPaths.getLegacySessionStoreRoot`.)
 */
export function blamelyDataRoot(): string {
    const homeOverride = process.env.BLAMELY_HOME?.trim();
    if (homeOverride) {
        return path.normalize(homeOverride);
    }
    const dataHome = process.env.BLAMELY_DATA_HOME?.trim();
    if (dataHome) {
        return path.normalize(dataHome);
    }
    return path.join(os.homedir(), '.blamely');
}

/** @deprecated Prefer {@link blamelyDataRoot}; kept for calls that predate naming alignment. */
export function blamelyUserLayoutRoot(): string {
    return blamelyDataRoot();
}

/** Normalize + resolve symlinks so the same repo does not fork storage (macOS `/var` vs `/private/var`, junctions). */
export function canonicalRepoDiskPath(repoRoot: string): string {
    const n = path.normalize(repoRoot);
    try {
        return fs.realpathSync(n);
    } catch {
        return n;
    }
}

/** Per-repo workspace under the layout root (snapshots, branch sessions, hookRunner.js, …). */
export function userBlamelyReposRoot(): string {
    return path.join(blamelyDataRoot(), 'repos');
}

/** Stable short id for `repoRoot` (same hashing as persisted session manifests). */
export function blamelyRepoStableId(repoRoot: string): string {
    return crypto.createHash('sha256').update(canonicalRepoDiskPath(repoRoot)).digest('hex').slice(0, 8);
}

const RESERVED_REPO_BUCKET_NAMES = new Set([
    'cli-traces',
    'snapshots',
    'branches',
    'sessions',
    'logs',
    'hookRunner.js',
    'hookRunner-pre-push.sh',
    'blamely-detector.ai',
]);

function sanitizedBasenameForRepoBucket(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        return 'HEAD';
    }
    const s = trimmed
        .replace(/\//g, '-')
        .replace(/\\/g, '-')
        .replace(/:/g, '-')
        .replace(/\*/g, '-')
        .replace(/\?/g, '-')
        .replace(/"/g, '-')
        .replace(/</g, '-')
        .replace(/>/g, '-')
        .replace(/\|/g, '-');
    return s || 'HEAD';
}

/**
 * Human-readable ~/.blamely/repos/<segment>/ name: sanitized basename of the git root
 * (matches blamely-cli `RepoBucketName` / IntelliJ `repoBucketName`).
 */
export function repoBucketDirName(repoRoot: string): string {
    const canon = canonicalRepoDiskPath(repoRoot);
    const base = path.basename(canon);
    if (!base || base === '.' || base === '..' || base === '/' || base === '\\') {
        return 'repo-' + blamelyRepoStableId(canon);
    }
    const s = sanitizedBasenameForRepoBucket(base);
    if (!s || s === 'HEAD' || s === '.' || s === '..') {
        return 'repo-' + blamelyRepoStableId(canon);
    }
    if (RESERVED_REPO_BUCKET_NAMES.has(s)) {
        return 'repo-' + s;
    }
    return s;
}

/** Full 64-char SHA-256 key matching blamely-cli's blamelydir.repoKey (no truncation). */
export function cliTraceRepoKey(repoRoot: string): string {
    let normalized = canonicalRepoDiskPath(repoRoot).replace(/\\/g, '/');
    if (normalized.length >= 2 && normalized[1] === ':') {
        normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Legacy: ~/.blamely/repos/<cliRepoKey>/cli-traces/ (pre–branch-trace layout). */
export function cliTraceParentDir(repoRoot: string): string {
    return path.join(blamelyDataRoot(), 'repos', cliTraceRepoKey(repoRoot), 'cli-traces');
}

function run(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const shell = isWindows() ? 'cmd.exe' : '/bin/sh';
        exec(cmd, { cwd, shell }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`${cmd} failed: ${stderr || err.message}`));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

async function runSafe(cwd: string, ...args: string[]): Promise<string | null> {
    try {
        const cmd = `git ${args.map(a => (a.includes(' ') || a.includes('^') ? `"${a}"` : a)).join(' ')}`;
        return await run(cmd, cwd);
    } catch {
        return null;
    }
}

export interface FileDiffStats {
    addedLines: number[];
    deletedLines: number[];
    addedCount: number;
    deletedCount: number;
}

const EMPTY_DIFF_STATS: FileDiffStats = {
    addedLines: [],
    deletedLines: [],
    addedCount: 0,
    deletedCount: 0,
};

/** Parse unified diff hunks from `git show -p` / `git diff -p` output (same line-number rules as {@link getDiffStats}). */
export function parseUnifiedDiffPatch(patch: string): FileDiffStats {
    const added: number[] = [];
    const deleted: number[] = [];
    let currentNewLine = 0;
    let currentOldLine = 0;
    const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
    for (const line of patch.split('\n')) {
        const hunk = hunkRe.exec(line);
        if (hunk) {
            currentOldLine = parseInt(hunk[1], 10) || 0;
            currentNewLine = parseInt(hunk[2], 10) || 0;
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            added.push(currentNewLine);
            currentNewLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            deleted.push(currentOldLine);
            currentOldLine++;
        } else if (line.startsWith(' ')) {
            currentNewLine++;
            currentOldLine++;
        }
    }
    return {
        addedLines: added,
        deletedLines: deleted,
        addedCount: added.length,
        deletedCount: deleted.length,
    };
}

/** Repo-relative paths with staged changes (compares index to HEAD). */
export async function listStagedRepoRelativePaths(cwd: string): Promise<string[]> {
    const out = await runSafe(cwd, 'diff', '--cached', '--name-only');
    if (!out?.trim()) return [];
    return out
        .split('\n')
        .map(s => s.trim().replace(/\\/g, '/'))
        .filter(Boolean);
}

/** Line adds/deletes for staged diff vs HEAD (1-based line indices). */
export async function getStagedDiffStats(cwd: string, filePathRepoRelative: string): Promise<FileDiffStats> {
    const out = await runSafe(cwd, 'diff', '--cached', '-p', '--', filePathRepoRelative);
    if (!out?.trim()) return { ...EMPTY_DIFF_STATS };
    return parseUnifiedDiffPatch(out);
}

/** Paths (repo-relative) of files changed in the given commit. */
export async function getFilesChangedInCommit(cwd: string, commitSha: string): Promise<string[]> {
    let out = await runSafe(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', commitSha);
    if (!out?.trim()) {
        const hasParent = await runSafe(cwd, 'rev-parse', `${commitSha}^`) != null;
        if (!hasParent) {
            out = await runSafe(cwd, 'ls-tree', '-r', '--name-only', commitSha);
        }
    }
    if (!out?.trim()) return [];
    return out
        .split('\n')
        .map(s => s.trim().replace(/\\/g, '/'))
        .filter(Boolean);
}

/**
 * Parse unified diff for a file in a commit. Added lines are 1-based in the NEW file; deleted in the OLD file.
 */
export async function getDiffStats(
    cwd: string,
    commitSha: string,
    filePathRepoRelative: string
): Promise<FileDiffStats> {
    const out = await runSafe(cwd, 'show', commitSha, '-p', '--', filePathRepoRelative);
    if (!out) return { ...EMPTY_DIFF_STATS };
    return parseUnifiedDiffPatch(out);
}

/** Human-readable `git show` summary for a commit (header + `--stat`). */
export async function getCommitShowSummary(cwd: string, sha: string): Promise<string | null> {
    try {
        const header = await runSafe(cwd, 'show', '-s', '--format=%H%n%s%n%ci', sha);
        const stat = await runSafe(cwd, 'show', '--stat', '--format=', sha);
        if (!header?.trim()) {
            return null;
        }
        return [header.trim(), stat?.trim() || ''].filter(Boolean).join('\n\n');
    } catch {
        return null;
    }
}

/** Convert repo-relative paths to workspace-relative. Returns Map(repoRelative -> projectRelative). */
export function repoRelativeToProjectRelative(
    repoRoot: string,
    workspaceRoot: string | null,
    repoRelativePaths: string[]
): Map<string, string> {
    const result = new Map<string, string>();
    const norm = (s: string) => path.normalize(s).replace(/\\/g, '/').replace(/\/$/, '');
    if (!workspaceRoot?.trim()) {
        repoRelativePaths.forEach(p => result.set(p.replace(/\\/g, '/'), p.replace(/\\/g, '/')));
        return result;
    }
    const normRepo = norm(repoRoot);
    const normWs = norm(workspaceRoot);
    const normalizedPaths = repoRelativePaths.map(p => p.replace(/\\/g, '/'));
    if (normWs === normRepo) {
        normalizedPaths.forEach(p => result.set(p, p));
        return result;
    }
    if (!normWs.startsWith(normRepo + '/')) {
        normalizedPaths.forEach(p => result.set(p, p));
        return result;
    }
    const prefix = normWs.slice(normRepo.length + 1) + '/';
    for (const p of normalizedPaths) {
        if (p === prefix.slice(0, -1)) result.set(p, '');
        else if (p.startsWith(prefix)) result.set(p, p.slice(prefix.length));
        else result.set(p, p);
    }
    return result;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
    try {
        await run('git rev-parse --is-inside-work-tree', cwd);
        return true;
    } catch {
        return false;
    }
}

export async function gitAdd(files: string[], cwd: string): Promise<void> {
    try {
        const fileArgs = files.map(f => `"${f}"`).join(' ');
        await run(`git add ${fileArgs}`, cwd);
        Logger.info(`Staged files: ${files.join(', ')}`);
    } catch (err) {
        Logger.error('Failed to stage files', err);
    }
}

export async function getLatestCommitSha(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse HEAD', cwd);
    } catch {
        return null;
    }
}

/** Resolve a short or full commit SHA to full 40-char SHA. */
export async function resolveCommitSha(cwd: string, ref: string): Promise<string | null> {
    try {
        return await run(`git rev-parse ${ref}`, cwd);
    } catch {
        return null;
    }
}

export async function getShortSha(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse --short=8 HEAD', cwd);
    } catch {
        return null;
    }
}

export async function getGitDir(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse --git-dir', cwd);
    } catch {
        return null;
    }
}

async function copyRepoTreeMergeIfMissing(destRoot: string, srcRoot: string): Promise<void> {
    try {
        if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
            return;
        }
        await fs.promises.mkdir(destRoot, { recursive: true });
        const entries = await fs.promises.readdir(srcRoot, { withFileTypes: true });
        for (const ent of entries) {
            const sp = path.join(srcRoot, ent.name);
            const dp = path.join(destRoot, ent.name);
            try {
                if (ent.isDirectory()) {
                    await copyRepoTreeMergeIfMissing(dp, sp);
                } else if (ent.isFile() && !fs.existsSync(dp)) {
                    await fs.promises.copyFile(sp, dp);
                }
            } catch {
                /* best-effort migration */
            }
        }
    } catch {
        /* best-effort migration */
    }
}

/**
 * Ensure ~/.blamely/repos/<repo-name>/ exists, copying from the legacy 64-hex bucket once if needed.
 */
export async function ensureUserRepoBucketLayout(repoRoot: string): Promise<void> {
    const canon = canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    await fs.promises.mkdir(userBlamelyReposRoot(), { recursive: true });
    const namedDir = path.join(userBlamelyReposRoot(), repoBucketDirName(canon));
    const hashDir = path.join(userBlamelyReposRoot(), cliTraceRepoKey(canon));
    if (!fs.existsSync(namedDir) && fs.existsSync(hashDir)) {
        await copyRepoTreeMergeIfMissing(namedDir, hashDir);
    }
    await fs.promises.mkdir(namedDir, { recursive: true });
}

/** Per-repo dir under ~/.blamely/repos/<repo-name>/ (hookRunner.js, branches, snapshots). Legacy cli-traces remain under {@link cliTraceParentDir}. */
export async function getBlamelyDataDir(cwd: string): Promise<string | null> {
    const repoRoot = await getRepoRoot(cwd);
    if (!repoRoot) {
        return null;
    }
    const canonRepo = canonicalRepoDiskPath(repoRoot);
    await ensureUserRepoBucketLayout(canonRepo);
    return path.join(userBlamelyReposRoot(), repoBucketDirName(canonRepo));
}

/**
 * Repository root (absolute path).
 * Accepts a directory or a **file** path (e.g. active editor path); Git must run with a directory cwd.
 */
export async function getRepoRoot(cwdOrFile: string): Promise<string | null> {
    try {
        let dir = path.normalize(cwdOrFile);
        try {
            const st = await fs.promises.stat(dir);
            if (!st.isDirectory()) {
                dir = path.dirname(dir);
            }
        } catch {
            dir = path.dirname(dir);
        }
        return await run('git rev-parse --show-toplevel', dir);
    } catch {
        return null;
    }
}

export async function getBranch(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse --abbrev-ref HEAD', cwd);
    } catch {
        return null;
    }
}

/** Local branch short names under refs/heads/ (for reconciling blamely branch folder names). */
export async function listLocalBranches(cwd: string): Promise<Set<string>> {
    const out = await runSafe(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/');
    const s = new Set<string>();
    if (!out?.trim()) {
        return s;
    }
    for (const line of out.split('\n')) {
        const n = line.trim();
        if (n) {
            s.add(n);
        }
    }
    return s;
}

/** One entry from `git stash list` (latest first). */
export interface GitStashEntry {
    /** e.g. `stash@{0}` */
    ref: string;
    /** Commit hash of the stash WIP commit. */
    stashCommit: string;
    subject: string;
}

/**
 * Latest stash entry for the repo, or null if there is no stash.
 * Uses `%x1f` field separators so subjects with spaces stay in one field.
 */
export async function getLatestStashEntry(cwd: string): Promise<GitStashEntry | null> {
    const out = await runSafe(cwd, 'stash', 'list', '-n', '1', '--format=%gd%x1f%H%x1f%s');
    if (!out?.trim()) {
        return null;
    }
    const parts = out.trim().split('\x1f');
    if (parts.length < 3) {
        return null;
    }
    const ref = parts[0].trim();
    const stashCommit = parts[1].trim();
    const subject = parts.slice(2).join('\x1f').trim();
    if (!ref || !stashCommit) {
        return null;
    }
    return { ref, stashCommit, subject };
}

export async function getCommitMessage(cwd: string): Promise<string | null> {
    try {
        return await run('git log -1 --pretty=%B', cwd);
    } catch {
        return null;
    }
}

/** Add or replace the blamely git note on `sha`. Returns false if the note could not be written. */
export async function addGitNote(sha: string, content: string, cwd: string): Promise<boolean> {
    try {
        const fs = await import('fs');
        const pathMod = await import('path');
        const os = await import('os');
        const tmpPath = pathMod.join(os.tmpdir(), `blamely-note-${sha}.txt`);
        await fs.promises.writeFile(tmpPath, content, 'utf-8');

        await run(`git notes --ref=blamely add -F "${tmpPath}" -f ${sha}`, cwd);
        await fs.promises.unlink(tmpPath);
        Logger.info(`Added git note to commit ${sha}`);
        return true;
    } catch (err) {
        Logger.error(`Failed to add git note to ${sha}`, err);
        return false;
    }
}

/** Files with uncommitted changes (staged + unstaged), repo-relative. */
export async function getUncommittedFiles(cwd: string): Promise<Set<string>> {
    const result = new Set<string>();
    const unstaged = await runSafe(cwd, 'diff', '--name-only');
    const staged = await runSafe(cwd, 'diff', '--cached', '--name-only');
    for (const out of [unstaged, staged]) {
        if (out?.trim()) {
            for (const line of out.split('\n')) {
                const f = line.trim().replace(/\\/g, '/');
                if (f) result.add(f);
            }
        }
    }
    return result;
}

/**
 * Repo-relative paths that differ from HEAD: modified (staged/unstaged) plus untracked
 * (not ignored). Used to show only current working-tree changes in the Changes panel.
 */
export async function getWorkingTreeChangedFiles(cwd: string): Promise<Set<string>> {
    const result = await getUncommittedFiles(cwd);
    const untracked = await runSafe(cwd, 'ls-files', '--others', '--exclude-standard');
    if (untracked?.trim()) {
        for (const line of untracked.split('\n')) {
            const f = line.trim().replace(/\\/g, '/');
            if (f) result.add(f);
        }
    }
    return result;
}

export async function pushGitNotes(cwd: string): Promise<void> {
    try {
        const remotes = await run('git remote', cwd);
        if (remotes.trim().length > 0) {
            await run('git push origin refs/notes/blamely', cwd);
            Logger.info('Pushed blamely notes to remote');
        }
    } catch (err) {
        Logger.warn(`Could not push git notes (might not have upstream access): ${err}`);
    }
}

/** Read git note content for a specific commit (from refs/notes/blamely). */
export async function getNoteContent(cwd: string, sha: string): Promise<string | null> {
    return runSafe(cwd, 'notes', '--ref=blamely', 'show', sha);
}

/** Public exported wrapper for arbitrary git commands (returns stdout or null). */
export async function runGitCommand(cwd: string, ...args: string[]): Promise<string | null> {
    return runSafe(cwd, ...args);
}

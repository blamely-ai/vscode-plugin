import { execFile } from 'child_process';
import { debug, promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { dbPath, blamelyHome } from './paths';
import { CliEditRow } from './types';
import * as Logger from '../utils/Logger';

const execFileAsync = promisify(execFile);

// sqlite3 binaries to try, in order. The blamely bin dir comes first because the
// installer drops a sqlite3 there (so it works without a system install or PATH
// changes); then a bare name (resolved via PATH by CreateProcess/exec); then the
// well-known Unix locations. Windows has no sqlite3 by default and macOS/Linux
// differ, so this must be platform-aware — the old hardcoded Unix list left the
// VS Code blame reader (and thus the gutter + status bar) dead on Windows.
function sqliteCandidates(): string[] {
    const binDir = path.join(blamelyHome(), 'bin');
    if (process.platform === 'win32') {
        return [path.join(binDir, 'sqlite3.exe'), 'sqlite3.exe', 'sqlite3'];
    }
    return [path.join(binDir, 'sqlite3'), 'sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'];
}

type LoadMode = 'session' | 'legacy';

// Returns null when the database could not be read (binary missing, locked, IO).
async function runSqliteJson(db: string, sql: string): Promise<unknown[] | null> {
    let lastErr: unknown = null;
    for (const bin of sqliteCandidates()) {
        // Absolute candidates must exist on disk; bare names (sqlite3/sqlite3.exe)
        // are left for exec to resolve via PATH.
        if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
            continue;
        }
        try {
            const { stdout } = await execFileAsync(bin, ['-json', db, sql], {
                maxBuffer: 16 * 1024 * 1024,
            });
            const trimmed = stdout.trim();
            if (!trimmed) {
                return [];
            }
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            lastErr = err;
        }
    }
    Logger.warn(`SqliteReader: read failed: ${lastErr}`);
    return null;
}

function esc(s: string): string {
    return s.replace(/'/g, "''");
}

function repoPathInList(repoPaths: string[]): string {
    const uniq = [...new Set(repoPaths.filter(Boolean))];
    return uniq.map(p => `'${esc(p)}'`).join(', ');
}

function buildWhere(
    repoPaths: string[],
    branch: string | null,
    workBaseHead: string,
    mode: LoadMode,
): string {
    const repoIn = repoPathInList(repoPaths);
    const branchKey = esc(branch ?? '');
    const head = esc(workBaseHead);

    if (mode === 'legacy') {
        if (branch != null) {
            return `e.repo_path IN (${repoIn}) AND (e.session_id IS NULL AND (e.branch = '${branchKey}' OR e.branch IS NULL))`;
        }
        return `e.repo_path IN (${repoIn}) AND e.session_id IS NULL`;
    }

    // session: current work cycle (branch + HEAD tip)
    const legacy =
        branch != null
            ? `(e.session_id IS NULL AND (e.branch = '${branchKey}' OR e.branch IS NULL))`
            : `(e.session_id IS NULL AND e.branch IS NULL)`;
    if (branch != null) {
        return `e.repo_path IN (${repoIn}) AND (
  e.session_id IN (
    SELECT id FROM sessions
    WHERE branch = '${branchKey}' AND base_sha = '${head}' AND repo_path IN (${repoIn})
  )
  OR ${legacy}
)`;
    }
    return `e.repo_path IN (${repoIn}) AND ${legacy}`;
}

function mapRows(rows: unknown[] | null): CliEditRow[] | null {
    if (rows === null) {
        return null;
    }
    return rows
        .map(r => {
            const row = r as Record<string, unknown>;
            return {
                id: Number(row.id),
                ts: Number(row.ts),
                file_path: String(row.file_path ?? ''),
                tool: String(row.tool ?? 'human'),
                model: row.model != null ? String(row.model) : null,
                gen_type: String(row.gen_type ?? 'unknown'),
                start_line: Number(row.start_line),
                end_line: Number(row.end_line),
                content_sha:
                    row.content_sha != null && String(row.content_sha) !== ''
                        ? String(row.content_sha)
                        : null,
                content_sha_norm:
                    row.content_sha_norm != null && String(row.content_sha_norm) !== ''
                        ? String(row.content_sha_norm)
                        : null,
            };
        })
        .filter(r => r.file_path && r.start_line > 0 && r.end_line >= r.start_line);
}

async function queryEdits(
    repoPaths: string[],
    branch: string | null,
    workBaseHead: string,
    mode: LoadMode,
): Promise<CliEditRow[] | null> {
    const where = buildWhere(repoPaths, branch, workBaseHead, mode);
    // Do not prefix PRAGMA: sqlite3 -json returns one JSON array per statement.
    const sql = `
        SELECT e.id AS id, e.ts AS ts, e.file_path AS file_path, e.tool AS tool,
               e.model AS model, e.gen_type AS gen_type,
               el.start_line AS start_line, el.end_line AS end_line, el.content_sha AS content_sha,
               el.content_sha_norm AS content_sha_norm
        FROM edits e
        JOIN edit_lines el ON el.edit_id = e.id
        WHERE ${where}
        ORDER BY e.ts DESC, e.id DESC
    `;
    return mapRows(await runSqliteJson(dbPath(), sql));
}

function repoPathCandidates(repoId: string, repoRoot?: string): string[] {
    const out = new Set<string>();
    out.add(repoId);
    if (repoRoot) {
        out.add(repoRoot.replace(/[/\\]+$/, ''));
        try {
            out.add(fs.realpathSync(repoRoot));
        } catch {
            /* ignore */
        }
        out.add(path.normalize(repoRoot));
    }
    return [...out];
}

/**
 * Loads edits for the current work session, with a fallback for IDE reopen:
 * 1) branch + HEAD session (current session_id, or legacy NULL rows on this
 *    branch), 2) legacy unscoped rows.
 *
 * Deliberately does NOT fall back to "any session on this branch": content_sha
 * attribution must stay scoped to the current session, otherwise a human
 * pasting AI code generated in a PREVIOUS session (e.g. before the last
 * commit) would be matched against that stale content_sha and shown as AI.
 */
async function logSessionCandidates(
    paths: string[],
    branch: string | null,
    head: string,
    mode: LoadMode,
): Promise<void> {
    if (branch == null || mode !== 'session') return;
    const repoIn = repoPathInList(paths);
    const sql = `SELECT id, base_sha FROM sessions WHERE branch = '${esc(branch)}' AND repo_path IN (${repoIn}) ORDER BY base_sha DESC LIMIT 8`;
    const rows = await runSqliteJson(dbPath(), sql);
    if (!rows) return;
    const ids = rows.map(r => {
        const row = r as Record<string, unknown>;
        const id = String(row.id ?? '');
        const base = String(row.base_sha ?? '').slice(0, 12);
        return `${id}@${base}`;
    });
    Logger.debug(
        `SqliteReader: sessions mode=${mode} branch=${branch} head=${head.slice(0, 12)} ` +
            `candidates=[${ids.join(', ')}] matchHead=${ids.some(s => s.includes(head.slice(0, 12)))}`,
    );
}

export async function loadEditsForRepo(
    repoId: string,
    branch: string | null,
    workBaseHead: string | null,
    repoRoot?: string,
): Promise<CliEditRow[] | null> {
    const db = dbPath();
    if (!fs.existsSync(db)) {
        return [];
    }
    const head = (workBaseHead ?? '').trim();
    const paths = repoPathCandidates(repoId, repoRoot);
    let anySuccessfulRead = false;

    for (const mode of ['session', 'legacy'] as LoadMode[]) {
        await logSessionCandidates(paths, branch, head, mode);
        const rows = await queryEdits(paths, branch, head, mode);
        if (rows === null) {
            continue;
        }
        anySuccessfulRead = true;
        if (rows.length > 0) {
            Logger.debug(
                `SqliteReader: loaded ${rows.length} lines mode=${mode} paths=${paths.join(',')} ` +
                    `branch=${branch} head=${head.slice(0, 12)}`,
            );
            return rows;
        }
    }
    if (anySuccessfulRead) {
        Logger.debug(
            `SqliteReader: no edits paths=${paths.join(',')} branch=${branch} head=${head.slice(0, 12)}`,
        );
        return [];
    }
    Logger.warn(`SqliteReader: read failed for all modes paths=${paths.join(',')} branch=${branch}`);
    return null;
}

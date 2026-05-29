import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { dbPath } from './paths';
import { CliEditRow } from './types';
import * as Logger from '../utils/Logger';

const execFileAsync = promisify(execFile);

const SQLITE_CANDIDATES = ['sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'];

async function runSqliteJson(db: string, sql: string): Promise<unknown[]> {
    for (const bin of SQLITE_CANDIDATES) {
        if (bin !== 'sqlite3' && !fs.existsSync(bin)) {
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
            if (bin === SQLITE_CANDIDATES[SQLITE_CANDIDATES.length - 1]) {
                Logger.warn(`SqliteReader: ${err}`);
            }
        }
    }
    return [];
}

/** All edit line ranges for a repo since a given nanosecond timestamp, newest edit first. */
export async function loadEditsForRepo(repoId: string, sinceNanos = 0): Promise<CliEditRow[]> {
    const db = dbPath();
    if (!fs.existsSync(db)) {
        return [];
    }
    const escaped = repoId.replace(/'/g, "''");
    const sql = `
        SELECT e.id AS id, e.ts AS ts, e.file_path AS file_path, e.tool AS tool,
               e.model AS model, e.gen_type AS gen_type,
               el.start_line AS start_line, el.end_line AS end_line
        FROM edits e
        JOIN edit_lines el ON el.edit_id = e.id
        WHERE e.repo_path = '${escaped}' AND e.ts >= ${sinceNanos}
        ORDER BY e.ts DESC, e.id DESC
    `;
    const rows = await runSqliteJson(db, sql);
    return rows.map(r => {
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
        };
    }).filter(r => r.file_path && r.start_line > 0 && r.end_line >= r.start_line);
}

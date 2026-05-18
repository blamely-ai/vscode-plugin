import * as fs from 'fs';
import * as path from 'path';
import * as GitUtils from '../git/GitUtils';
import { sanitizedBranchDirName, userRepoDataDir } from './BlamelyRepoPaths';

/** report.yml next to blamely-cli `session.json` for a branch. */
export function cliTraceReportPath(repoRoot: string, branch: string): string {
    return path.join(
        userRepoDataDir(repoRoot),
        'branches',
        sanitizedBranchDirName(branch),
        'trace',
        'report.yml'
    );
}

export interface CliFileEntry {
    path: string;
    classification: 'ai' | 'mixed';
    confidence: 'high' | 'low';
    reasons: string[];
}

export interface CliTraceSession {
    schema_version: number;
    trace_id: string;
    scope: string;
    started_at: string;
    ended_at: string;
    repo_root: string;
    git: {
        branch: string;
        head_at_start: string;
        head_after_trace?: string;
    };
    traced_command: { argv: string[]; exit_code: number };
    report_model?: string;
    files: CliFileEntry[];
    watch_touched?: string[];
}

/** Stable fingerprint of loaded sessions so file watcher bursts can skip redundant work. */
export function cliSessionsFingerprint(sessions: CliTraceSession[]): string {
    if (sessions.length === 0) {
        return '';
    }
    return sessions
        .map(s => `${s.trace_id}\t${s.ended_at}\t${s.files?.length ?? 0}`)
        .sort()
        .join('\n');
}

/** True for blamely-cli session.json scope (legacy `ai_cli_trace` or `blamely-cli-*`). */
export function isCliTraceScope(scope: string | undefined): boolean {
    if (scope == null || scope === '') {
        return false;
    }
    return scope === 'ai_cli_trace' || scope.startsWith('blamely-cli-');
}

/**
 * Loads blamely-cli trace sessions from legacy `.../cli-traces/<uuid>/session.json` only.
 * `branches/<branch>/trace/session.json` is not read (trace directory unused).
 */
export async function loadCliTraceSessions(repoRoot: string): Promise<CliTraceSession[]> {
    const canon = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    await GitUtils.ensureUserRepoBucketLayout(canon);
    const byId = new Map<string, CliTraceSession>();
    try {
        const legacy = GitUtils.cliTraceParentDir(repoRoot);
        const legacyEntries = await fs.promises.readdir(legacy, { withFileTypes: true });
        for (const entry of legacyEntries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const sessionPath = path.join(legacy, entry.name, 'session.json');
            const parsed = await readAndParseSession(sessionPath);
            if (parsed && !byId.has(parsed.trace_id)) {
                byId.set(parsed.trace_id, parsed);
            }
        }
    } catch {
        /* no legacy */
    }
    return Array.from(byId.values()).sort((a, b) => b.ended_at.localeCompare(a.ended_at));
}

async function readAndParseSession(filePath: string): Promise<CliTraceSession | null> {
    try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const doc = JSON.parse(raw) as CliTraceSession;
        if (!isCliTraceScope(doc.scope) || !doc.trace_id) { return null; }
        return doc;
    } catch {
        return null;
    }
}

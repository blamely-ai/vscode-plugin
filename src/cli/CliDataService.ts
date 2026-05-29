import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { loadEditsForRepo } from './SqliteReader';
import { getRepoId } from './repoId';
import { checkCliHealth } from './CliHealth';
import { CliEditRow, DaemonStatus } from './types';
import * as GitUtils from '../git/GitUtils';
import * as Logger from '../utils/Logger';

const AI_TOOLS = new Set(['claude', 'cursor', 'codex', 'copilot', 'gemini']);

/**
 * Parse `git diff --unified=0 HEAD` output into a map of relPath → added line numbers.
 * Used to populate human LineBlame entries in the BlameMap.
 */
function parseHumanLines(diffOutput: string): Map<string, number[]> {
    const result = new Map<string, number[]>();
    let currentFile: string | null = null;
    for (const line of diffOutput.split('\n')) {
        if (line.startsWith('+++ b/')) {
            currentFile = line.slice(6).replace(/\\/g, '/').trim();
            if (!result.has(currentFile)) result.set(currentFile, []);
        } else if (line.startsWith('+++ /dev/null')) {
            currentFile = null; // deleted file — no added lines
        } else if (line.startsWith('@@ ') && currentFile) {
            const m = /\+(\d+)(?:,(\d+))?/.exec(line);
            if (m) {
                const start = parseInt(m[1]);
                const count = m[2] !== undefined ? parseInt(m[2]) : 1;
                const lines = result.get(currentFile)!;
                for (let i = 0; i < count; i++) {
                    if (start + i > 0) lines.push(start + i);
                }
            }
        }
    }
    return result;
}

function buildHumanLineBlame(lineNumber: number): LineBlame {
    return {
        lineNumber,
        authorType: 'HUMAN',
        provider: null,
        timestamp: new Date().toISOString(),
        commitSha: null,
        model: null,
        prompt: null,
        interactionType: null,
        ide: null,
        aiChars: 0,
        humanChars: 1,
        changeType: 'ADD',
        newLineNumber: lineNumber,
        oldLineNumber: null,
        codingType: 'TYPING',
    };
}

function isAiTool(tool: string): boolean {
    return AI_TOOLS.has(tool.toLowerCase());
}

function lineCharCount(repoRoot: string, filePath: string, lineNumber: number): number {
    try {
        const abs = path.join(repoRoot, filePath);
        const content = fs.readFileSync(abs, 'utf8');
        const lines = content.split(/\r?\n/);
        if (lineNumber < 1 || lineNumber > lines.length) {
            return 1;
        }
        const len = lines[lineNumber - 1]?.length ?? 0;
        return Math.max(len, 1);
    } catch {
        return 1;
    }
}

function buildLineBlame(
    repoRoot: string,
    filePath: string,
    lineNumber: number,
    row: CliEditRow
): LineBlame {
    const ai = isAiTool(row.tool);
    const chars = lineCharCount(repoRoot, filePath, lineNumber);
    const ts = new Date(Math.floor(row.ts / 1e6)).toISOString();
    return {
        lineNumber,
        authorType: ai ? 'AI' : 'HUMAN',
        provider: ai ? row.tool : null,
        timestamp: ts,
        commitSha: null,
        model: row.model,
        prompt: null,
        interactionType: row.gen_type || null,
        ide: null,
        aiChars: ai ? chars : 0,
        humanChars: ai ? 0 : chars,
        changeType: 'ADD',
        newLineNumber: lineNumber,
        oldLineNumber: null,
        codingType: 'TYPING',
    };
}

/** Newest edit wins per file line (matches oobeya-cli attribution join). */
function editsToBlameMap(repoRoot: string, edits: CliEditRow[]): Map<string, LineBlame[]> {
    const assigned = new Map<string, Map<number, CliEditRow>>();
    const fileLineCounts = new Map<string, number | null>();
    const MAX_LINES_PER_EDIT = 10000; // guard against huge ranges

    function fileLineCount(repoRoot: string, filePath: string): number | null {
        try {
            const abs = path.join(repoRoot, filePath);
            const content = fs.readFileSync(abs, 'utf8');
            return content.split(/\r?\n/).length;
        } catch {
            return null;
        }
    }

    for (const row of edits) {
        const file = row.file_path.replace(/\\/g, '/');
        let byLine = assigned.get(file);
        if (!byLine) {
            byLine = new Map();
            assigned.set(file, byLine);
        }

        let fileLines = fileLineCounts.get(file);
        if (fileLines === undefined) {
            fileLines = fileLineCount(repoRoot, file);
            fileLineCounts.set(file, fileLines);
        }

        const start = Math.max(1, row.start_line ?? 1);
        let end = row.end_line ?? start;

        if (fileLines !== null) {
            end = Math.min(end, fileLines);
        }

        if (end - start + 1 > MAX_LINES_PER_EDIT) {
            end = start + MAX_LINES_PER_EDIT - 1;
        }

        for (let ln = start; ln <= end; ln++) {
            if (!byLine.has(ln)) {
                byLine.set(ln, row);
            }
        }
    }

    const result = new Map<string, LineBlame[]>();
    for (const [file, byLine] of assigned) {
        const entries: LineBlame[] = [];
        for (const [ln, row] of byLine) {
            entries.push(buildLineBlame(repoRoot, file, ln, row));
        }
        entries.sort((a, b) => a.lineNumber - b.lineNumber);
        result.set(file, entries);
    }
    return result;
}

export type CliDataRefreshListener = () => void;

/**
 * Read-only bridge to oobeya-cli runtime data (~/.blamely/db.sqlite).
 * Populates BlameMap for status bar, Changes panel, and gutter decorations.
 */
export class CliDataService implements vscode.Disposable {
    private blameMap: BlameMap;
    private _repoRoot: string | null = null;
    private repoId: string | null = null;

    get repoRoot(): string | null {
        return this._repoRoot;
    }
    private refreshTimer?: NodeJS.Timeout;
    private listeners: CliDataRefreshListener[] = [];
    private lastDaemonStatus: DaemonStatus = { running: false };
    private disposed = false;

    constructor(blameMap: BlameMap) {
        this.blameMap = blameMap;
    }

    onRefresh(listener: CliDataRefreshListener): vscode.Disposable {
        this.listeners.push(listener);
        return new vscode.Disposable(() => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        });
    }

    getDaemonStatus(): DaemonStatus {
        return this.lastDaemonStatus;
    }

    async start(): Promise<void> {
        await this.refresh();
        this.refreshTimer = setInterval(() => void this.refresh(), 2000);
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        try {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                this.blameMap.clear();
                this.notify();
                return;
            }
            const repoRoot = await GitUtils.getRepoRoot(folder.uri.fsPath);
            if (!repoRoot) {
                this.blameMap.clear();
                this.notify();
                return;
            }
            this._repoRoot = repoRoot;
            this.repoId = await getRepoId(repoRoot);
            if (!this.repoId) {
                this.blameMap.clear();
                this.notify();
                return;
            }

            void this.checkDaemonHealth();

            // Session filter: only include AI edits made after the last commit.
            // After commit, sinceNanos advances → pre-commit edits excluded → BlameMap resets to 0.
            const lastCommitOut = await GitUtils.runGitCommand(repoRoot, 'log', '-1', '--format=%ct');
            const sinceNanos = lastCommitOut?.trim() ? Math.floor(parseFloat(lastCommitOut.trim()) * 1e9) : 0;

            // Try the canonical repoId first, then two path-normalization fallbacks
            // so the plugin matches whatever format blamely-cli stored (symlink vs real path).
            let edits = await loadEditsForRepo(this.repoId, sinceNanos);
            if (edits.length === 0) {
                const candidates: string[] = [];
                try { candidates.push(fs.realpathSync(repoRoot)); } catch { /* ignore */ }
                candidates.push(path.normalize(repoRoot).replace(/[/\\]+$/, ''));
                for (const alt of candidates) {
                    if (alt && alt !== this.repoId) {
                        const altEdits = await loadEditsForRepo(alt, sinceNanos);
                        if (altEdits.length > 0) { edits = altEdits; break; }
                    }
                }
            }
            const byFile = editsToBlameMap(repoRoot, edits);

            // Add human LineBlame entries for working-tree lines not attributed to AI.
            // Parsed from git diff --unified=0 HEAD — empty after commit → reset to 0.
            const diffOut = await GitUtils.runGitCommand(repoRoot, 'diff', '--unified=0', 'HEAD');
            const humanLinesByFile = parseHumanLines(diffOut ?? '');
            for (const [filePath, lineNums] of humanLinesByFile) {
                const existing = byFile.get(filePath) ?? [];
                const aiLineSet = new Set(existing.map(e => e.lineNumber));
                const humanEntries = lineNums
                    .filter(ln => !aiLineSet.has(ln))
                    .map(ln => buildHumanLineBlame(ln));
                if (humanEntries.length > 0) {
                    byFile.set(filePath, [...existing, ...humanEntries]);
                }
            }

            // git diff HEAD does not include untracked (new) files. When AI generates
            // a new file via a chat panel and the user then adds more lines, those
            // human-typed lines are invisible to the diff. For each untracked file
            // that has AI attribution in byFile, add human entries for all non-AI lines.
            const untrackedOut = await GitUtils.runGitCommand(repoRoot, 'ls-files', '--others', '--exclude-standard');
            if (untrackedOut) {
                for (const line of untrackedOut.split('\n')) {
                    const filePath = line.trim().replace(/\\/g, '/');
                    if (!filePath || !byFile.has(filePath)) continue;
                    const existing = byFile.get(filePath)!;
                    const aiLineSet = new Set(existing.map(e => e.lineNumber));
                    try {
                        const absPath = path.join(repoRoot, filePath);
                        const content = fs.readFileSync(absPath, 'utf8');
                        const lineCount = content.split(/\r?\n/).length;
                        const humanEntries: LineBlame[] = [];
                        for (let ln = 1; ln <= lineCount; ln++) {
                            if (!aiLineSet.has(ln)) humanEntries.push(buildHumanLineBlame(ln));
                        }
                        if (humanEntries.length > 0) {
                            byFile.set(filePath, [...existing, ...humanEntries]);
                        }
                    } catch { /* skip unreadable files */ }
                }
            }

            this.blameMap.clear();
            for (const [file, entries] of byFile) {
                this.blameMap.setFileBlame(file, entries);
            }
            this.notify();
        } catch (err) {
            Logger.warn(`CliDataService refresh: ${err}`);
        }
    }

    private async checkDaemonHealth(): Promise<void> {
        const health = await checkCliHealth();
        this.lastDaemonStatus = health.daemon ?? { running: false };
    }

    private notify(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* ignore */ }
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.listeners = [];
    }
}

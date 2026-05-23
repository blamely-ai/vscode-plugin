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
    for (const row of edits) {
        const file = row.file_path.replace(/\\/g, '/');
        let byLine = assigned.get(file);
        if (!byLine) {
            byLine = new Map();
            assigned.set(file, byLine);
        }
        for (let ln = row.start_line; ln <= row.end_line; ln++) {
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
    private repoRoot: string | null = null;
    private repoId: string | null = null;
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
            this.repoRoot = repoRoot;
            this.repoId = await getRepoId(repoRoot);
            if (!this.repoId) {
                this.blameMap.clear();
                this.notify();
                return;
            }

            void this.checkDaemonHealth();

            const edits = await loadEditsForRepo(this.repoId);
            const byFile = editsToBlameMap(repoRoot, edits);
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

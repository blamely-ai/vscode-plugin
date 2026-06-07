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
import { normalizePath } from '../utils/Platform';
import { lineSha, pendingMatchesLine } from './pendingMatch';
import { DaemonClient } from '../completion/DaemonClient';

const AI_TOOLS = new Set(['claude', 'cursor', 'codex', 'copilot', 'gemini']);

function normalizedGenType(genType: string | null | undefined): string {
    return (genType ?? '').trim().toLowerCase();
}

function isInlineCompletionType(genType: string | null | undefined): boolean {
    return normalizedGenType(genType) === 'completion';
}

function isAiInteractionType(genType: string | null | undefined): boolean {
    const g = normalizedGenType(genType);
    return g === 'completion' || g === 'chat' || g === 'cli';
}

/** Max line span for in-memory line→edit maps (V8 Map size ~16M entries). */
const MAX_AI_LINE_INDEX_SPAN = 500;

function hasBoundedRange(row: CliEditRow): boolean {
    return row.end_line >= row.start_line && row.end_line - row.start_line <= MAX_AI_LINE_INDEX_SPAN;
}

function isIndexableLineRange(row: CliEditRow): boolean {
    const start = Math.max(1, row.start_line ?? 1);
    const end = row.end_line ?? start;
    return end >= start && end - start <= MAX_AI_LINE_INDEX_SPAN;
}

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
        timestamp: new Date().toISOString(),
        aiChars: 0,
        humanChars: 0,
        changeType: 'ADD',
        codingType: 'TYPING',
    };
}

function isAiTool(tool: string): boolean {
    return AI_TOOLS.has(tool.toLowerCase());
}

function isAiEditRow(row: CliEditRow): boolean {
    return isAiTool(row.tool) || isAiInteractionType(row.gen_type);
}

/**
 * Map repo-relative file → content_sha → newest AI edit row.
 */
function isChatOrCliGenType(genType: string | null | undefined): boolean {
    const g = normalizedGenType(genType);
    return g === 'chat' || g === 'cli';
}

function rowCoversLine(row: CliEditRow, ln: number): boolean {
    const start = Math.max(1, row.start_line ?? 1);
    const end = row.end_line ?? start;
    return ln >= start && ln <= end;
}

function isLineAttributionCandidate(row: CliEditRow): boolean {
    if (!isAiEditRow(row)) return false;
    const g = normalizedGenType(row.gen_type);
    return g === 'chat' || g === 'cli' || (g === 'completion' && hasBoundedRange(row));
}

/**
 * Resolve AI for one git-diff line from SQLite (rows are newest-first).
 * Prefer the newest edit whose content_sha matches current line text so a
 * later whole-file apply does not stamp every line with the last model name.
 */
function resolveAiEditForChangedLine(
    filePath: string,
    ln: number,
    lineText: string,
    edits: CliEditRow[],
): CliEditRow | null {
    const normFile = filePath.replace(/\\/g, '/');
    const hash = lineSha(lineText.replace(/\r$/, ''));

    // content_sha rows keep stale start/end after a middle insert — match by hash only.
    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (row.content_sha && row.content_sha === hash) return row;
    }

    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (row.content_sha) continue;
        if (!rowCoversLine(row, ln)) continue;
        if (!isIndexableLineRange(row)) continue;
        // A single-line record with no sha was a blank line at record time. If the
        // user has since typed here, the line is now human-authored — don't match.
        if (row.start_line === row.end_line && lineText.trim().length > 0) continue;
        return row;
    }
    return null;
}

/**
 * Paint AI on every line whose current text matches a session content_sha, at the
 * line's present position (fixes 138–139 → 140–141 after CLI insert at 103–104).
 */
function applyContentShaAttribution(
    repoRoot: string,
    edits: CliEditRow[],
    filePaths: Iterable<string>,
    byFile: Map<string, LineBlame[]>,
): void {
    const shaByFile = new Map<string, Map<string, CliEditRow>>();
    for (const row of edits) {
        if (!row.content_sha || !isAiEditRow(row)) continue;
        const file = row.file_path.replace(/\\/g, '/');
        let bySha = shaByFile.get(file);
        if (!bySha) {
            bySha = new Map();
            shaByFile.set(file, bySha);
        }
        if (!bySha.has(row.content_sha)) bySha.set(row.content_sha, row);
    }

    for (const filePath of filePaths) {
        const norm = filePath.replace(/\\/g, '/');
        const bySha = shaByFile.get(norm);
        if (!bySha?.size) continue;
        let lines: string[];
        try {
            lines = fs.readFileSync(path.join(repoRoot, norm), 'utf8').split(/\r?\n/);
        } catch {
            continue;
        }
        const entries = [...(byFile.get(norm) ?? [])];
        let mutated = false;
        for (let ln = 1; ln <= lines.length; ln++) {
            const text = lines[ln - 1];
            if (text === undefined) continue;
            const row = bySha.get(lineSha(text.replace(/\r$/, '')));
            if (!row) continue;
            const entry = buildLineBlame(repoRoot, norm, ln, row, { contentShaAttributed: true });
            const idx = entries.findIndex(e => e.lineNumber === ln);
            if (idx >= 0) {
                // A prior range-based pass (editsToBlameMap, e.g. a null-sha blank-line
                // record whose original position now holds shifted AI content) may have
                // placed an AI entry here with contentShaAttributed=false. A verified
                // sha match always wins — promote it even when authorType/model already
                // agree, so downstream content checks (untracked-file loop) see the
                // line as sha-confirmed rather than treating it as an unverified range.
                if (
                    entries[idx].authorType !== 'AI' ||
                    entries[idx].model !== entry.model ||
                    !entries[idx].contentShaAttributed
                ) {
                    entries[idx] = entry;
                    mutated = true;
                }
            } else {
                entries.push(entry);
                mutated = true;
            }
        }
        if (mutated) {
            entries.sort((a, b) => a.lineNumber - b.lineNumber);
            byFile.set(norm, entries);
        }
    }
}

/**
 * For each line in `git diff HEAD`, classify from current file text only:
 * match an AI edit's content_sha → AI; otherwise → Human.
 * (Chat accept then delete/retype must not keep stale AI on the human line.)
 */
function reconcileChangedLinesAttribution(
    repoRoot: string,
    edits: CliEditRow[],
    changedByFile: Map<string, number[]>,
    byFile: Map<string, LineBlame[]>,
    blameMap: BlameMap,
): void {
    for (const [filePath, lineNums] of changedByFile) {
        let lines: string[];
        try {
            lines = fs.readFileSync(path.join(repoRoot, filePath), 'utf8').split(/\r?\n/);
        } catch {
            continue;
        }
        const entries = [...(byFile.get(filePath) ?? [])];
        let mutated = false;
        for (const ln of lineNums) {
            const text = lines[ln - 1];
            if (text === undefined) continue;
            const idx = entries.findIndex(e => e.lineNumber === ln);
            const existing = idx >= 0 ? entries[idx] : undefined;
            const pendingRaw = blameMap.pendingAiLinesFor(filePath).get(ln);
            // Confirm the line still holds the captured AI text — a human line
            // inserted inside the band slides into the frozen pending range and
            // must not be painted AI.
            const pending = pendingRaw && pendingMatchesLine(pendingRaw, text) ? pendingRaw : undefined;

            let aiRow = resolveAiEditForChangedLine(filePath, ln, text, edits);

            let entry: LineBlame;
            if (aiRow) {
                entry = buildLineBlame(repoRoot, filePath, ln, aiRow);
            } else if (pending) {
                entry = {
                    lineNumber: ln,
                    authorType: 'AI',
                    provider: pending.tool ?? undefined,
                    timestamp: new Date().toISOString(),
                    model: pending.model ?? undefined,
                    interactionType: pending.genType ?? 'chat',
                    aiChars: 1,
                    humanChars: 0,
                    changeType: 'ADD',
                    codingType: 'TYPING',
                    boundedAiRange: true,
                };
            } else if (
                existing?.authorType === 'AI' &&
                isAiInteractionType(existing.interactionType) &&
                isChatOrCliGenType(existing.interactionType)
            ) {
                continue;
            } else {
                entry = buildHumanLineBlame(ln);
            }

            if (idx >= 0) {
                if (
                    entries[idx].authorType !== entry.authorType ||
                    entries[idx].provider !== entry.provider
                ) {
                    entries[idx] = entry;
                    mutated = true;
                }
            } else {
                entries.push(entry);
                mutated = true;
            }
        }
        if (mutated) {
            entries.sort((a, b) => a.lineNumber - b.lineNumber);
            byFile.set(filePath, entries);
        }
    }
}

/**
 * Keep only lines that differ from HEAD (or whole untracked files). Drops stale
 * SQLite rows so gutter/status bar/Changes reset after commit.
 *
 * The gutter shows ONLY uncommitted working-tree changes (`git diff HEAD`). A
 * line is kept iff it is in that diff. We must NOT keep content_sha-attributed
 * lines that fall outside the diff: those are ALREADY-COMMITTED AI lines whose
 * text still matches a session content_sha, and keeping them made committed code
 * from an earlier commit linger in the gutter alongside a new uncommitted edit in
 * the same file. A genuinely uncommitted AI line always differs from HEAD, so it
 * is in `changed` already — no exception needed.
 */
function scopeToUncommittedWorkingTree(
    byFile: Map<string, LineBlame[]>,
    changedSets: Map<string, Set<number>>,
    untrackedFiles: Set<string>,
): void {
    for (const [file, entries] of [...byFile.entries()]) {
        if (untrackedFiles.has(file)) continue;
        const changed = changedSets.get(file);
        if (!changed?.size) {
            byFile.delete(file);
            continue;
        }
        byFile.set(
            file,
            entries.filter(
                e => changed.has(e.lineNumber),
            ),
        );
    }
}

/** Register blame under workspace-relative keys so gutter lookup matches SQLite repo paths. */
function expandBlameMapKeys(repoRoot: string, byFile: Map<string, LineBlame[]>): Map<string, LineBlame[]> {
    const out = new Map<string, LineBlame[]>();
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const [repoRel, entries] of byFile) {
        out.set(repoRel, entries);
        const abs = path.join(repoRoot, repoRel);
        for (const folder of folders) {
            const rel = normalizePath(path.relative(folder.uri.fsPath, abs));
            if (!rel || rel.startsWith('..') || rel === repoRel) continue;
            out.set(rel, entries);
            if (folders.length > 1) {
                out.set(normalizePath(`${folder.name}/${rel}`), entries);
            }
        }
    }
    return out;
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
    row: CliEditRow,
    opts?: { contentShaAttributed?: boolean },
): LineBlame {
    const ai = isAiTool(row.tool) || isAiInteractionType(row.gen_type);
    const chars = lineCharCount(repoRoot, filePath, lineNumber);
    const ts = new Date(Math.floor(row.ts / 1e6)).toISOString();
    const boundedAiRange =
        isAiInteractionType(row.gen_type) &&
        hasBoundedRange(row) &&
        (row.end_line - row.start_line <= MAX_AI_LINE_INDEX_SPAN);
    return {
        lineNumber,
        authorType: ai ? 'AI' : 'HUMAN',
        provider: ai ? row.tool : null,
        timestamp: ts,
        commitSha: null,
        model: row.model ?? undefined,
        prompt: null,
        interactionType: row.gen_type || null,
        ide: null,
        aiChars: ai ? chars : 0,
        humanChars: ai ? 0 : chars,
        changeType: 'ADD',
        newLineNumber: lineNumber,
        oldLineNumber: null,
        codingType: 'TYPING',
        boundedAiRange,
        contentShaAttributed: opts?.contentShaAttributed ?? false,
    };
}


/**
 * Build per-file AI line attribution from edit rows.
 *
 * Two kinds of edit lines:
 *  - CONTENT lines (chat applies): carry a per-line content_sha. A current file
 *    line is attributed to that edit only if its content still hashes to the
 *    same value — so lines the human later types inside an AI-applied region are
 *    NOT mis-credited to AI, and attribution survives line-number shifts.
 *  - RANGE lines (inline completions etc.): no content_sha; attributed by line
 *    number as before.
 * Newest edit wins per line (rows arrive newest-first).
 */
function editsToBlameMap(repoRoot: string, edits: CliEditRow[]): Map<string, LineBlame[]> {
    const assigned = new Map<string, Map<number, CliEditRow>>();          // range-based: file → line → edit
    const fileLineCounts = new Map<string, number | null>();
    const MAX_LINES_PER_EDIT = 10000; // guard against huge ranges

    function fileLineCount(repoRoot: string, filePath: string): number | null {
        try {
            return fs.readFileSync(path.join(repoRoot, filePath), 'utf8').split(/\r?\n/).length;
        } catch {
            return null;
        }
    }

    for (const row of edits) {
        const file = row.file_path.replace(/\\/g, '/');

        // Chat/cli with content_sha: line numbers in SQLite drift after edits;
        // classify those lines in reconcileChangedLinesAttribution (git diff only).
        if (
            row.content_sha &&
            isAiInteractionType(row.gen_type) &&
            !isInlineCompletionType(row.gen_type)
        ) {
            continue;
        }

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
        // Inline completions: trust the tight range — file may be unsaved when read.
        if (!isInlineCompletionType(row.gen_type) && fileLines !== null) {
            end = Math.min(end, fileLines);
        }
        if (end - start + 1 > MAX_LINES_PER_EDIT) end = start + MAX_LINES_PER_EDIT - 1;
        for (let ln = start; ln <= end; ln++) {
            if (!byLine.has(ln)) byLine.set(ln, row);
        }
    }

    const result = new Map<string, LineBlame[]>();

    // Range-based files.
    for (const [file, byLine] of assigned) {
        const entries: LineBlame[] = [];
        for (const [ln, row] of byLine) entries.push(buildLineBlame(repoRoot, file, ln, row));
        result.set(file, entries);
    }

    // Content-based attribution runs in reconcileChangedLinesAttribution (git-diff
    // lines only) so human edits after a chat accept are not painted as AI.

    for (const [file, entries] of result) {
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
    private saveListener?: vscode.Disposable;
    private openListener?: vscode.Disposable;
    private activeEditorListener?: vscode.Disposable;
    private workspaceListener?: vscode.Disposable;
    private fsListeners: vscode.Disposable[] = [];
    private readonly daemonClient = new DaemonClient();
    private startupTimers: NodeJS.Timeout[] = [];
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
        // Initial load when the IDE opens (git index / daemon / SQLite may not be ready yet).
        await this.refresh();
        for (const delay of [500, 1500, 4000, 8000, 15000]) {
            this.startupTimers.push(setTimeout(() => void this.refresh(), delay));
        }
        // Save (manual or autosave) flushes buffers so `git diff HEAD` matches disk.
        this.saveListener = vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh());
        // Re-load when editors open or become active (unsaved buffers are flushed in refresh).
        this.openListener = vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.uri.scheme === 'file') this.scheduleRefresh();
        });
        this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh());
        this.workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh());
        this.fsListeners = this.registerFsListeners();
    }

    private registerFsListeners(): vscode.Disposable[] {
        const resolve = async (absPath: string): Promise<{ repoPath: string; relPath: string } | null> => {
            const repoRoot = await GitUtils.getRepoRoot(absPath);
            if (!repoRoot) return null;
            const repoPath = (await getRepoId(repoRoot)) ?? repoRoot;
            const relPath = path.relative(repoRoot, absPath).replace(/\\/g, '/');
            if (!relPath || relPath.startsWith('..')) return null;
            return { repoPath, relPath };
        };

        return [
            // File created or re-created: restore any soft-deleted attribution.
            vscode.workspace.onDidCreateFiles(async (e) => {
                for (const uri of e.files) {
                    const r = await resolve(uri.fsPath);
                    if (!r) continue;
                    await this.daemonClient.sendFsEvent({ kind: 'create', repo_path: r.repoPath, path: r.relPath });
                    Logger.debug(`FsEvent create: ${r.relPath}`);
                }
                this.scheduleRefresh();
            }),

            // File deleted: soft-delete attribution (recoverable on undo).
            vscode.workspace.onDidDeleteFiles(async (e) => {
                for (const uri of e.files) {
                    const r = await resolve(uri.fsPath);
                    if (!r) continue;
                    await this.daemonClient.sendFsEvent({ kind: 'delete', repo_path: r.repoPath, path: r.relPath });
                    Logger.debug(`FsEvent delete: ${r.relPath}`);
                }
                this.scheduleRefresh();
            }),

            // File renamed or moved: update file_path in DB so attribution follows.
            // Copy (duplicate file) appears as onDidCreateFiles; the VS Code API does
            // not expose a native copy event — onDidRenameFiles covers rename + move only.
            vscode.workspace.onDidRenameFiles(async (e) => {
                for (const { oldUri, newUri } of e.files) {
                    const oldRoot = await GitUtils.getRepoRoot(oldUri.fsPath);
                    const newRoot = await GitUtils.getRepoRoot(newUri.fsPath);
                    if (!oldRoot || !newRoot || oldRoot !== newRoot) continue;
                    const repoPath = (await getRepoId(oldRoot)) ?? oldRoot;
                    const oldRel = path.relative(oldRoot, oldUri.fsPath).replace(/\\/g, '/');
                    const newRel = path.relative(newRoot, newUri.fsPath).replace(/\\/g, '/');
                    if (!oldRel || oldRel.startsWith('..') || !newRel || newRel.startsWith('..')) continue;
                    await this.daemonClient.sendFsEvent({
                        kind: 'rename', repo_path: repoPath,
                        old_path: oldRel, new_path: newRel,
                    });
                    Logger.debug(`FsEvent rename: ${oldRel} → ${newRel}`);
                }
                this.scheduleRefresh();
            }),
        ];
    }

    /** Coalesce bursts (Save All, rapid tab switches) into one refresh. */
    scheduleRefresh(): void {
        if (this.disposed) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), 300);
    }

    /**
     * Optimistic AI paint from CompletionDetector — skip a stale in-flight refresh.
     */
    pushImmediateBlame(
        relPath: string,
        startLine: number,
        endLine: number,
        tool: string,
        genType: string,
        lineShas?: Map<number, string>,
    ): void {
        const existing = [...(this.blameMap.getBlame(relPath))];
        const now = new Date().toISOString();
        for (let ln = startLine; ln <= endLine; ln++) {
            const idx = existing.findIndex(e => e.lineNumber === ln);
            const entry: LineBlame = {
                lineNumber: ln,
                authorType: 'AI',
                provider: tool,
                timestamp: now,
                interactionType: genType,
                aiChars: 1,
                humanChars: 0,
                changeType: 'ADD',
                codingType: 'TYPING',
                boundedAiRange: true,
            };
            if (idx >= 0) existing[idx] = entry;
            else existing.push(entry);
        }
        existing.sort((a, b) => a.lineNumber - b.lineNumber);
        this.blameMap.setFileBlame(relPath, existing);
        this.blameMap.lastOptimisticPaintMs = Date.now();
        this.blameMap.markPendingAiLines(relPath, startLine, endLine, tool, null, genType, lineShas);
        this.notify();
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        const refreshStartMs = Date.now();
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

            // Scope by branch-based work session, not a timestamp window. The
            // git-diff-HEAD intersection below narrows these to uncommitted lines,
            // so the gutter resets after commit without a fragile `ts >=` cutoff and
            // survives cherry-pick/squash. Detached HEAD → null → only NULL rows.
            const branchOut = await GitUtils.runGitCommand(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD');
            const branch = branchOut?.trim() ? branchOut.trim() : null;
            const headSha = (await GitUtils.runGitCommand(repoRoot, 'rev-parse', 'HEAD'))?.trim() ?? '';

            // Try the canonical repoId first, then two path-normalization fallbacks
            // so the plugin matches whatever format blamely-cli stored (symlink vs real path).
            let edits = await loadEditsForRepo(this.repoId, branch, headSha, repoRoot);
            if (edits === null) {
                // Read failure (e.g. SQLite momentarily locked by the daemon). Keep
                // the current gutter; do NOT rebuild it as Human.
                return;
            }

            // Flush open/dirty buffers before git diff (critical on IDE reopen).
            await this.saveDirtyDocumentsForFiles(repoRoot, await this.pathsNeedingFlush(repoRoot, edits));

            const byFile = editsToBlameMap(repoRoot, edits);

            // Lines that actually differ from HEAD in the working tree (the '+'
            // side of `git diff --unified=0 HEAD`). Empty after commit.
            const diffOut = await GitUtils.runGitCommand(repoRoot, 'diff', '--unified=0', 'HEAD');
            const changedByFile = parseHumanLines(diffOut ?? '');
            const changedSets = new Map<string, Set<number>>();
            for (const [f, lns] of changedByFile) changedSets.set(f, new Set(lns));

            // Untracked (new) files aren't in `git diff HEAD`; every line is a change.
            const untrackedFiles = new Set<string>();
            const untrackedOut = await GitUtils.runGitCommand(repoRoot, 'ls-files', '--others', '--exclude-standard');
            if (untrackedOut) {
                for (const line of untrackedOut.split('\n')) {
                    const f = line.trim().replace(/\\/g, '/');
                    if (f) untrackedFiles.add(f);
                }
            }

            const affectedFiles = new Set<string>([...changedSets.keys(), ...untrackedFiles]);

            // Re-locate AI lines by content_sha before scoping to git-diff line numbers.
            applyContentShaAttribution(repoRoot, edits, affectedFiles, byFile);

            // Only uncommitted lines vs HEAD (clears gutter/status bar/Changes after commit).
            scopeToUncommittedWorkingTree(byFile, changedSets, untrackedFiles);

            const hasUncommittedWork = changedByFile.size > 0 || untrackedFiles.size > 0;
            if (!hasUncommittedWork) {
                this.blameMap.clearAllPendingAi();
            }

            // Untracked files: trust only tight AI ranges; add human for the rest.
            for (const filePath of untrackedFiles) {
                if (!byFile.has(filePath)) continue;
                const rawExisting = byFile.get(filePath)!.filter(
                    e => e.authorType !== 'AI' || e.boundedAiRange
                );
                try {
                    const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
                    const fileLines = content.split(/\r?\n/);
                    const lineCount = fileLines.length;
                    // Null-sha AI entries (blank at record time) must be re-verified against
                    // current content: if the user has since typed on that line, it is now
                    // human-authored. Sha-verified entries (contentShaAttributed) are already
                    // confirmed by content hash and are kept as-is.
                    const existing = rawExisting.filter(e => {
                        if (e.authorType !== 'AI') return true;
                        if (e.contentShaAttributed) return true;
                        const text = fileLines[e.lineNumber - 1] ?? '';
                        return text.trim().length === 0;
                    });
                    const aiLineSet = new Set(existing.filter(e => e.authorType === 'AI').map(e => e.lineNumber));
                    const humanEntries: LineBlame[] = [];
                    for (let ln = 1; ln <= lineCount; ln++) {
                        if (!aiLineSet.has(ln)) humanEntries.push(buildHumanLineBlame(ln));
                    }
                    byFile.set(filePath, [...existing, ...humanEntries]);
                } catch { /* skip unreadable files */ }
            }

            if (hasUncommittedWork) {
                this.applyPendingAi(byFile);
            }

            // Authoritative per git-diff line (overrides stale range / pending mislabels).
            reconcileChangedLinesAttribution(repoRoot, edits, changedByFile, byFile, this.blameMap);

            // Only skip apply when an optimistic paint happened during THIS refresh
            // (not a stale timestamp from a prior partial run).
            if (
                this.blameMap.lastOptimisticPaintMs > refreshStartMs &&
                Date.now() - this.blameMap.lastOptimisticPaintMs < 500
            ) {
                return;
            }

            this.blameMap.lastOptimisticPaintMs = 0;
            this.blameMap.replaceAll(expandBlameMapKeys(repoRoot, byFile));
            this.notify();
        } catch (err) {
            Logger.warn(`CliDataService refresh: ${err}`);
        }
    }

    private applyPendingAi(byFile: Map<string, LineBlame[]>): void {
        for (const filePath of this.blameMap.pendingAiPaths()) {
            const pending = this.blameMap.pendingAiLinesFor(filePath);
            if (pending.size === 0) continue;
            // Read current text so each pending line can be confirmed against its
            // captured content_sha before being painted AI (skips human inserts).
            let lines: string[] | null = null;
            if (this._repoRoot) {
                try {
                    lines = fs.readFileSync(path.join(this._repoRoot, filePath), 'utf8').split(/\r?\n/);
                } catch {
                    lines = null;
                }
            }
            const entries = [...(byFile.get(filePath) ?? [])];
            let mutated = false;
            for (const [ln, p] of pending) {
                if (p.contentSha && lines) {
                    const text = lines[ln - 1];
                    if (text === undefined || !pendingMatchesLine(p, text)) continue;
                } else if (!p.contentSha && lines) {
                    // No sha was captured — this was a blank line at accept time.
                    // If the user has since typed here, the line is no longer AI.
                    const text = lines[ln - 1];
                    if (text !== undefined && text.trim().length > 0) continue;
                }
                const idx = entries.findIndex(e => e.lineNumber === ln);
                const existing = idx >= 0 ? entries[idx] : undefined;
                if (existing?.authorType === 'AI') {
                    this.blameMap.clearPendingAiLine(filePath, ln);
                    continue;
                }
                const aiEntry: LineBlame = {
                    lineNumber: ln,
                    authorType: 'AI',
                    provider: p.tool ?? undefined,
                    timestamp: new Date().toISOString(),
                    model: p.model ?? undefined,
                    interactionType: p.genType ?? 'completion',
                    aiChars: Math.max(existing?.humanChars ?? 1, 1),
                    humanChars: 0,
                    changeType: 'ADD',
                    codingType: 'TYPING',
                    boundedAiRange: true,
                };
                if (idx >= 0) entries[idx] = aiEntry;
                else entries.push(aiEntry);
                mutated = true;
            }
            if (mutated) {
                entries.sort((a, b) => a.lineNumber - b.lineNumber);
                byFile.set(filePath, entries);
            }
        }
    }

    private async pathsNeedingFlush(
        repoRoot: string,
        edits: CliEditRow[],
    ): Promise<Set<string>> {
        const paths = new Set(edits.map(e => e.file_path.replace(/\\/g, '/')));
        const diffNames = await GitUtils.runGitCommand(repoRoot, 'diff', '--name-only', 'HEAD');
        if (diffNames) {
            for (const line of diffNames.split('\n')) {
                const f = line.trim().replace(/\\/g, '/');
                if (f) paths.add(f);
            }
        }
        const untracked = await GitUtils.runGitCommand(repoRoot, 'ls-files', '--others', '--exclude-standard');
        if (untracked) {
            for (const line of untracked.split('\n')) {
                const f = line.trim().replace(/\\/g, '/');
                if (f) paths.add(f);
            }
        }
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme !== 'file' || doc.isClosed) continue;
            const rel = path.relative(repoRoot, doc.uri.fsPath).replace(/\\/g, '/');
            if (rel && !rel.startsWith('..')) paths.add(rel);
        }
        return paths;
    }

    private async saveDirtyDocumentsForFiles(repoRoot: string, filePaths: Set<string>): Promise<void> {
        if (filePaths.size === 0) return;
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme !== 'file' || doc.isClosed || !doc.isDirty) continue;
            const rel = path.relative(repoRoot, doc.uri.fsPath).replace(/\\/g, '/');
            if (!rel || rel.startsWith('..') || !filePaths.has(rel)) continue;
            try {
                await doc.save();
            } catch {
                // read-only or disposed — refresh will use buffer-less git state
            }
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
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        for (const t of this.startupTimers) clearTimeout(t);
        this.startupTimers = [];
        this.saveListener?.dispose();
        this.openListener?.dispose();
        this.activeEditorListener?.dispose();
        this.workspaceListener?.dispose();
        for (const d of this.fsListeners) d.dispose();
        this.fsListeners = [];
        this.listeners = [];
    }
}

import * as crypto from 'crypto';
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
import { isBlankLine, stripBlankLineBlame } from '../utils/BlankLines';

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
    const text = lineText.replace(/\r$/, '');
    const hash = lineSha(text);

    // content_sha path: prefer exact line-number match so the copy-paste guard
    // doesn't fire for a line that is genuinely at its recorded position.
    // When multiple edits share the same content (e.g. `}`), exact-first prevents
    // a newer edit at line 25 from overshadowing the real edit at line 50.
    let bestRow: CliEditRow | null = null;
    let bestDrift = Infinity;
    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (!row.content_sha || row.content_sha !== hash) continue;
        if (row.start_line === ln) return row;  // exact match: no drift, no copy-paste ambiguity
        const drift = Math.abs((row.start_line ?? ln) - ln);
        if (drift < bestDrift) { bestDrift = drift; bestRow = row; }
    }
    if (bestRow != null) return bestRow;

    // content_sha_norm fallback: an autoformatter reflowed this line's
    // whitespace (reindent, trailing whitespace) after the AI wrote it, so its
    // exact content_sha no longer matches but its whitespace-collapsed
    // content_sha_norm still does.
    const normHash = lineShaNorm(text);
    if (normHash) {
        let bestNormRow: CliEditRow | null = null;
        let bestNormDrift = Infinity;
        for (const row of edits) {
            if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
            if (!isLineAttributionCandidate(row)) continue;
            if (!row.content_sha_norm || row.content_sha_norm !== normHash) continue;
            if (row.start_line === ln) return row;
            const drift = Math.abs((row.start_line ?? ln) - ln);
            if (drift < bestNormDrift) { bestNormDrift = drift; bestNormRow = row; }
        }
        if (bestNormRow != null) return bestNormRow;
    }

    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (row.content_sha) continue;
        if (!rowCoversLine(row, ln)) continue;
        if (!isIndexableLineRange(row)) continue;
        return row;
    }
    return null;
}

// Max line drift for untracked-file fallback. Human insertions/deletions shift AI
// lines; the fallback re-locates them by content SHA within this window.
const MAX_CONTENT_SHA_DRIFT = 200;

/**
 * Two-pass content-SHA attribution:
 *
 * Pass 1 (all files): line-number-first. byLine[N] exists and SHA matches → AI.
 * This prevents a human-added `}` at line 247 from matching the AI row at line 10.
 *
 * Pass 2 (untracked files only): drift fallback. For lines that failed pass 1,
 * look up by content SHA. If found and the original position no longer holds that
 * content (i.e. the line drifted due to an insertion/deletion above it), attribute
 * as AI. If the original is still in place, the current line is a human copy →uman.
 * This handles "press Enter → all AI lines below shift by 1 → show Human" without
 * reintroducing copy-paste false positives.
 */
function applyContentShaAttribution(
    repoRoot: string,
    edits: CliEditRow[],
    filePaths: Iterable<string>,
    byFile: Map<string, LineBlame[]>,
    untrackedFiles?: Set<string>,
): void {
    const lineByFile = new Map<string, Map<number, CliEditRow>>();
    // Store ALL rows per SHA (not just the newest) so the drift lookup can pick
    // the row whose start_line is closest to the current line being evaluated.
    // With only one row per SHA, a newer edit at line 10 would shadow the real
    // edit at line 50, making origStillAtHome fire on the wrong position.
    const shaByFile  = new Map<string, Map<string, CliEditRow[]>>();
    for (const row of edits) {
        if (!row.content_sha || !isAiEditRow(row)) continue;
        const file = row.file_path.replace(/\\/g, '/');
        let byLine = lineByFile.get(file);
        if (!byLine) { byLine = new Map(); lineByFile.set(file, byLine); }
        if (!byLine.has(row.start_line)) byLine.set(row.start_line, row);

        let bySha = shaByFile.get(file);
        if (!bySha) { bySha = new Map(); shaByFile.set(file, bySha); }
        let list = bySha.get(row.content_sha);
        if (!list) { list = []; bySha.set(row.content_sha, list); }
        list.push(row);
    }

    for (const filePath of filePaths) {
        const norm = filePath.replace(/\\/g, '/');
        const byLine = lineByFile.get(norm);
        if (!byLine?.size) continue;
        const isUntracked = untrackedFiles?.has(norm) ?? false;
        const bySha = isUntracked ? shaByFile.get(norm) : undefined;
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
            if (text === undefined || isBlankLine(text)) continue;
            const sha = lineSha(text.replace(/\r$/, ''));

            // Pass 1: exact position + content confirmation.
            const exactRow = byLine.get(ln);
            let row: CliEditRow | undefined;
            if (exactRow && sha === exactRow.content_sha) {
                row = exactRow;
            } else if (exactRow?.content_sha_norm && lineShaNorm(text.replace(/\r$/, '')) === exactRow.content_sha_norm) {
                // Autoformatter reflowed this line's whitespace (reindent,
                // trailing whitespace) after the AI wrote it: exact content_sha
                // no longer matches but content_sha_norm still does.
                row = exactRow;
            } else if (bySha) {
                // Pass 2 (untracked only): drift fallback — line shifted due to a
                // human insertion/deletion above it.
                // Pick the candidate whose start_line is closest to ln: when two AI
                // edits share the same content (e.g. `}`), the closest one is the
                // most likely origin of the drifted line.
                const candidates = bySha.get(sha);
                if (candidates) {
                    let driftRow: CliEditRow | undefined;
                    let closest = Infinity;
                    for (const c of candidates) {
                        const d = Math.abs(ln - c.start_line);
                        if (d < closest) { closest = d; driftRow = c; }
                    }
                    if (driftRow && closest <= MAX_CONTENT_SHA_DRIFT) {
                        // originalStillAtHome: if the recorded position still holds
                        // the same content, this line is a human copy, not a drift.
                        const origIdx = driftRow.start_line - 1;
                        const origStillAtHome =
                            origIdx >= 0 && origIdx < lines.length &&
                            lineSha(lines[origIdx].replace(/\r$/, '')) === sha;
                        if (!origStillAtHome) row = driftRow;
                    }
                }
            }

            if (!row) continue;
            const entry = buildLineBlame(repoRoot, norm, ln, row, { contentShaAttributed: true });
            const idx = entries.findIndex(e => e.lineNumber === ln);
            if (idx >= 0) {
                if (entries[idx].authorType !== 'AI' || entries[idx].model !== entry.model) {
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
            const pending = blameMap.pendingAiLinesFor(filePath).get(ln);

            let aiRow = resolveAiEditForChangedLine(filePath, ln, text, edits);

            // Copy-paste guard: content found at a different line than recorded.
            // If the original position still holds that content, this is a human
            // copy — not the AI line drifting. Clear aiRow so it shows Human.
            // matchedByNorm distinguishes a content_sha_norm drift match (e.g. an
            // autoformatter-reflowed AI line whose shape was duplicated elsewhere)
            // from a content_sha exact drift match, so the guard re-checks the
            // recorded position with the SAME hash that produced the match.
            if (aiRow && (aiRow.start_line ?? ln) !== ln) {
                const lineHash = lineSha(text.replace(/\r$/, ''));
                const lineNormHash = lineShaNorm(text.replace(/\r$/, ''));
                const matchedByNorm = aiRow.content_sha !== lineHash && aiRow.content_sha_norm === lineNormHash;
                const origIdx = (aiRow.start_line ?? 1) - 1;
                const origLine = origIdx >= 0 && origIdx < lines.length ? lines[origIdx].replace(/\r$/, '') : undefined;
                let origStillAtHome = false;
                if (origLine !== undefined) {
                    if (matchedByNorm) {
                        origStillAtHome = !!aiRow.content_sha_norm && lineShaNorm(origLine) === aiRow.content_sha_norm;
                    } else if (aiRow.content_sha) {
                        origStillAtHome = lineSha(origLine) === aiRow.content_sha;
                    }
                }
                if (origStillAtHome) aiRow = null;
            }

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
        // Keep only lines present in the working-tree diff. No || contentShaAttributed
        // here: committed AI lines that are verbatim-unchanged vs HEAD would match via
        // content-SHA but must not show (they're not current changes). Drifted
        // uncommitted lines are safe: a line new since HEAD always appears in
        // `git diff HEAD` so its new position is in the changed set already.
        byFile.set(file, entries.filter(e => changed.has(e.lineNumber)));
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

function lineSha(s: string): string {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Mirrors the CLI's tools.NormalizeLineText: trim + collapse internal whitespace. */
function normalizeLineText(s: string): string {
    return s.trim().split(/\s+/).join(' ');
}

/**
 * sha256 of the whitespace-normalized line text, or '' for blank/whitespace-only
 * lines — mirrors content_sha_norm's record-time convention so blank lines never
 * spuriously match each other. Fallback for content_sha when an autoformatter
 * reflows an AI-written line (reindent, trailing whitespace) after the AI wrote it.
 */
function lineShaNorm(s: string): string {
    const norm = normalizeLineText(s);
    if (norm === '') return '';
    return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
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
    private refreshTimers: NodeJS.Timeout[] = [];
    // True while the initial fast (200ms) refresh is already queued. Prevents
    // burst events from resetting the initial fast refresh — so a 5-second chat
    // apply with 100 change events still shows the gutter update after 200ms, not
    // 5.2 seconds.
    private fastRefreshPending = false;
    // One-shot repaint timers that fire when a detecting window ends.
    private detectingTimers: NodeJS.Timeout[] = [];
    private saveListener?: vscode.Disposable;
    private openListener?: vscode.Disposable;
    private changeListener?: vscode.Disposable;
    private activeEditorListener?: vscode.Disposable;
    private workspaceListener?: vscode.Disposable;
    private fileOpsListener?: vscode.Disposable;
    private fsWatcher?: vscode.FileSystemWatcher;
    private startupTimers: NodeJS.Timeout[] = [];
    private periodicTimer?: NodeJS.Timeout;
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
        // AI agents write via workspace.applyEdit() without saving — catch those changes too.
        this.changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.scheme === 'file') this.scheduleRefresh();
        });
        // Re-load when editors open or become active (unsaved buffers are flushed in refresh).
        this.openListener = vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.uri.scheme === 'file') this.scheduleRefresh();
        });
        this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh());
        this.workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh());
        // Chat "add file" / agent edits create, delete or rename files without a
        // document-change event, so the gutter + status bar would otherwise wait
        // for the 5s safety poll. These VS Code file-operation events fire for
        // applyEdit/explorer ops; refresh promptly so attribution shows at once.
        this.fileOpsListener = vscode.Disposable.from(
            vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
            vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
            vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),
        );
        // Catch on-disk writes an agent makes outside any editor buffer (a chat
        // agent writing a brand-new file directly). The '**/*' watcher respects
        // files.watcherExclude (node_modules/.git/build dirs), and scheduleRefresh
        // debounces bursts, so this stays cheap.
        this.fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.fsWatcher.onDidCreate(() => this.scheduleRefresh());
        this.fsWatcher.onDidChange(() => this.scheduleRefresh());
        this.fsWatcher.onDidDelete(() => this.scheduleRefresh());
        // Safety-net poll: anything the events above miss surfaces within 5s.
        this.periodicTimer = setInterval(() => void this.refresh(), 5000);
    }

    /** Coalesce bursts into one fast refresh, then retry for late-arriving data. */
    scheduleRefresh(): void {
        if (this.disposed) return;

        // Fire the first (fast) refresh immediately unless one is already queued.
        // Do NOT reset this timer on repeated events — that is what causes a
        // 5-second chat apply (many change events) to delay the gutter update by
        // 5+ seconds instead of 200ms.
        if (!this.fastRefreshPending) {
            this.fastRefreshPending = true;
            this.refreshTimers.push(setTimeout(() => {
                this.fastRefreshPending = false;
                void this.refresh();
            }, 200));
        }

        // Always reset the retry tail from "now" (the end of the current edit
        // burst) so late-arriving watcher edits are still picked up even though
        // the fast refresh fired before the DB was updated.
        //
        // The tail must outlast the DAEMON's recording lag, not just the plugin's.
        // A Copilot chat apply paints text in the editor (the change events that
        // drive this schedule) SECONDS before Copilot finalizes its chat JSONL —
        // and only then does the daemon's chat watcher poll and record the edit.
        // With a short [1200, 3500] tail, all retries fire before the daemon
        // writes, so the gutter waits for the 5s safety poll (the "~5s delay").
        // These points keep refreshing for ~8s after editing stops, so the gutter
        // updates within ~1s of whenever the daemon records.
        const retryTimers = this.refreshTimers.filter((_, i) => i > 0);
        for (const t of retryTimers) clearTimeout(t);
        this.refreshTimers = this.refreshTimers.slice(0, 1);  // keep fast timer only
        for (const delay of [1000, 2000, 3200, 4500, 6000, 8000]) {
            this.refreshTimers.push(setTimeout(() => void this.refresh(), delay));
        }
    }

    /**
     * Mark lines as "detecting" (neutral gutter icon) while an AI-likely insert
     * awaits attribution, so the gutter doesn't default to Human and then flip to
     * AI. Paints immediately, then schedules one repaint at the detecting window's
     * end so a line that never resolved to AI falls back to Human.
     */
    markDetecting(relPath: string, startLine: number, endLine: number): void {
        if (this.disposed) return;
        this.blameMap.markDetecting(relPath, startLine, endLine);
        this.notify();
        const t = setTimeout(() => {
            if (!this.disposed) this.notify();
        }, 8200);
        this.detectingTimers.push(t);
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
        this.blameMap.markPendingAiLines(relPath, startLine, endLine, tool, null, genType);
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
            applyContentShaAttribution(repoRoot, edits, affectedFiles, byFile, untrackedFiles);

            // Only uncommitted lines vs HEAD (clears gutter/status bar/Changes after commit).
            scopeToUncommittedWorkingTree(byFile, changedSets, untrackedFiles);

            const hasUncommittedWork = changedByFile.size > 0 || untrackedFiles.size > 0;
            if (!hasUncommittedWork) {
                this.blameMap.clearAllPendingAi();
            }

            // Untracked files: trust only tight AI ranges; add human for the rest.
            for (const filePath of untrackedFiles) {
                if (!byFile.has(filePath)) continue;
                const existing = byFile.get(filePath)!.filter(
                    e => e.authorType !== 'AI' || e.boundedAiRange
                );
                const aiLineSet = new Set(existing.filter(e => e.authorType === 'AI').map(e => e.lineNumber));
                try {
                    const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
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
            // Drop blame for working-tree-blank lines BEFORE populating the map, so
            // the status-bar summary and the gutter agree: the gutter skips blank
            // lines visually (BlameDecorations), but getSummary has no document text
            // and would otherwise count their entries. Keeping the map blank-free is
            // the single source of truth for both.
            const deblanked = stripBlankLineBlame(repoRoot, byFile);
            this.blameMap.replaceAll(expandBlameMapKeys(repoRoot, deblanked));
            this.notify();
        } catch (err) {
            Logger.warn(`CliDataService refresh: ${err}`);
        }
    }

    private applyPendingAi(byFile: Map<string, LineBlame[]>): void {
        for (const filePath of this.blameMap.pendingAiPaths()) {
            const pending = this.blameMap.pendingAiLinesFor(filePath);
            if (pending.size === 0) continue;
            const entries = [...(byFile.get(filePath) ?? [])];
            let mutated = false;
            for (const [ln, p] of pending) {
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
        this.fastRefreshPending = false;
        for (const t of this.refreshTimers) clearTimeout(t);
        this.refreshTimers = [];
        for (const t of this.detectingTimers) clearTimeout(t);
        this.detectingTimers = [];
        if (this.periodicTimer) clearInterval(this.periodicTimer);
        for (const t of this.startupTimers) clearTimeout(t);
        this.startupTimers = [];
        this.saveListener?.dispose();
        this.changeListener?.dispose();
        this.openListener?.dispose();
        this.activeEditorListener?.dispose();
        this.workspaceListener?.dispose();
        this.fileOpsListener?.dispose();
        this.fsWatcher?.dispose();
        this.listeners = [];
    }
}

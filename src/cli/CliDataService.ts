import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BlameMap, LineBlame, DETECTING_TTL_MS } from '../blame/BlameMap';
import { loadEditsForRepo } from './SqliteReader';
import { getRepoId } from './repoId';
import { checkCliHealth } from './CliHealth';
import { CliEditRow, DaemonStatus } from './types';
import * as GitUtils from '../git/GitUtils';
import { attributionV2Enabled } from '../authorship/WorkingLogTracker';
import { WorkingLogJson, toLineBlame } from '../authorship/workingLogBlame';
import { installedBinaryPath } from './paths';
import { blameFileKey } from '../utils/WorkspacePaths';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsyncCli = promisify(execFile);
import * as Logger from '../utils/Logger';
import { normalizePath } from '../utils/Platform';
import { isBlankLine, stripBlankLineBlame } from '../utils/BlankLines';

/**
 * Render a child_process.execFile rejection with the fields that explain WHY it failed
 * — `${err}` alone yields only "Command failed: <cmd>", which can't distinguish a
 * timeout-kill from a non-zero exit. A timeout sets `killed`/`signal`; a real failure
 * sets a numeric `code` and usually `stderr`.
 */
function describeExecError(err: unknown): string {
    const e = err as { message?: string; killed?: boolean; signal?: string; code?: number | string; stderr?: string } | null;
    if (!e || typeof e !== 'object') return String(err);
    const parts: string[] = [];
    if (e.killed) {
        parts.push(`TIMED OUT (killed${e.signal ? `, signal=${e.signal}` : ''})`);
    } else if (typeof e.code === 'number') {
        parts.push(`exit code ${e.code}`);
    } else if (e.code) {
        parts.push(`spawn error ${e.code}`);
    }
    const stderr = (e.stderr ?? '').toString().trim();
    if (stderr) parts.push(`stderr: ${stderr.slice(0, 500)}`);
    const base = e.message ?? String(err);
    return parts.length ? `${base} — ${parts.join(' · ')}` : base;
}

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
 *
 * Content-aware: a `+` line that is byte-identical to its positionally-paired
 * `-` line is NOT counted as changed. git emits such a pair when a line gains or
 * loses its trailing newline — the "\ No newline at end of file" transition that
 * happens when you append a line after a file whose last line had no newline.
 * Without this, that unchanged last line got a (Human) gutter icon the moment you
 * pressed Enter, even though you never touched it.
 */
function parseHumanLines(diffOutput: string): Map<string, number[]> {
    const result = new Map<string, number[]>();
    let currentFile: string | null = null;

    // Per-hunk buffers. With --unified=0 git emits all `-` lines then all `+`
    // lines for a hunk, so they pair positionally: dels[i] ↔ adds[i].
    let dels: string[] = [];
    let adds: Array<{ line: number; content: string }> = [];
    let addLine = 0;

    const stripCR = (s: string) => s.replace(/\r$/, '');

    const flushHunk = () => {
        if (currentFile) {
            const lines = result.get(currentFile)!;
            const n = Math.min(dels.length, adds.length);
            for (let i = 0; i < adds.length; i++) {
                // Drop a `+` line identical to its paired `-` line (newline-only change).
                if (i < n && stripCR(adds[i].content) === stripCR(dels[i])) continue;
                if (adds[i].line > 0) lines.push(adds[i].line);
            }
        }
        dels = [];
        adds = [];
    };

    for (const line of diffOutput.split('\n')) {
        if (line.startsWith('+++ b/')) {
            flushHunk();
            currentFile = line.slice(6).replace(/\\/g, '/').trim();
            if (!result.has(currentFile)) result.set(currentFile, []);
        } else if (line.startsWith('+++ /dev/null')) {
            flushHunk();
            currentFile = null; // deleted file — no added lines
        } else if (line.startsWith('@@ ') && currentFile) {
            flushHunk();
            const m = /\+(\d+)(?:,(\d+))?/.exec(line);
            addLine = m ? parseInt(m[1]) : 0;
        } else if (currentFile) {
            if (line.startsWith('\\')) {
                continue; // "\ No newline at end of file" — not a content line
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                dels.push(line.slice(1));
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
                adds.push({ line: addLine, content: line.slice(1) });
                addLine++;
            }
        }
    }
    flushHunk();
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

// Per-edit occurrence budget. When the SAME content was recorded by several edits
// (e.g. a chat that wrote 5 identical lines and a later completion that wrote 1),
// each committed copy must be distributed across those edits by recorded count —
// otherwise the nearest/newest edit claims them all and the gutter mislabels them
// (chat lines shown as completion). Keyed `${editId}:s:${sha}` / `:n:${norm}`.
// Mirrors the daemon's pickDriftEdit so the gutter agrees with the commit report.
type Budget = { recorded: Map<string, number>; consumed: Map<string, number> };

function shaKey(id: number, sha: string): string { return `${id}:s:${sha}`; }
function normKey(id: number, norm: string): string { return `${id}:n:${norm}`; }
function budgetLeft(b: Budget, key: string): boolean {
    return (b.consumed.get(key) ?? 0) < (b.recorded.get(key) ?? 0);
}
function consumeBudget(b: Budget, key: string): void {
    b.consumed.set(key, (b.consumed.get(key) ?? 0) + 1);
}

/** Build the per-edit recorded-occurrence budget for one file's attribution candidates. */
function buildBudget(normFile: string, edits: CliEditRow[]): Budget {
    const recorded = new Map<string, number>();
    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (row.content_sha) recorded.set(shaKey(row.id, row.content_sha), (recorded.get(shaKey(row.id, row.content_sha)) ?? 0) + 1);
        if (row.content_sha_norm) recorded.set(normKey(row.id, row.content_sha_norm), (recorded.get(normKey(row.id, row.content_sha_norm)) ?? 0) + 1);
    }
    return { recorded, consumed: new Map() };
}

/** An AI edit that recorded THIS content at THIS exact line. Consumes one occurrence. */
function pickExactAiEdit(filePath: string, ln: number, lineText: string, edits: CliEditRow[], b: Budget): CliEditRow | null {
    const normFile = filePath.replace(/\\/g, '/');
    const text = lineText.replace(/\r$/, '');
    const hash = lineSha(text);
    const normHash = lineShaNorm(text);
    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (row.start_line !== ln) continue;
        if (row.content_sha && row.content_sha === hash) { consumeBudget(b, shaKey(row.id, hash)); return row; }
        if (normHash && row.content_sha_norm && row.content_sha_norm === normHash) { consumeBudget(b, normKey(row.id, normHash)); return row; }
    }
    return null;
}

/**
 * An AI edit whose content matches this line but at a DIFFERENT position (drift).
 * Prefers an edit that still has an unconsumed occurrence (nearest among those),
 * so identical content distributes across the edits that recorded it; falls back
 * to the nearest match overall when every budget is spent (line still attributed).
 *
 * Returns `budgeted: true` when the match consumed a real, unconsumed recorded
 * occurrence — i.e. the AI genuinely wrote this many copies of the content — and
 * `budgeted: false` when every occurrence was already spent and we fell back to
 * the nearest match (a candidate for the copy-paste guard). Range-only matches
 * (no content_sha) report `budgeted: true` since they're covered by range, not
 * by a content budget the guard reasons about.
 */
function pickDriftAiEdit(filePath: string, ln: number, lineText: string, edits: CliEditRow[], b: Budget): { row: CliEditRow; budgeted: boolean } | null {
    const normFile = filePath.replace(/\\/g, '/');
    const text = lineText.replace(/\r$/, '');
    const hash = lineSha(text);

    let best: CliEditRow | null = null, bestDrift = Infinity;
    let budgeted: CliEditRow | null = null, budgetedDrift = Infinity;
    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (!row.content_sha || row.content_sha !== hash) continue;
        const drift = Math.abs((row.start_line ?? ln) - ln);
        if (drift < bestDrift) { bestDrift = drift; best = row; }
        if (budgetLeft(b, shaKey(row.id, hash)) && drift < budgetedDrift) { budgetedDrift = drift; budgeted = row; }
    }
    if (budgeted) { consumeBudget(b, shaKey(budgeted.id, hash)); return { row: budgeted, budgeted: true }; }
    if (best) { consumeBudget(b, shaKey(best.id, hash)); return { row: best, budgeted: false }; }

    const normHash = lineShaNorm(text);
    if (normHash) {
        let bn: CliEditRow | null = null, bnDrift = Infinity;
        let bnBudgeted: CliEditRow | null = null, bnBudgetedDrift = Infinity;
        for (const row of edits) {
            if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
            if (!isLineAttributionCandidate(row)) continue;
            if (!row.content_sha_norm || row.content_sha_norm !== normHash) continue;
            const drift = Math.abs((row.start_line ?? ln) - ln);
            if (drift < bnDrift) { bnDrift = drift; bn = row; }
            if (budgetLeft(b, normKey(row.id, normHash)) && drift < bnBudgetedDrift) { bnBudgetedDrift = drift; bnBudgeted = row; }
        }
        if (bnBudgeted) { consumeBudget(b, normKey(bnBudgeted.id, normHash)); return { row: bnBudgeted, budgeted: true }; }
        if (bn) { consumeBudget(b, normKey(bn.id, normHash)); return { row: bn, budgeted: false }; }
    }

    // Range-only edits (no content_sha) cover a line by range — no content budget.
    for (const row of edits) {
        if (row.file_path.replace(/\\/g, '/') !== normFile) continue;
        if (!isLineAttributionCandidate(row)) continue;
        if (row.content_sha) continue;
        if (!rowCoversLine(row, ln)) continue;
        if (!isIndexableLineRange(row)) continue;
        return { row, budgeted: true };
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
export function applyContentShaAttribution(
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
        // Per-content occurrence budget: how many times each content_sha has been
        // attributed so far (exact + drift). The AI recorded a fixed number of
        // copies of a given line; while that budget lasts, a shifted duplicate is a
        // REAL drifted AI line, so the copy-paste guard must not reject it. Only
        // copies BEYOND the recorded count are human copies. Without this, a run of
        // identical AI lines partly shifted by a human insert (e.g. 5 lines pushed
        // down 2) splits into AI + Human — disagreeing with the commit note.
        const shaConsumed = new Map<string, number>();
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
                shaConsumed.set(sha, (shaConsumed.get(sha) ?? 0) + 1);
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
                        const used = shaConsumed.get(sha) ?? 0;
                        if (used < candidates.length) {
                            // A genuine recorded occurrence, just shifted — attribute
                            // it and skip the copy-paste guard (which would wrongly
                            // reject a real duplicate whose recorded home still holds
                            // an AI copy).
                            row = driftRow;
                            shaConsumed.set(sha, used + 1);
                        } else {
                            // Budget exhausted: this is a copy beyond what the AI
                            // recorded. If the recorded position still holds the
                            // content, it's a human copy, not a drift → leave Human.
                            const origIdx = driftRow.start_line - 1;
                            const origStillAtHome =
                                origIdx >= 0 && origIdx < lines.length &&
                                lineSha(lines[origIdx].replace(/\r$/, '')) === sha;
                            if (!origStillAtHome) {
                                row = driftRow;
                                shaConsumed.set(sha, used + 1);
                            }
                        }
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
export function reconcileChangedLinesAttribution(
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

        // Resolve AI attribution with a per-edit occurrence budget so identical
        // content recorded by several edits is distributed by recorded count
        // (matching the commit report) instead of all going to the nearest edit.
        const budget = buildBudget(filePath.replace(/\\/g, '/'), edits);
        const chosen = new Map<number, CliEditRow | null>();
        // Pass 1: exact-position matches — unambiguous, and they consume their
        // occurrence so a drifted duplicate can't steal it in pass 2.
        for (const ln of lineNums) {
            const text = lines[ln - 1];
            if (text === undefined) continue;
            const row = pickExactAiEdit(filePath, ln, text, edits, budget);
            if (row) chosen.set(ln, row);
        }
        // Pass 2: drifted lines — budgeted nearest match, then the copy-paste guard.
        for (const ln of lineNums) {
            if (chosen.has(ln)) continue;
            const text = lines[ln - 1];
            if (text === undefined) continue;
            const drift = pickDriftAiEdit(filePath, ln, text, edits, budget);
            let aiRow = drift?.row ?? null;

            // Copy-paste guard: content found at a different line than recorded.
            // If the original position still holds that content, this is a human
            // copy — not the AI line drifting. Clear aiRow so it shows Human.
            //
            // Skip the guard when the match was a BUDGETED occurrence: the AI
            // genuinely recorded this many copies of the content (e.g. it wrote 5
            // identical lines), so a duplicate that shifted is a real AI line, not
            // a human copy. Firing the guard there splits a run of identical AI
            // lines into AI+Human and disagrees with the commit note (which rations
            // the same drift budget). The guard is only for copies BEYOND the
            // recorded count — when every occurrence is spent and we fell back to
            // the nearest match (drift.budgeted === false).
            // matchedByNorm distinguishes a content_sha_norm drift match (e.g. an
            // autoformatter-reflowed AI line whose shape was duplicated elsewhere)
            // from a content_sha exact drift match, so the guard re-checks the
            // recorded position with the SAME hash that produced the match.
            if (aiRow && drift && !drift.budgeted && (aiRow.start_line ?? ln) !== ln) {
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
            chosen.set(ln, aiRow);
        }

        for (const ln of lineNums) {
            const text = lines[ln - 1];
            if (text === undefined) continue;
            const idx = entries.findIndex(e => e.lineNumber === ln);
            const existing = idx >= 0 ? entries[idx] : undefined;
            const pending = blameMap.pendingAiLinesFor(filePath).get(ln);

            const aiRow = chosen.get(ln) ?? null;

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

/** The working tree's diff-vs-HEAD state for one repo: which lines changed per
 *  file, and which files are untracked. Used to scope both the v1 (SQLite) and v2
 *  (working-log) blame maps down to only the current uncommitted changes. */
export interface WorkingTreeState {
    /** repo-relative path -> '+'-side line numbers that differ from HEAD. */
    changedSets: Map<string, Set<number>>;
    /** repo-relative untracked-not-ignored paths (all lines are changes). */
    untrackedFiles: Set<string>;
}

/**
 * Resolve a repo's uncommitted-vs-HEAD state with one `git diff --unified=0 HEAD`
 * and one `git ls-files --others --exclude-standard`. Shared by the v1 refreshRepo
 * scan and the v2 refreshV2 scan so both scope identically. On an unborn HEAD the
 * diff fails and yields empty changed sets; every file is untracked, so the
 * untracked pass keeps new files fully visible.
 */
export async function collectWorkingTreeState(repoRoot: string): Promise<WorkingTreeState> {
    const diffOut = await GitUtils.runGitCommand(repoRoot, 'diff', '--unified=0', 'HEAD');
    const changedByFile = parseHumanLines(diffOut ?? '');
    const changedSets = new Map<string, Set<number>>();
    for (const [f, lns] of changedByFile) changedSets.set(f, new Set(lns));

    const untrackedFiles = new Set<string>();
    const untrackedOut = await GitUtils.runGitCommand(repoRoot, 'ls-files', '--others', '--exclude-standard');
    if (untrackedOut) {
        for (const line of untrackedOut.split('\n')) {
            const f = line.trim().replace(/\\/g, '/');
            if (f) untrackedFiles.add(f);
        }
    }
    return { changedSets, untrackedFiles };
}

/**
 * Keep only lines that differ from HEAD (or whole untracked files). Drops stale
 * SQLite rows so gutter/status bar/Changes reset after commit.
 */
export function scopeToUncommittedWorkingTree(
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
    const MAX_END_LINE = 50000; // absolute end-line clamp, same as the IntelliJ plugin's hardMax

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
        end = Math.min(end, MAX_END_LINE);
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

    get repoRoot(): string | null {
        return this._repoRoot;
    }
    private refreshTimers: NodeJS.Timeout[] = [];
    // Serializes refresh(): true while one refresh is running, so overlapping
    // triggers (the 5s periodic tick + editor/file/workspace events) don't each
    // spawn their own `blamely authorship` child processes. Without this the CLI
    // processes pile up on Windows — where a single refresh can outlast the 5s
    // interval — and all contend, slowing each other (a feedback loop).
    private refreshing = false;
    private refreshPending = false;
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
    private visibleEditorsListener?: vscode.Disposable;
    private workspaceListener?: vscode.Disposable;
    private fileOpsListener?: vscode.Disposable;
    private fsWatcher?: vscode.FileSystemWatcher;
    // Event-driven triggers that replace the per-edit retry ladder: a watcher on
    // each repo's working-log dir fires WHEN the daemon/hook actually writes the
    // attribution (the real "data ready" signal), and one on .git/HEAD catches
    // commits / branch switches. With these, a refresh happens once when data
    // lands instead of blind-polling 7× after every keystroke.
    private dataWatchers: vscode.FileSystemWatcher[] = [];
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
        // A short ladder only to cover the daemon coming up AFTER the IDE; steady
        // state is event-driven (the data + HEAD watchers below), not polled.
        for (const delay of [800, 3000]) {
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
        // refreshV2 fetches authorship for every VISIBLE editor, so a split/peek that
        // makes a new editor visible without changing the active one must refresh too
        // (this used to be covered by GutterV2). BlameDecorations repaints on the same
        // event; this provides the data it paints.
        this.visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh());
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
        // The precise "attribution is ready" signal: watch each repo's working-log
        // dir (written by the daemon/hooks) and .git/HEAD. These let us drop the
        // per-edit retry ladder — the refresh fires when the data actually lands.
        await this.setupDataWatchers();
        // Safety-net poll only — a coarse backstop for events the watchers miss
        // (bursts, remote/`.git` watch gaps), not the primary mechanism. 30s, not
        // 5s, because the watchers now carry steady-state freshness.
        this.periodicTimer = setInterval(() => void this.refresh(), 30000);
    }

    /** Watch each repo's working-log directory (the daemon/hooks write attribution
     *  there) and .git/HEAD, so a refresh fires when data is actually ready rather
     *  than blind-polling after every edit. Explicit RelativePattern watchers see
     *  paths inside .git that the default '**\/*' watcher excludes. */
    private async setupDataWatchers(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const seen = new Set<string>();
        for (const folder of folders) {
            const root = await GitUtils.getRepoRoot(folder.uri.fsPath);
            if (!root) continue;
            const norm = path.normalize(root);
            if (seen.has(norm)) continue;
            seen.add(norm);
            // Working logs land under <repo>/.git/blamely/working_logs/<branch>/<base>/…
            const logs = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(root, '.git/blamely/working_logs/**'),
            );
            logs.onDidCreate(() => this.scheduleRefresh());
            logs.onDidChange(() => this.scheduleRefresh());
            logs.onDidDelete(() => this.scheduleRefresh());
            // HEAD moves on commit / checkout / branch switch.
            const head = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(root, '.git/HEAD'),
            );
            head.onDidChange(() => this.scheduleRefresh());
            head.onDidCreate(() => this.scheduleRefresh());
            this.dataWatchers.push(logs, head);
        }
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

        // One short cushion only. The daemon's recording lag (a chat apply paints
        // the editor SECONDS before the daemon finalizes and writes the working
        // log) used to require a 6-step [1000..8000] tail of blind polls. Now the
        // working-log watcher (setupDataWatchers) fires a refresh WHEN the daemon
        // writes, so the long tail is gone — this single retry just smooths over
        // watcher latency / the rare missed event before the 30s backstop.
        const retryTimers = this.refreshTimers.filter((_, i) => i > 0);
        for (const t of retryTimers) clearTimeout(t);
        this.refreshTimers = this.refreshTimers.slice(0, 1);  // keep fast timer only
        this.refreshTimers.push(setTimeout(() => void this.refresh(), 2000));
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
        // Fire just after the detecting TTL expires so the pruned state repaints.
        const t = setTimeout(() => {
            if (!this.disposed) this.notify();
        }, DETECTING_TTL_MS + 200);
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
        // Attribution v2 owns the gutter (BlameDecorations paints from the working
        // log via the BlameMap); this v1 optimistic paint would fight it, so skip
        // when v2 is on.
        if (attributionV2Enabled()) return;
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

    /** Attribution v2 repo-wide refresh: rebuild the whole BlameMap from every
     *  tracked file's working log (`blamely authorship --all`) so the gutter, status
     *  bar, and sidebar all derive from the same v2 source. */
    private async refreshV2(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const bin = installedBinaryPath();
        if (folders.length === 0 || !fs.existsSync(bin)) {
            this.notify();
            return;
        }
        const seen = new Set<string>();
        const repoRoots: string[] = [];
        for (const folder of folders) {
            const root = await GitUtils.getRepoRoot(folder.uri.fsPath);
            if (!root) continue;
            const norm = path.normalize(root);
            if (seen.has(norm)) continue;
            seen.add(norm);
            repoRoots.push(root);
        }
        const merged = new Map<string, LineBlame[]>();
        // Per-repo working-tree state, cached so the visible-editor pass reuses it.
        const repoStates = new Map<string, WorkingTreeState>();
        // Tracked working logs across the repo (sidebar aggregate). Scope each repo's
        // logs to its uncommitted-vs-HEAD changes BEFORE key conversion — a working
        // log orphaned under an old branch/base (e.g. after `checkout -b` + commit on
        // another branch) describes lines now identical to HEAD, so it must not paint.
        // This mirrors the v1 refreshRepo safety net that refreshV2 previously lacked.
        for (const repoRoot of repoRoots) {
            const [state, wls] = await Promise.all([
                collectWorkingTreeState(repoRoot),
                this.fetchAllWorkingLogs(bin, repoRoot),
            ]);
            repoStates.set(path.normalize(repoRoot), state);
            const byFile = new Map<string, LineBlame[]>();
            for (const wl of wls) {
                if (!wl.file) continue;
                byFile.set(wl.file.replace(/\\/g, '/'), toLineBlame(wl));
            }
            scopeToUncommittedWorkingTree(byFile, state.changedSets, state.untrackedFiles);
            for (const [rel, entries] of byFile) {
                merged.set(blameFileKey(vscode.Uri.file(path.join(repoRoot, rel))), entries);
            }
        }
        // Visible editors: seed COMMITTED + uncommitted authorship from the single-file
        // `authorship` (it seeds from the commit notes when there's no working log),
        // overriding the --all entry. Without this, a just-committed file — whose
        // working log isn't re-keyed to the new HEAD yet — shows an empty gutter
        // ("only the current change"); seeding restores the committed history.
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.uri.scheme !== 'file') continue;
            const wl = await this.fetchAuthorship(bin, ed.document.uri.fsPath);
            if (!wl) continue;
            merged.set(blameFileKey(ed.document.uri), this.scopeVisibleEditor(ed.document.uri.fsPath, wl, repoRoots, repoStates));
        }
        this.blameMap.replaceAll(merged);
        this.notify();
    }

    /** Scope one visible editor's authorship to its repo's uncommitted-vs-HEAD state,
     *  so a file that's clean vs HEAD paints nothing even if the CLI returned a log.
     *  Falls back to the unscoped conversion when the file's repo wasn't discovered
     *  (nested repo outside the workspace folders) — never worse than before. */
    private scopeVisibleEditor(
        fsPath: string,
        wl: WorkingLogJson,
        repoRoots: string[],
        repoStates: Map<string, WorkingTreeState>,
    ): LineBlame[] {
        const entries = toLineBlame(wl);
        // Longest-prefix match: the repo whose root is the deepest ancestor of fsPath.
        let bestRoot: string | null = null;
        for (const root of repoRoots) {
            if ((fsPath === root || fsPath.startsWith(root + path.sep)) &&
                (bestRoot === null || root.length > bestRoot.length)) {
                bestRoot = root;
            }
        }
        if (!bestRoot) return entries;
        const state = repoStates.get(path.normalize(bestRoot));
        if (!state) return entries;
        const rel = path.relative(bestRoot, fsPath).replace(/\\/g, '/');
        const byFile = new Map<string, LineBlame[]>([[rel, entries]]);
        scopeToUncommittedWorkingTree(byFile, state.changedSets, state.untrackedFiles);
        return byFile.get(rel) ?? [];
    }

    /** Single-file v2 authorship (committed + uncommitted), which SEEDS from the
     *  commit notes when the file has no working log — used to keep committed history
     *  in the gutter for visible editors. */
    private async fetchAuthorship(bin: string, fsPath: string): Promise<WorkingLogJson | null> {
        try {
            const { stdout } = await execFileAsyncCli(bin, ['authorship', fsPath], {
                env: { ...process.env },
                // First seed of a file runs `git blame` + note reads; on Windows/large
                // history that can take several seconds. 20s avoids killing it mid-seed
                // (subsequent calls are fast once the working log is cached).
                timeout: 20000,
                maxBuffer: 8 * 1024 * 1024,
            });
            const trimmed = stdout.trim();
            if (!trimmed) return null;
            return JSON.parse(trimmed) as WorkingLogJson;
        } catch (err) {
            Logger.warn(`CliDataService: authorship (single) failed for ${fsPath}: ${describeExecError(err)}`);
            return null;
        }
    }

    private async fetchAllWorkingLogs(bin: string, repoRoot: string): Promise<WorkingLogJson[]> {
        try {
            const { stdout } = await execFileAsyncCli(bin, ['authorship', repoRoot, '--all'], {
                env: { ...process.env },
                timeout: 15000,
                maxBuffer: 32 * 1024 * 1024,
            });
            const trimmed = stdout.trim();
            if (!trimmed) return [];
            const parsed = JSON.parse(trimmed) as { files?: WorkingLogJson[] };
            return parsed.files ?? [];
        } catch (err) {
            Logger.warn(`CliDataService: authorship --all failed: ${describeExecError(err)}`);
            return [];
        }
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        // Run at most one refresh at a time. Each refresh spawns `blamely authorship`
        // child processes; on Windows one refresh can outlast the 5s periodic tick, so
        // without this guard the ticks overlap and the CLI processes pile up (observed
        // as many concurrent blamely.exe), all contending and slowing each other. If
        // more refreshes are requested while one runs, do exactly one more pass after
        // so the latest state is still picked up.
        if (this.refreshing) {
            this.refreshPending = true;
            return;
        }
        this.refreshing = true;
        try {
            do {
                this.refreshPending = false;
                await this.refreshOnce();
            } while (this.refreshPending && !this.disposed);
        } finally {
            this.refreshing = false;
        }
    }

    private async refreshOnce(): Promise<void> {
        if (this.disposed) return;
        // Attribution v2 owns the gutter/status bar/sidebar — populate the map
        // repo-wide from the working logs (one v2 source, I4) instead of the v1
        // SQLite scan. This both fixes the previous-commit-then-vanish gutter race
        // (no v1 clobber) and keeps the workspace aggregate complete.
        if (attributionV2Enabled()) {
            await this.refreshV2();
            return;
        }
        const refreshStartMs = Date.now();
        try {
            const folders = vscode.workspace.workspaceFolders ?? [];
            if (folders.length === 0) {
                this.blameMap.clear();
                this.notify();
                return;
            }

            // Discover every distinct git repo across all workspace folders. A
            // multi-root workspace can mix several independent repos (e.g. backend
            // + frontend), each with its own .git; a single-folder workspace yields
            // exactly one. Without this, only folder[0]'s repo got a gutter and the
            // other folders showed no count and no decorations.
            const repoRoots: string[] = [];
            const seenRoots = new Set<string>();
            for (const folder of folders) {
                const root = await GitUtils.getRepoRoot(folder.uri.fsPath);
                if (!root) continue;
                const norm = path.normalize(root);
                if (seenRoots.has(norm)) continue;  // two folders inside one repo
                seenRoots.add(norm);
                repoRoots.push(root);
            }

            if (repoRoots.length === 0) {
                this.blameMap.clear();
                this.notify();
                return;
            }
            this._repoRoot = repoRoots[0];

            void this.checkDaemonHealth();

            const merged = new Map<string, LineBlame[]>();
            let anyUncommittedWork = false;
            let anyReadFailure = false;

            for (const repoRoot of repoRoots) {
                const result = await this.refreshRepo(repoRoot);
                if (result === null) {
                    // Transient SQLite read failure (daemon holds the lock). Defer
                    // rather than rebuild an incomplete gutter — see below.
                    anyReadFailure = true;
                    continue;
                }
                anyUncommittedWork = anyUncommittedWork || result.hasUncommittedWork;
                for (const [key, entries] of expandBlameMapKeys(repoRoot, result.deblanked)) {
                    merged.set(key, entries);
                }
            }

            // If any repo's SQLite read failed this pass, keep the current gutter
            // intact rather than replacing it with a partial map.
            if (anyReadFailure) return;

            // Pending-AI overlay state is global (keyed repo-relative). Only clear it
            // once NO repo has uncommitted work, so a clean repo cannot wipe a dirty
            // repo's pending lines. Repos with work applied their pending in refreshRepo.
            if (!anyUncommittedWork) {
                this.blameMap.clearAllPendingAi();
            }

            // Only skip apply when an optimistic paint happened during THIS refresh
            // (not a stale timestamp from a prior partial run).
            if (
                this.blameMap.lastOptimisticPaintMs > refreshStartMs &&
                Date.now() - this.blameMap.lastOptimisticPaintMs < 500
            ) {
                return;
            }
            this.blameMap.lastOptimisticPaintMs = 0;

            this.blameMap.replaceAll(merged);
            this.notify();
        } catch (err) {
            Logger.warn(`CliDataService refresh: ${err}`);
        }
    }

    /**
     * Build the uncommitted-work blame map (repo-relative keys) for a single git
     * repo. Returns null only on a transient SQLite read failure, signalling the
     * caller to keep the current gutter rather than rebuild it incomplete. A repo
     * whose identity can't be resolved contributes an empty map (its gutter clears).
     */
    private async refreshRepo(
        repoRoot: string,
    ): Promise<{ deblanked: Map<string, LineBlame[]>; hasUncommittedWork: boolean } | null> {
        const repoId = await getRepoId(repoRoot);
        if (!repoId) {
            return { deblanked: new Map(), hasUncommittedWork: false };
        }

        // Scope by branch-based work session, not a timestamp window. The
        // git-diff-HEAD intersection below narrows these to uncommitted lines,
        // so the gutter resets after commit without a fragile `ts >=` cutoff and
        // survives cherry-pick/squash. Detached HEAD → null → only NULL rows.
        const branchOut = await GitUtils.runGitCommand(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD');
        const branch = branchOut?.trim() ? branchOut.trim() : null;
        const headSha = (await GitUtils.runGitCommand(repoRoot, 'rev-parse', 'HEAD'))?.trim() ?? '';

        // Try the canonical repoId first, then two path-normalization fallbacks
        // so the plugin matches whatever format blamely-cli stored (symlink vs real path).
        const edits = await loadEditsForRepo(repoId, branch, headSha, repoRoot);
        if (edits === null) {
            return null;
        }

        // Flush open/dirty buffers before git diff (critical on IDE reopen).
        await this.saveDirtyDocumentsForFiles(repoRoot, await this.pathsNeedingFlush(repoRoot, edits));

        const byFile = editsToBlameMap(repoRoot, edits);

        // Lines that actually differ from HEAD in the working tree (the '+' side of
        // `git diff --unified=0 HEAD`) plus untracked files. Empty after commit.
        const { changedSets, untrackedFiles } = await collectWorkingTreeState(repoRoot);

        const affectedFiles = new Set<string>([...changedSets.keys(), ...untrackedFiles]);

        // Re-locate AI lines by content_sha before scoping to git-diff line numbers.
        applyContentShaAttribution(repoRoot, edits, affectedFiles, byFile, untrackedFiles);

        // Only uncommitted lines vs HEAD (clears gutter/status bar/Changes after commit).
        scopeToUncommittedWorkingTree(byFile, changedSets, untrackedFiles);

        const hasUncommittedWork = changedSets.size > 0 || untrackedFiles.size > 0;

        // Untracked files: trust only tight AI ranges; add human for the rest.
        // A brand-new file with no SQLite edits has no byFile entry yet, but it's
        // still all-human work that must show in the gutter (matching the behavior
        // once `git add` makes it appear in `git diff HEAD`), so default to [].
        for (const filePath of untrackedFiles) {
            const existing = (byFile.get(filePath) ?? []).filter(
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
                if (humanEntries.length > 0 || existing.length > 0) {
                    byFile.set(filePath, [...existing, ...humanEntries]);
                }
            } catch { /* skip unreadable files */ }
        }

        if (hasUncommittedWork) {
            this.applyPendingAi(byFile);
        }

        // Authoritative per git-diff line (overrides stale range / pending mislabels).
        const changedByFile = new Map<string, number[]>();
        for (const [f, lns] of changedSets) changedByFile.set(f, [...lns]);
        reconcileChangedLinesAttribution(repoRoot, edits, changedByFile, byFile, this.blameMap);

        // Drop blame for working-tree-blank lines BEFORE populating the map, so
        // the status-bar summary and the gutter agree: the gutter skips blank
        // lines visually (BlameDecorations), but getSummary has no document text
        // and would otherwise count their entries. Keeping the map blank-free is
        // the single source of truth for both.
        const deblanked = stripBlankLineBlame(repoRoot, byFile);
        return { deblanked, hasUncommittedWork };
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
        this.visibleEditorsListener?.dispose();
        this.workspaceListener?.dispose();
        this.fileOpsListener?.dispose();
        this.fsWatcher?.dispose();
        for (const w of this.dataWatchers) w.dispose();
        this.dataWatchers = [];
        this.listeners = [];
    }
}

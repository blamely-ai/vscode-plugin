import type * as vscode from 'vscode';

/** Max LCS table cells — avoids multi‑MB allocations on huge buffers. */
export const MAX_LCS_CELLS = 5_000_000;

/**
 * Chat / composer applies should attribute using the host-reported change span when the edit is
 * localized. Whole-document snapshot LCS can align duplicate lines incorrectly, yielding a {@code touched}
 * set that does not intersect the nominal range — {@link narrowIntervalsByTouch} then falls back to
 * that set and blame lines appear “swapped” vs the real insert.
 *
 * When the nominal span covers (almost) the entire file, keep using snapshot touch to recover the
 * true edited lines from mis-reported buffer-wide ranges.
 */
export function trustChatApplyEditorSpan(attrSpanLineCount: number, docLineCount: number): boolean {
    if (docLineCount <= 0) {
        return true;
    }
    if (
        attrSpanLineCount >= docLineCount - 25 ||
        attrSpanLineCount >= Math.max(15, Math.floor(0.65 * docLineCount))
    ) {
        return false;
    }
    return true;
}

/** Ignore trailing whitespace when comparing lines so minor formatter drift does not mark whole files touched. */
export function normalizeLineForSnapshotCompare(line: string): string {
    return line.replace(/\s+$/, '');
}

export function captureDocLines(doc: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
        lines.push(doc.lineAt(i).text);
    }
    return lines;
}

/**
 * 1-based line numbers in {@code after} that participate in the shortest edit script from
 * {@code before} → {@code after} on whole-document snapshots (insert / replace side).
 * Used when hosts replace large spans but only a few lines actually change.
 *
 * @returns null if the diff would be too expensive — caller should skip narrowing.
 */
export function linesTouchedInAfterDoc(before: string[], after: string[]): Set<number> | null {
    const n = before.length;
    const m = after.length;
    if (n * m > MAX_LCS_CELLS) {
        return null;
    }

    return linesTouchedInAfterDocUnchecked(before, after);
}

/**
 * When the full-document {@link linesTouchedInAfterDoc} is too large, approximate “touched” lines in
 * {@code after} for a **single** {@link vscode.TextDocumentContentChangeEvent}: diff only a window
 * around the replaced range, then map local 1-based line numbers to the full document.
 *
 * Used for chat-panel applies on large files so attribution can still narrow to changed lines.
 */
export function linesTouchedInAfterDocSingleEditWindow(
    before: string[],
    after: string[],
    rangeStartLine0: number,
    rangeEndLine0Inclusive: number,
    insertedLineCount: number,
    maxCells: number = MAX_LCS_CELLS
): Set<number> | null {
    const n = before.length;
    const m = after.length;
    const delLines =
        rangeEndLine0Inclusive >= rangeStartLine0 ? rangeEndLine0Inclusive - rangeStartLine0 + 1 : 0;
    const pads = [48, 96, 192, 384, 768, 1536];
    for (const pad of pads) {
        const b0 = Math.max(0, rangeStartLine0 - pad);
        const b1 = Math.min(n, rangeEndLine0Inclusive + 1 + pad);
        const a0 = Math.max(0, rangeStartLine0 - pad);
        const a1 = Math.min(
            m,
            rangeStartLine0 + Math.max(insertedLineCount, delLines, 1) + pad + Math.abs(m - n)
        );
        const sb = before.slice(b0, b1);
        const sa = after.slice(a0, a1);
        if (sb.length === 0 || sa.length === 0) {
            continue;
        }
        if (sb.length * sa.length > maxCells) {
            continue;
        }
        const local = linesTouchedInAfterDocUnchecked(sb, sa);
        if (!local || local.size === 0) {
            continue;
        }
        const global = new Set<number>();
        for (const ln of local) {
            global.add(a0 + ln);
        }
        return global;
    }
    return null;
}

function linesTouchedInAfterDocUnchecked(before: string[], after: string[]): Set<number> {
    const n = before.length;
    const m = after.length;

    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] =
                normalizeLineForSnapshotCompare(before[i]) === normalizeLineForSnapshotCompare(after[j])
                    ? 1 + dp[i + 1][j + 1]
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const touched = new Set<number>();
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (normalizeLineForSnapshotCompare(before[i]) === normalizeLineForSnapshotCompare(after[j])) {
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            touched.add(j + 1);
            j++;
        }
    }
    while (j < m) {
        touched.add(j + 1);
        j++;
    }

    return touched;
}

function contiguousRangesFromSortedLineNums(sorted: number[]): Array<{ start: number; end: number }> {
    if (sorted.length === 0) {
        return [];
    }
    const ranges: Array<{ start: number; end: number }> = [];
    let rs = sorted[0];
    let re = sorted[0];
    for (let k = 1; k < sorted.length; k++) {
        const ln = sorted[k];
        if (ln === re + 1) {
            re = ln;
        } else {
            ranges.push({ start: rs, end: re });
            rs = re = ln;
        }
    }
    ranges.push({ start: rs, end: re });
    return ranges;
}

/**
 * Intersections of [startLine,endLine] with {@code touched} as contiguous 1-based ranges.
 * If {@code touched} is null/empty, returns the whole interval.
 *
 * VS Code {@link vscode.TextDocumentContentChangeEvent} ranges are relative to the document **before**
 * each successive edit, while {@code touched} from snapshot diff uses **final** line numbers — they often
 * mis-align on whole-buffer replaces. When intersection is empty, we prefer {@code touched} if it
 * describes a smaller or modest edit than the nominal span (localized insert vs wrong full-buffer range).
 * When the nominal span covers most of the file and {@code docLineCount} is passed, we still attribute
 * using {@code touched} alone (post-edit coords).
 */
export function narrowIntervalsByTouch(
    startLine: number,
    endLine: number,
    touched: Set<number> | undefined | null,
    docLineCount?: number
): Array<{ start: number; end: number }> {
    if (!touched || touched.size === 0 || startLine > endLine) {
        return [{ start: startLine, end: endLine }];
    }
    const hits: number[] = [];
    for (let ln = startLine; ln <= endLine; ln++) {
        if (touched.has(ln)) {
            hits.push(ln);
        }
    }
    if (hits.length > 0) {
        return contiguousRangesFromSortedLineNums(hits);
    }
    const nominalSpan = endLine - startLine + 1;
    if (
        docLineCount !== undefined &&
        docLineCount > 0 &&
        [...touched].some(ln => ln < 1 || ln > docLineCount)
    ) {
        return [{ start: startLine, end: endLine }];
    }
    const slack = 25;
    const doc = docLineCount ?? 0;
    if (
        touched.size <= nominalSpan + slack ||
        (nominalSpan < touched.size &&
            (doc === 0 || touched.size < Math.floor(0.55 * doc)))
    ) {
        return contiguousRangesFromSortedLineNums([...touched].sort((a, b) => a - b));
    }
    if (
        docLineCount !== undefined &&
        docLineCount > 0 &&
        (nominalSpan >= docLineCount - 25 ||
            nominalSpan >= Math.max(15, Math.floor(0.65 * docLineCount)) ||
            nominalSpan >= docLineCount)
    ) {
        const sorted = [...touched].sort((a, b) => a - b);
        return contiguousRangesFromSortedLineNums(sorted);
    }
    return [{ start: startLine, end: endLine }];
}

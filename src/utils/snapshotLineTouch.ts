import type * as vscode from 'vscode';

/** Max LCS table cells — avoids multi‑MB allocations on huge buffers. */
const MAX_LCS_CELLS = 5_000_000;

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
 * mis-align on whole-buffer replaces. When intersection is empty but the nominal span covers most of the
 * file and {@code docLineCount} is passed, we attribute using {@code touched} alone (post-edit coords).
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

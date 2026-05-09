import { LineBlame } from './BlameMap';

/**
 * Re-indexes line numbers in blame entries when lines are inserted or deleted.
 *
 * Lines in [changeStartLine, changeStartLine + min(linesInserted, linesDeleted)) survive
 * (they are modified, not deleted — setAttribute will update them afterwards).
 * Lines in [changeStartLine + min(linesInserted, linesDeleted), changeStartLine + linesDeleted)
 * are truly removed from the file.
 * Lines after the change range are shifted by the net change.
 */
export function reindex(
    entries: LineBlame[],
    changeStartLine: number,
    linesInserted: number,
    linesDeleted: number
): LineBlame[] {
    const netChange = linesInserted - linesDeleted;

    if (netChange === 0 && linesInserted === 0) {
        // Pure replacement of same line count — no reindexing needed
        return entries;
    }

    // Lines that survive (modified in-place): the overlap between inserted and deleted ranges.
    // Lines beyond that overlap in the deleted range are truly removed from the file.
    const survivingEnd = changeStartLine + Math.min(linesInserted, linesDeleted);
    const deleteRangeEnd = changeStartLine + linesDeleted;

    const result: LineBlame[] = [];

    for (const entry of entries) {
        if (entry.lineNumber < changeStartLine) {
            // Before the change — unchanged
            result.push(entry);
        } else if (entry.lineNumber >= changeStartLine && entry.lineNumber < survivingEnd) {
            // Line survives (modified) — keep as-is for setAttribute to update
            result.push(entry);
        } else if (entry.lineNumber >= survivingEnd && entry.lineNumber < deleteRangeEnd) {
            // Truly deleted line — remove
            continue;
        } else {
            // After the change range — shift by net change
            result.push({
                ...entry,
                lineNumber: entry.lineNumber + netChange,
            });
        }
    }

    return result;
}

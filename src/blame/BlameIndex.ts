import { LineBlame } from './BlameMap';

/**
 * Re-indexes line numbers in blame entries when lines are inserted or deleted.
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

    const result: LineBlame[] = [];

    for (const entry of entries) {
        if (entry.lineNumber < changeStartLine) {
            result.push(entry);
        } else if (entry.lineNumber >= changeStartLine && entry.lineNumber < changeStartLine + linesDeleted) {
            continue;
        } else {
            result.push({
                ...entry,
                lineNumber: entry.lineNumber + netChange,
            });
        }
    }

    return result;
}

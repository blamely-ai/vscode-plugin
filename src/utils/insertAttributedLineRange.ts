/**
 * Inclusive 1-based line span to attribute for text inserted by a single
 * {@link vscode.TextDocumentContentChangeEvent}, in coordinates **after** that change
 * (same space as {@link BlameIndex.reindex} output).
 *
 * Pure inserts that only open blank lines (Enter) place the gap at {@code startLine+1}
 * when the caret was not at column 0, matching {@code ChangeTracker} reindex rules.
 * Multi-segment inserts (e.g. {@code "foo\\nbar"}) keep {@code startLine} as the first
 * affected line and {@code startLine + insertedLineCount - 1} as the last.
 */
export function insertAttributedLineRange1Based(
    startCharacter: number,
    startLine1: number,
    insertedLines: string[],
    insertedLineCount: number,
    numNewlines: number,
    isPureInsertion: boolean
): { start: number; end: number } {
    if (isPureInsertion && numNewlines > 0) {
        const gapOnlyWhitespace =
            insertedLines.length > 0 && insertedLines.every(seg => seg.trim() === '');
        if (gapOnlyWhitespace) {
            const gapStart = startCharacter > 0 ? startLine1 + 1 : startLine1;
            const gapEnd = gapStart + numNewlines - 1;
            return { start: gapStart, end: Math.max(gapStart, gapEnd) };
        }
    }
    const end = startLine1 + insertedLineCount - 1;
    return { start: startLine1, end: Math.max(startLine1, end) };
}

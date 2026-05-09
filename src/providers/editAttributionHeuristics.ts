/**
 * Pure helpers for AI vs paste heuristics (unit-tested without VS Code mocks).
 */

export function normalizeInsertPlainText(text: string): string {
    return text.replace(/\r\n/g, '\n').trim();
}

/** Same rule as ChangeTracker clipboard gate: paste only when clipboard equals insert after normalization. */
export function isClipboardExactPasteAfterNormalize(clipboardPlain: string, insertPlain: string): boolean {
    return !!clipboardPlain && clipboardPlain === insertPlain;
}

export function heuristicChunkIsMultiCharacter(insertChunk: string): boolean {
    const text = insertChunk.replace(/\r\n/g, '\n');
    if (/^\n[\t ]*$/.test(text)) {
        return false;
    }
    return text.length > 2;
}

export function heuristicCandidateFromBatchSignals(args: {
    hasFormatPreserved: boolean;
    hasMultiCharChunks: boolean;
    containsNewline: boolean;
    totalInsertLength: number;
}): boolean {
    const { hasFormatPreserved, hasMultiCharChunks, containsNewline, totalInsertLength } = args;
    return !hasFormatPreserved && hasMultiCharChunks && (containsNewline || totalInsertLength > 30);
}

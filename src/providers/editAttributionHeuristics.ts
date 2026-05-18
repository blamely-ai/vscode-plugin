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

/** Newline-only or all-blank lines with at least one newline (IntelliJ gap insert), not a code paste. */
export function isEmptyLineInsertText(insertedText: string): boolean {
    if (insertedText.length === 0) {
        return false;
    }
    const isNewlineOnly = /^\n+$/.test(insertedText);
    const lines = insertedText.split('\n');
    return isNewlineOnly || (lines.every(l => l.trim() === '') && insertedText.includes('\n'));
}

export function heuristicChunkIsMultiCharacter(insertChunk: string): boolean {
    const text = insertChunk.replace(/\r\n/g, '\n');
    if (/^\n[\t ]*$/.test(text)) {
        return false;
    }
    return text.length > 2;
}

/**
 * {@code BULK_INSERT} for inserts spanning more than one line (typical paste); gap-only newline
 * inserts stay {@code TYPING} to match IntelliJ “blank line” behavior.
 */
export function codingTypeForTextInsert(
    insertedText: string,
    isEmptyLineInsert: boolean
): 'TYPING' | 'BULK_INSERT' {
    if (isEmptyLineInsert) {
        return 'TYPING';
    }
    const norm = insertedText.replace(/\r\n/g, '\n');
    return norm.includes('\n') ? 'BULK_INSERT' : 'TYPING';
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

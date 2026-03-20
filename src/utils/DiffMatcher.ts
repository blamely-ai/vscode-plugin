import { SuggestionRecord } from '../store/TraceStore';

export interface MatchResult {
    suggestion: SuggestionRecord;
    similarity: number;
}

export function matchSuggestion(
    pendingSuggestions: SuggestionRecord[],
    insertedText: string,
    filePath: string,
    position: { line: number; character: number }
): MatchResult | null {
    if (!insertedText || insertedText.trim().length === 0) {
        return null;
    }

    // 1. Exact match
    for (const s of pendingSuggestions) {
        if (s.file_path === filePath && s.suggested_text === insertedText) {
            return { suggestion: s, similarity: 1.0 };
        }
    }

    // 2. Normalized whitespace match
    const normalizedInserted = normalizeWhitespace(insertedText);
    for (const s of pendingSuggestions) {
        if (s.file_path === filePath && normalizeWhitespace(s.suggested_text) === normalizedInserted) {
            return { suggestion: s, similarity: 0.95 };
        }
    }

    // 3. Fuzzy match (Levenshtein similarity >= 0.8)
    let bestMatch: MatchResult | null = null;
    for (const s of pendingSuggestions) {
        if (s.file_path !== filePath) {
            continue;
        }
        const sim = similarity(s.suggested_text, insertedText);
        if (sim >= 0.8 && (!bestMatch || sim > bestMatch.similarity)) {
            bestMatch = { suggestion: s, similarity: sim };
        }
    }

    return bestMatch;
}

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    if (m === 0) { return n; }
    if (n === 0) { return m; }

    // Use two rows instead of full matrix for memory efficiency
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);

    for (let j = 0; j <= n; j++) {
        prev[j] = j;
    }

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                curr[j - 1] + 1,       // insertion
                prev[j] + 1,           // deletion
                prev[j - 1] + cost     // substitution
            );
        }
        [prev, curr] = [curr, prev];
    }

    return prev[n];
}

export function similarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) { return 1.0; }
    const dist = levenshteinDistance(a, b);
    return 1.0 - dist / maxLen;
}

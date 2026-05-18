import type { LineBlame } from './BlameMap';

/**
 * Coarse interaction labels in `*.blame.json` (human → JSON null; AI → completion | chat | panel | cli).
 */
export type BlameJsonInteractionType = 'completion' | 'chat' | 'panel' | 'cli';

/** Map in-memory / CLI scopes to disk buckets. */
export function normalizeAiInteractionTypeForDisk(raw: string | null | undefined): BlameJsonInteractionType {
    const t = (raw ?? '').trim();
    if (t === '') {
        return 'completion';
    }
    const lower = t.toLowerCase();
    if (lower === 'ai_cli_trace' || lower.startsWith('blamely-cli-')) {
        return 'cli';
    }
    if (lower === 'chat_panel') {
        return 'panel';
    }
    if (lower === 'chat_inline') {
        return 'chat';
    }
    if (lower === 'completion') {
        return 'completion';
    }
    if (lower.includes('cli') || lower.includes('trace')) {
        return 'cli';
    }
    if (lower.includes('panel') || (lower.includes('chat') && lower.includes('workbench'))) {
        return 'panel';
    }
    if (lower.includes('inline') || lower.includes('ghost')) {
        return 'chat';
    }
    return 'completion';
}

/**
 * Value for `interactionType` in blame snapshots: **null** for human rows; for AI, one of
 * {@link BlameJsonInteractionType}.
 */
export function interactionTypeForBlameJson(e: LineBlame): BlameJsonInteractionType | null {
    if (e.authorType === 'HUMAN') {
        return null;
    }
    return normalizeAiInteractionTypeForDisk(e.interactionType);
}

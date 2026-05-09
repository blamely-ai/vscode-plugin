/**
 * Copilot/chat panel applies often arrive as many tiny TextDocumentChangeEvents (streaming).
 * Pure helpers — no vscode import (safe for Node unit tests).
 */

/** Aggregate inserts across events separated by at most this many ms into one logical apply. */
export const CHAT_STREAM_BURST_GAP_MS = 500;

/** After this many accumulated chars with at least one multi-char chunk, open chat_panel AI window. */
export const CHAT_STREAM_BURST_MIN_ACCUM_FOR_POKE = 36;

export type ChatStreamBurstState = {
    accumulatedLen: number;
    lastChunkAt: number;
    sawMultiCharChunk: boolean;
};

export function nextChatStreamBurstState(
    prev: ChatStreamBurstState | undefined,
    nowMs: number,
    gapMs: number,
    summary: { insertLen: number; maxChunk: number; newlineRuns: number }
): ChatStreamBurstState {
    let burst: ChatStreamBurstState;
    if (!prev || nowMs - prev.lastChunkAt > gapMs) {
        burst = { accumulatedLen: 0, lastChunkAt: nowMs, sawMultiCharChunk: false };
    } else {
        burst = { ...prev };
    }
    burst.accumulatedLen += summary.insertLen;
    burst.sawMultiCharChunk =
        burst.sawMultiCharChunk ||
        summary.maxChunk > 2 ||
        summary.newlineRuns > 0 ||
        summary.insertLen > 2;
    burst.lastChunkAt = nowMs;
    return burst;
}

export function chatStreamBurstQualifiesForPoke(
    burst: ChatStreamBurstState,
    minAccum: number = CHAT_STREAM_BURST_MIN_ACCUM_FOR_POKE
): boolean {
    return burst.sawMultiCharChunk && burst.accumulatedLen >= minAccum;
}

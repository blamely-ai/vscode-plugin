/** Parameters for streaming-aware heuristic debounce (chat apply chunked edits). */

export const HEURISTIC_DEBOUNCE_BASE_MS = 150;
export const HEURISTIC_STREAM_GAP_MS = 250;
export const HEURISTIC_STREAM_MAX_MS = 2500;

/**
 * If chunks keep arriving within {@link HEURISTIC_STREAM_GAP_MS}, extend the burst up to {@link HEURISTIC_STREAM_MAX_MS}.
 * Returns delay until the scheduled flush fires (0 → flush ASAP).
 */
export function computeNextStreamingFlushSchedule(
    nowMs: number,
    burstStartBefore: number,
    lastChunkAtBefore: number
): { burstStartMs: number; lastChunkAtMs: number; delayMs: number } {
    let burstStart = burstStartBefore;
    if (burstStart === 0 || nowMs - lastChunkAtBefore > HEURISTIC_STREAM_GAP_MS) {
        burstStart = nowMs;
    }
    const sinceBurst = nowMs - burstStart;
    const delayMs =
        sinceBurst >= HEURISTIC_STREAM_MAX_MS
            ? 0
            : Math.min(HEURISTIC_DEBOUNCE_BASE_MS, HEURISTIC_STREAM_MAX_MS - sinceBurst);
    return { burstStartMs: burstStart, lastChunkAtMs: nowMs, delayMs };
}

import { expect } from 'chai';
import {
    HEURISTIC_STREAM_GAP_MS,
    HEURISTIC_STREAM_MAX_MS,
    computeNextStreamingFlushSchedule,
} from '../providers/streamingFlushSchedule';

describe('streamingFlushSchedule', () => {
    it('restarts burst when gap between chunks exceeds stream gap', () => {
        const t0 = 1_000_000;
        const first = computeNextStreamingFlushSchedule(t0, 0, 0);
        expect(first.delayMs).to.be.greaterThan(0);

        const withinGap = computeNextStreamingFlushSchedule(t0 + 200, first.burstStartMs, first.lastChunkAtMs);
        expect(withinGap.burstStartMs).to.equal(first.burstStartMs);

        const afterPause = computeNextStreamingFlushSchedule(
            t0 + 200 + HEURISTIC_STREAM_GAP_MS + 1,
            withinGap.burstStartMs,
            withinGap.lastChunkAtMs
        );
        expect(afterPause.burstStartMs).to.equal(t0 + 200 + HEURISTIC_STREAM_GAP_MS + 1);
    });

    it('forces immediate flush when streamed chunks span the max window without a long pause', () => {
        const base = 2_000_000;
        let burst = 0;
        let last = 0;
        let sawZero = false;
        for (let i = 0; i < 80; i++) {
            const now = base + i * 80;
            const step = computeNextStreamingFlushSchedule(now, burst, last);
            burst = step.burstStartMs;
            last = step.lastChunkAtMs;
            if (now - burst >= HEURISTIC_STREAM_MAX_MS) {
                expect(step.delayMs).to.equal(0);
                sawZero = true;
                break;
            }
        }
        expect(sawZero).to.equal(true);
    });

    it('five chunks spaced 200ms stay in one burst timeline', () => {
        let burst = 0;
        let last = 0;
        const base = 5_000_000;
        for (let i = 0; i < 5; i++) {
            const now = base + i * 200;
            const step = computeNextStreamingFlushSchedule(now, burst, last);
            burst = step.burstStartMs;
            last = step.lastChunkAtMs;
            expect(step.delayMs).to.be.greaterThan(0);
        }
        expect(last - burst).to.be.lessThan(HEURISTIC_STREAM_MAX_MS);
    });
});

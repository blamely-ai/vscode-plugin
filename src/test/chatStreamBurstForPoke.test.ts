import { expect } from 'chai';
import {
    nextChatStreamBurstState,
    chatStreamBurstQualifiesForPoke,
    CHAT_STREAM_BURST_GAP_MS,
} from '../utils/chatApplyStreamingBurst';

describe('chat stream burst poke helpers', () => {
    it('accumulates micro-chunks within the burst gap until minimum length', () => {
        let b = nextChatStreamBurstState(undefined, 1000, CHAT_STREAM_BURST_GAP_MS, {
            insertLen: 12,
            maxChunk: 12,
            newlineRuns: 0,
        });
        expect(b.accumulatedLen).to.equal(12);
        expect(chatStreamBurstQualifiesForPoke(b)).to.be.false;

        b = nextChatStreamBurstState(b, 1100, CHAT_STREAM_BURST_GAP_MS, {
            insertLen: 15,
            maxChunk: 15,
            newlineRuns: 0,
        });
        expect(b.accumulatedLen).to.equal(27);
        expect(chatStreamBurstQualifiesForPoke(b)).to.be.false;

        b = nextChatStreamBurstState(b, 1200, CHAT_STREAM_BURST_GAP_MS, {
            insertLen: 12,
            maxChunk: 12,
            newlineRuns: 0,
        });
        expect(b.accumulatedLen).to.equal(39);
        expect(chatStreamBurstQualifiesForPoke(b)).to.be.true;
    });

    it('starts a new burst after a long idle gap', () => {
        let b = nextChatStreamBurstState(undefined, 1000, CHAT_STREAM_BURST_GAP_MS, {
            insertLen: 40,
            maxChunk: 40,
            newlineRuns: 0,
        });
        expect(chatStreamBurstQualifiesForPoke(b)).to.be.true;

        b = nextChatStreamBurstState(b, 1000 + CHAT_STREAM_BURST_GAP_MS + 50, CHAT_STREAM_BURST_GAP_MS, {
            insertLen: 5,
            maxChunk: 5,
            newlineRuns: 0,
        });
        expect(b.accumulatedLen).to.equal(5);
        expect(chatStreamBurstQualifiesForPoke(b)).to.be.false;
    });

    it('does not qualify when every chunk is a single character', () => {
        let b = nextChatStreamBurstState(undefined, 1000, CHAT_STREAM_BURST_GAP_MS, {
            insertLen: 1,
            maxChunk: 1,
            newlineRuns: 0,
        });
        for (let i = 1; i <= 50; i++) {
            b = nextChatStreamBurstState(b, 1000 + i * 40, CHAT_STREAM_BURST_GAP_MS, {
                insertLen: 1,
                maxChunk: 1,
                newlineRuns: 0,
            });
        }
        expect(b.accumulatedLen).to.be.greaterThan(36);
        expect(b.sawMultiCharChunk).to.be.false;
        expect(chatStreamBurstQualifiesForPoke(b)).to.be.false;
    });
});

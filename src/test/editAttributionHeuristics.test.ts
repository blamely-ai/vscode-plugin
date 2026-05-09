import { expect } from 'chai';
import {
    heuristicCandidateFromBatchSignals,
    heuristicChunkIsMultiCharacter,
    isClipboardExactPasteAfterNormalize,
    normalizeInsertPlainText,
} from '../providers/editAttributionHeuristics';

describe('editAttributionHeuristics', () => {
    it('detects heuristic multi-character chunks excluding indent-only newline runs', () => {
        expect(heuristicChunkIsMultiCharacter('\n')).to.equal(false);
        expect(heuristicChunkIsMultiCharacter('\n\t  ')).to.equal(false);
        expect(heuristicChunkIsMultiCharacter('ab')).to.equal(false);
        expect(heuristicChunkIsMultiCharacter('abc')).to.equal(true);
    });

    it('handles CRLF trimming for clipboard vs insert equality', () => {
        const clip = normalizeInsertPlainText('  hello\r\n ');
        const ins = normalizeInsertPlainText('\nhello\n');
        expect(isClipboardExactPasteAfterNormalize(clip, ins)).to.equal(true);
    });

    it('flags large single-line replacements as heuristic AI candidates even without newline', () => {
        const longLine = 'x'.repeat(40);
        expect(
            heuristicCandidateFromBatchSignals({
                hasFormatPreserved: false,
                hasMultiCharChunks: true,
                containsNewline: false,
                totalInsertLength: longLine.length,
            })
        ).to.equal(true);
    });

    it('skips heuristic candidate when formatter preserved ownership flags are set', () => {
        expect(
            heuristicCandidateFromBatchSignals({
                hasFormatPreserved: true,
                hasMultiCharChunks: true,
                containsNewline: true,
                totalInsertLength: 500,
            })
        ).to.equal(false);
    });
});

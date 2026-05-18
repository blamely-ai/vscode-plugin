import { expect } from 'chai';
import {
    codingTypeForTextInsert,
    heuristicCandidateFromBatchSignals,
    heuristicChunkIsMultiCharacter,
    isClipboardExactPasteAfterNormalize,
    isEmptyLineInsertText,
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

    describe('isEmptyLineInsertText', () => {
        it('is false for empty string', () => {
            expect(isEmptyLineInsertText('')).to.equal(false);
        });
        it('is true for newline-only runs', () => {
            expect(isEmptyLineInsertText('\n')).to.equal(true);
            expect(isEmptyLineInsertText('\n\n')).to.equal(true);
        });
        it('is true for blank-line multi-line gap inserts', () => {
            expect(isEmptyLineInsertText('\n \n')).to.equal(true);
            expect(isEmptyLineInsertText('\t\n  \n')).to.equal(true);
        });
        it('is false when any line has non-whitespace', () => {
            expect(isEmptyLineInsertText('\na\n')).to.equal(false);
            expect(isEmptyLineInsertText('x')).to.equal(false);
        });
    });

    describe('codingTypeForTextInsert', () => {
        it('uses BULK_INSERT when insert spans more than one line', () => {
            expect(codingTypeForTextInsert('a\nb', false)).to.equal('BULK_INSERT');
            expect(codingTypeForTextInsert('a\r\nb', false)).to.equal('BULK_INSERT');
        });
        it('uses TYPING for single-line paste', () => {
            expect(codingTypeForTextInsert('hello', false)).to.equal('TYPING');
        });
        it('keeps TYPING for gap-only blank-line inserts', () => {
            expect(codingTypeForTextInsert('\n', true)).to.equal('TYPING');
            expect(codingTypeForTextInsert('\n\n', true)).to.equal('TYPING');
        });
    });
});

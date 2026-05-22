import { expect } from 'chai';
import {
    linesTouchedInAfterDoc,
    linesTouchedInAfterDocSingleEditWindow,
    narrowIntervalsByTouch,
    trustChatApplyEditorSpan,
} from '../utils/snapshotLineTouch';

describe('snapshotLineTouch', () => {
    describe('trustChatApplyEditorSpan', () => {
        it('trusts localized span in a large file (skip LCS narrowing for chat mid-file inserts)', () => {
            expect(trustChatApplyEditorSpan(20, 291)).to.equal(true);
        });

        it('does not trust when nominal span covers almost the whole document', () => {
            expect(trustChatApplyEditorSpan(291, 291)).to.equal(false);
            expect(trustChatApplyEditorSpan(270, 291)).to.equal(false);
        });

        it('does not trust mid-sized spans that exceed 65% of a modest file', () => {
            expect(trustChatApplyEditorSpan(190, 291)).to.equal(false);
        });
    });

    describe('linesTouchedInAfterDoc', () => {
        it('returns empty when documents are identical', () => {
            const a = ['x', 'y', 'z'];
            const s = linesTouchedInAfterDoc(a, a)!;
            expect(s.size).to.equal(0);
        });

        it('marks single inserted middle line (1-based)', () => {
            const before = ['a', 'c'];
            const after = ['a', 'b', 'c'];
            const s = linesTouchedInAfterDoc(before, after)!;
            expect([...s].sort((x, y) => x - y)).to.deep.equal([2]);
        });

        it('marks modified line in middle', () => {
            const before = ['a', 'old', 'c'];
            const after = ['a', 'new', 'c'];
            const s = linesTouchedInAfterDoc(before, after)!;
            expect([...s].sort((x, y) => x - y)).to.deep.equal([2]);
        });

        it('marks small edit in large unchanged file', () => {
            const before = Array.from({ length: 291 }, (_, i) => `line ${i + 1}`);
            const after = before.slice();
            after[49] = 'CHANGED'; // line 50
            after[50] = 'CHANGED2'; // line 51
            const s = linesTouchedInAfterDoc(before, after)!;
            expect([...s].sort((x, y) => x - y)).to.deep.equal([50, 51]);
        });

        it('treats trailing-whitespace-only churn as unchanged', () => {
            const before = ['alpha', 'beta'];
            const after = ['alpha   ', 'beta'];
            const s = linesTouchedInAfterDoc(before, after)!;
            expect(s.size).to.equal(0);
        });
    });

    describe('linesTouchedInAfterDocSingleEditWindow', () => {
        it('approximates touched lines when full-document LCS is too large', () => {
            const before = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
            const after = before.slice();
            after[1499] = 'CHANGED';
            expect(linesTouchedInAfterDoc(before, after)).to.equal(null);
            const w = linesTouchedInAfterDocSingleEditWindow(before, after, 1499, 1499, 1)!;
            expect([...w].sort((a, b) => a - b)).to.deep.equal([1500]);
        });
    });

    describe('completion / duplicate-line narrowing (regression)', () => {
        it('intersection of nominal insert span with partial touch drops interior lines', () => {
            const touched = new Set([2, 4]);
            expect(narrowIntervalsByTouch(2, 5, touched, 20)).to.deep.equal([
                { start: 2, end: 2 },
                { start: 4, end: 4 },
            ]);
        });
    });

    describe('narrowIntervalsByTouch', () => {
        it('returns full span when touch unset', () => {
            expect(narrowIntervalsByTouch(5, 10, undefined)).to.deep.equal([{ start: 5, end: 10 }]);
        });

        it('merges contiguous touched lines', () => {
            const t = new Set([6, 7, 8, 12]);
            expect(narrowIntervalsByTouch(1, 20, t, 50)).to.deep.equal([
                { start: 6, end: 8 },
                { start: 12, end: 12 },
            ]);
        });

        it('uses post-edit touched when nominal VS Code span mismatches coords (whole-buffer apply)', () => {
            const t = new Set([50, 51]);
            expect(narrowIntervalsByTouch(1, 291, t, 291)).to.deep.equal([{ start: 50, end: 51 }]);
        });

        it('prefers touched over a huge misaligned nominal span (mid-file insert)', () => {
            const t = new Set<number>();
            for (let i = 50; i <= 69; i++) {
                t.add(i);
            }
            expect(narrowIntervalsByTouch(1, 190, t, 200)).to.deep.equal([{ start: 50, end: 69 }]);
        });

        it('prefers touched when nominal span understates and does not overlap touched', () => {
            expect(narrowIntervalsByTouch(1, 5, new Set([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]), 100)).to.deep.equal([
                { start: 50, end: 59 },
            ]);
        });

        it('keeps editor span when LCS touch is wholly outside nominal chat replace (duplicate-line swap)', () => {
            const misaligned = new Set<number>();
            for (let i = 120; i <= 139; i++) {
                misaligned.add(i);
            }
            expect(narrowIntervalsByTouch(45, 80, misaligned, 291)).to.deep.equal([{ start: 45, end: 80 }]);
        });
    });
});

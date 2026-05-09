import { expect } from 'chai';
import { linesTouchedInAfterDoc, narrowIntervalsByTouch } from '../utils/snapshotLineTouch';

describe('snapshotLineTouch', () => {
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

        it('trusts touched when nominal range is off-document vs snapshot coords', () => {
            expect(narrowIntervalsByTouch(100, 111, new Set([3, 4]), 12)).to.deep.equal([{ start: 3, end: 4 }]);
        });
    });
});

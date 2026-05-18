import { expect } from 'chai';
import { parseUnifiedDiffPatch } from '../git/GitUtils';

describe('parseUnifiedDiffPatch', () => {
    it('records deleted old-file line numbers from staged-style unified diff', () => {
        const patch =
            'diff --git a/f.ts b/f.ts\n' +
            '--- a/f.ts\n' +
            '+++ b/f.ts\n' +
            '@@ -1,3 +1,2 @@\n' +
            ' keep-top\n' +
            '-gone\n' +
            ' keep-bottom';
        const s = parseUnifiedDiffPatch(patch);
        expect(s.deletedLines).to.deep.equal([2]);
        expect(s.addedCount).to.equal(0);
        expect(s.deletedCount).to.equal(1);
    });
});

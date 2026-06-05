import { strict as assert } from 'assert';
import * as crypto from 'crypto';
import { pendingMatchesLine } from '../cli/pendingMatch';
import { BlameMap } from '../blame/BlameMap';

function sha(s: string): string {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('pending AI content_sha guard', () => {
    it('matches when current line text still hashes to the captured AI sha', () => {
        const aiText = '    return computeTotal(items);';
        assert.equal(pendingMatchesLine({ contentSha: sha(aiText) }, aiText), true);
    });

    it('rejects a human line inserted into the band (different text)', () => {
        const aiText = '    return computeTotal(items);';
        const humanText = '    // TODO: revisit this';
        assert.equal(pendingMatchesLine({ contentSha: sha(aiText) }, humanText), false);
    });

    it('ignores a trailing carriage return when hashing', () => {
        const aiText = 'const x = 1;';
        assert.equal(pendingMatchesLine({ contentSha: sha(aiText) }, aiText + '\r'), true);
    });

    it('falls back to the legacy line bridge when no sha was captured (blank line)', () => {
        assert.equal(pendingMatchesLine({ contentSha: null }, 'anything'), true);
        assert.equal(pendingMatchesLine({}, 'anything'), true);
    });

    it('BlameMap.markPendingAiLines stores the per-line content_sha', () => {
        const map = new BlameMap();
        const shas = new Map<number, string>([[1, sha('a')], [2, sha('b')]]);
        map.markPendingAiLines('f.ts', 1, 3, 'copilot', null, 'completion', shas);
        const pending = map.pendingAiLinesFor('f.ts');
        assert.equal(pending.get(1)?.contentSha, sha('a'));
        assert.equal(pending.get(2)?.contentSha, sha('b'));
        // Line 3 had no captured sha (e.g. blank) → null, keeps legacy bridge.
        assert.equal(pending.get(3)?.contentSha, null);
    });
});

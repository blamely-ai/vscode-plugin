import { strict as assert } from 'assert';
import { alignLines } from '../authorship/attribute';

// The original whole-file LCS DP + backtrack — the reference alignLines must
// reproduce exactly (mirrors the Go TestAlignLinesMatchesFullDP).
function alignLinesFullDP(oldLines: string[], newLines: string[]): number[] {
    const n = oldLines.length;
    const m = newLines.length;
    const matched: number[] = new Array(m).fill(-1);
    if (n === 0 || m === 0) {
        return matched;
    }
    const norm = (s: string) => s.replace(/\s/g, '');
    const oldN = oldLines.map(norm);
    const newN = newLines.map(norm);
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (oldN[i] === newN[j]) {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                dp[i][j] = dp[i + 1][j];
            } else {
                dp[i][j] = dp[i][j + 1];
            }
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (oldN[i] === newN[j]) {
            matched[j] = i;
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return matched;
}

describe('alignLines', () => {
    it('matches the whole-file DP on random inputs with many duplicates', () => {
        let seed = 1;
        const rnd = (k: number) => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed % k;
        };
        const alphabet = ['a', 'b', ' a', 'c', ''];
        const gen = (k: number) => Array.from({ length: k }, () => alphabet[rnd(alphabet.length)]);
        for (let iter = 0; iter < 50000; iter++) {
            const oldLines = gen(rnd(9));
            let newLines: string[];
            if (rnd(3) === 0) {
                newLines = gen(rnd(9));
            } else {
                const cut1 = rnd(oldLines.length + 1);
                const cut2 = cut1 + rnd(oldLines.length - cut1 + 1);
                newLines = [...oldLines.slice(0, cut1), ...gen(rnd(4)), ...oldLines.slice(cut2)];
            }
            assert.deepEqual(
                alignLines(oldLines, newLines),
                alignLinesFullDP(oldLines, newLines),
                `old=${JSON.stringify(oldLines)} new=${JSON.stringify(newLines)}`,
            );
        }
    });

    it('handles a one-line edit in a 50k-line file without a whole-file table', () => {
        const n = 50000;
        const oldLines = Array.from({ length: n }, (_, i) => `line ${i % 97}`);
        const newLines = [...oldLines];
        newLines[n / 2] = 'changed';
        const start = Date.now();
        const matched = alignLines(oldLines, newLines);
        assert.ok(Date.now() - start < 2000, 'too slow');
        assert.equal(matched[n / 2], -1);
        assert.equal(matched[0], 0);
        assert.equal(matched[n - 1], n - 1);
    });
});

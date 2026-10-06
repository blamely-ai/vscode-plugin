import { strict as assert } from 'assert';
import { alignLines, attribute, humanAuthor, setMaxAlignCellsForTest, WORKING_LOG_SCHEMA } from '../authorship/attribute';

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
    function checkMatchesFullDP(iters: number): void {
        let seed = 1;
        const rnd = (k: number) => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed % k;
        };
        const alphabet = ['a', 'b', ' a', 'c', ''];
        const gen = (k: number) => Array.from({ length: k }, () => alphabet[rnd(alphabet.length)]);
        for (let iter = 0; iter < iters; iter++) {
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
    }

    it('matches the whole-file DP on random inputs with many duplicates', () => {
        checkMatchesFullDP(50000);
    });

    it('gives the same matches through the checkpointed table above the cap', () => {
        const prev = setMaxAlignCellsForTest(1);
        try {
            checkMatchesFullDP(50000);
            let seed = 2;
            const rnd = (k: number) => {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                return seed % k;
            };
            const alphabet = ['a', 'b', ' a', 'c', ''];
            for (let iter = 0; iter < 200; iter++) {
                const oldLines = Array.from({ length: 50 + rnd(150) }, () => alphabet[rnd(alphabet.length)]);
                const newLines = [...oldLines];
                for (let e = rnd(20); e > 0; e--) {
                    const k = rnd(newLines.length);
                    const op = rnd(3);
                    if (op === 0) newLines.splice(k, 1);
                    else if (op === 1) newLines.splice(k, 0, alphabet[rnd(alphabet.length)]);
                    else newLines[k] = alphabet[rnd(alphabet.length)];
                }
                assert.deepEqual(alignLines(oldLines, newLines), alignLinesFullDP(oldLines, newLines));
            }
        } finally {
            setMaxAlignCellsForTest(prev);
        }
    });

    it('keeps duplicate lines\' owners above the cap', () => {
        const n = 4500;
        const old = Array.from({ length: n }, (_, k) => (k % 10 === 0 ? '}' : `stmt${k}`));
        const copilot = { author: 'ai' as const, tool: 'copilot', gen_type: 'chat' };
        const prior = {
            schema: WORKING_LOG_SCHEMA,
            lines: [
                { start: 1, end: 2000, author: 'human' as const, gen_type: 'human' },
                { start: 2001, end: 2001, ...copilot },
                { start: 2002, end: n, author: 'human' as const, gen_type: 'human' },
            ],
        };
        const cur = [...old];
        cur[1] = 'edited';
        cur[n - 2] = 'edited too';
        cur.splice(500, 1); // old[500] is a "}" above the Copilot line
        const wl = attribute(prior, old.join('\n') + '\n', cur.join('\n') + '\n', humanAuthor(), 1);
        const ai: number[] = [];
        for (const r of wl.lines) {
            if (r.author === 'ai') for (let ln = r.start; ln <= r.end; ln++) ai.push(ln);
        }
        assert.deepEqual(ai, [2000], 'only the unchanged Copilot line (old 2001, now 2000) is AI');
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

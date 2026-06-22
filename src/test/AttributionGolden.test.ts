import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { attribute, Author, AuthorType, WorkingLog } from '../authorship/attribute';

// Runs the SHARED golden vectors (golden_vectors.json, synced from blamely-cli's
// canonical copy) through the TS engine. The Go and Kotlin ports run the same
// file; if the TS implementation drifts, these cases fail. See
// docs/attribution-v2-design.md §6.
interface GoldenCase {
    name: string;
    prior: { start: number; end: number; author: AuthorType }[] | null;
    baseline: string;
    new: string;
    author: { author: AuthorType; tool?: string; gen_type?: string };
    expect: AuthorType[];
    expect_overrode?: (AuthorType | null)[];
}

function typesByLine(wl: WorkingLog, n: number): AuthorType[] {
    const out: AuthorType[] = new Array(n);
    for (const r of wl.lines) {
        for (let ln = r.start; ln <= r.end && ln <= n; ln++) {
            out[ln - 1] = r.author;
        }
    }
    return out;
}

function overrodeTypesByLine(wl: WorkingLog, n: number): (AuthorType | null)[] {
    const out: (AuthorType | null)[] = new Array(n).fill(null);
    for (const r of wl.lines) {
        if (!r.overrode) {
            continue;
        }
        for (let ln = r.start; ln <= r.end && ln <= n; ln++) {
            out[ln - 1] = r.overrode.author;
        }
    }
    return out;
}

describe('Attribution v2 golden vectors (TS)', () => {
    const file = path.join(__dirname, 'golden_vectors.json');
    const gf = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string; cases: GoldenCase[] };

    it('has cases', () => assert.ok(gf.cases.length > 0));

    for (const c of gf.cases) {
        it(c.name, () => {
            const prior: WorkingLog | null = c.prior
                ? { schema: 'blamely/working-log/1', lines: c.prior.map((r) => ({ start: r.start, end: r.end, author: r.author })) }
                : null;
            const author: Author = { author: c.author.author, tool: c.author.tool, gen_type: c.author.gen_type };

            const wl = attribute(prior, c.baseline, c.new, author, 1);
            const got = typesByLine(wl, c.expect.length);

            assert.equal(got.length, c.expect.length, `${c.name}: line count`);
            for (let i = 0; i < c.expect.length; i++) {
                assert.equal(got[i], c.expect[i], `${c.name}: line ${i + 1} — got ${got[i]}, want ${c.expect[i]}`);
            }

            if (c.expect_overrode) {
                const ov = overrodeTypesByLine(wl, c.expect_overrode.length);
                for (let i = 0; i < c.expect_overrode.length; i++) {
                    assert.equal(ov[i] ?? null, c.expect_overrode[i] ?? null,
                        `${c.name}: line ${i + 1} overrode — got ${ov[i]}, want ${c.expect_overrode[i]}`);
                }
            }
        });
    }
});

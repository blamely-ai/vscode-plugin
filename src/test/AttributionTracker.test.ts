import { strict as assert } from 'assert';
import { Author, AuthorType, WorkingLog, humanAuthor } from '../authorship/attribute';
import { FileTracker } from '../authorship/tracker';

function types(wl: WorkingLog | null, n: number): AuthorType[] {
    const out: AuthorType[] = new Array(n);
    for (const r of (wl?.lines ?? [])) {
        for (let ln = r.start; ln <= r.end && ln <= n; ln++) {
            out[ln - 1] = r.author;
        }
    }
    return out;
}

const ai: Author = { author: 'ai', tool: 'copilot', gen_type: 'completion' };

describe('Attribution v2 FileTracker (TS)', () => {
    it('accumulates human typing then an AI completion in order', () => {
        // Start from an empty file the human is editing.
        const t = new FileTracker('', null);
        t.applyEdit('h1\nh2\n', humanAuthor(), 1); // human types two lines
        t.applyEdit('h1\nh2\ndone();\n', ai, 2);    // accepts a completion on line 3

        assert.deepEqual(types(t.current(), 3), ['human', 'human', 'ai']);
        assert.ok(t.isDirty());
        t.markFlushed();
        assert.ok(!t.isDirty());
    });

    it('an AI re-emit of a human line keeps it Human', () => {
        const t = new FileTracker('keep me\n', null); // baseline is a human line (prior log null → human)
        t.applyEdit('keep me\nai added\n', ai, 1);     // agent rewrites, re-including "keep me"
        assert.deepEqual(types(t.current(), 2), ['human', 'ai']);
    });

    it('ignores a no-op change (save with no edit)', () => {
        const t = new FileTracker('x\n', null);
        t.applyEdit('x\n', ai, 1);
        assert.equal(t.current(), null, 'no edit → no log created');
        assert.ok(!t.isDirty());
    });
});

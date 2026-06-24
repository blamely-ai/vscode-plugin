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

    // Regression: an agent (e.g. Claude Code) creates a file via Write — the keystroke
    // tracker never sees it, but the CLI writes a working log crediting the AI. When the
    // editor FIRST tracks the file (a later human paste), it must SEED from that prior
    // log, not null. Seeding from null defaulted every untouched AI line to Human and the
    // flush clobbered the file's attribution (repro: student-register.html → 124 Human).
    it('seeds from the prior working log so an agent-written file is not clobbered', () => {
        const claude: Author = { author: 'ai', tool: 'claude', gen_type: 'chat' };
        const agentContent = 'a1\na2\na3\n';
        // The CLI's working log for the agent Write: all three lines are Claude's.
        const priorLog = new FileTracker('', null);
        priorLog.applyEdit(agentContent, claude, 1);
        assert.deepEqual(types(priorLog.current(), 3), ['ai', 'ai', 'ai']);

        // Editor first sees the file at a human paste of one line. Seeded from the prior
        // log + its baseline (what seed() does), only the pasted line is Human.
        const t = new FileTracker(agentContent, priorLog.current());
        t.applyEdit('a1\na2\npasted\na3\n', humanAuthor(), 2);
        assert.deepEqual(types(t.current(), 4), ['ai', 'ai', 'human', 'ai']);
    });

    it('without a prior log the same first edit defaults untouched lines to Human (the bug)', () => {
        // Contrast: priorLog null is exactly the pre-fix behaviour — the agent lines are lost.
        const t = new FileTracker('a1\na2\na3\n', null);
        t.applyEdit('a1\na2\npasted\na3\n', humanAuthor(), 1);
        assert.deepEqual(types(t.current(), 4), ['human', 'human', 'human', 'human']);
    });
});

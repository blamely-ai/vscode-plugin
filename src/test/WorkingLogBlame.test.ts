import { strict as assert } from 'assert';
import { toLineBlame, WorkingLogJson } from '../authorship/workingLogBlame';

// toLineBlame is the gutter's data transform (working log → per-line LineBlame the
// renderer consumes). A bug here paints wrong icons, so pin its behavior.
describe('toLineBlame (v2 gutter converter)', () => {
    it('expands an AI range into per-line AI entries with provider/model/gen_type', () => {
        const wl: WorkingLogJson = {
            file: 'a.ts',
            lines: [{ start: 3, end: 5, author: 'ai', tool: 'claude', model: 'opus', gen_type: 'chat' }],
        };
        const out = toLineBlame(wl);
        assert.equal(out.length, 3);
        for (const [i, e] of out.entries()) {
            assert.equal(e.lineNumber, 3 + i);
            assert.equal(e.authorType, 'AI');
            assert.equal(e.provider, 'claude');
            assert.equal(e.model, 'opus');
            assert.equal(e.interactionType, 'chat');
            assert.equal(e.aiChars, 1);
            assert.equal(e.humanChars, 0);
            assert.equal(e.changeType, 'ADD');
        }
    });

    it('expands a human range into per-line Human entries with no AI metadata', () => {
        const out = toLineBlame({ lines: [{ start: 1, end: 2, author: 'human' }] });
        assert.equal(out.length, 2);
        for (const e of out) {
            assert.equal(e.authorType, 'HUMAN');
            assert.equal(e.provider, null);
            assert.equal(e.model, null);
            assert.equal(e.aiChars, 0);
            assert.equal(e.humanChars, 1);
        }
    });

    it('handles mixed ranges and is empty for no lines', () => {
        assert.deepEqual(toLineBlame({}), []);
        assert.deepEqual(toLineBlame({ lines: [] }), []);
        const mixed = toLineBlame({
            lines: [
                { start: 1, end: 1, author: 'human' },
                { start: 2, end: 2, author: 'ai', tool: 'codex' },
            ],
        });
        assert.equal(mixed.length, 2);
        assert.equal(mixed[0].authorType, 'HUMAN');
        assert.equal(mixed[1].authorType, 'AI');
        assert.equal(mixed[1].provider, 'codex');
    });
});

import { strict as assert } from 'assert';
import { parseCliNote, genTypesFromNote } from '../cli/NoteParser';

describe('NoteParser', () => {
    it('parses a schema 1 note', () => {
        const raw = JSON.stringify({
            schema: 1,
            commit: '1d90c1da58c0e8e659c873b34e82e8a5d92a720e',
            totals: { ai_lines: 57, human_lines: 0, deleted_lines: 0, files: 2 },
            by_tool: { copilot: { lines: 57 } },
            by_gen_type: { chat: 0, cli: 0, completion: 57 },
        });
        const note = parseCliNote(raw);
        assert.ok(note);
        assert.equal(note!.commit, '1d90c1da58c0e8e659c873b34e82e8a5d92a720e');
    });

    // Schema 2 collapses per-line entries into start/end ranges and may carry
    // ai_deleted_lines on a deletion-only commit (no ai/human added lines).
    // The History view must still surface these commits.
    it('parses a schema 2 note with range-based lines and ai_deleted_lines', () => {
        const raw = JSON.stringify({
            schema: 2,
            commit: 'e1a13f1972a417faf812cb68fc25f4e8cae2020d',
            branch: 'master',
            message: 'kerim',
            coding_time_nanos: 22858394000,
            totals: { ai_lines: 0, human_lines: 0, deleted_lines: 19, ai_deleted_lines: 19, files: 1 },
            by_tool: {},
            by_gen_type: { chat: 19, cli: 0, completion: 0, unknown: 0 },
            files: [{
                path: 'student-registration.js', type: 'MODIFIED', added: 0, deleted: 19,
                lines: [{ start: 27, end: 45, type: 'delete', author_type: 'AI', tool: 'claude', model: 'claude-sonnet-4-6', gen_type: 'chat' }],
            }],
        });

        const note = parseCliNote(raw);
        assert.ok(note);
        assert.equal(note!.totals.deleted_lines, 19);
        assert.equal(note!.totals.ai_deleted_lines, 19);
        assert.deepEqual(genTypesFromNote(note!), ['chat']);
    });

    it('rejects an unknown schema version', () => {
        const raw = JSON.stringify({
            schema: 3,
            commit: 'abc123',
            totals: { ai_lines: 1, human_lines: 0, deleted_lines: 0, files: 1 },
        });
        assert.equal(parseCliNote(raw), null);
    });

    it('rejects non-JSON input', () => {
        assert.equal(parseCliNote('not json'), null);
    });
});

import { strict as assert } from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BlameMap } from '../blame/BlameMap';
import { applyContentShaAttribution, reconcileChangedLinesAttribution } from '../cli/CliDataService';
import { CliEditRow } from '../cli/types';

function sha(s: string): string {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Regression for the gutter splitting a run of identical AI lines after a human
// inserts lines above them. Repro from the field (scenerio_25.txt):
//   AI wrote 5 identical "kerim" lines (recorded at original lines 1-5), then
//   the user inserted 3 lines at the top, drifting the AI block down to 4-8.
//   The commit note correctly attributed 4-8 as AI, but the gutter showed
//   4-5 AI / 6-8 Human: the copy-paste guard killed the drifted duplicates
//   because their recorded "home" still held an (AI) "kerim" line. The fix
//   skips the guard for budgeted drift matches (real recorded occurrences).
describe('drift attribution of identical AI lines', () => {
    it('keeps all 5 AI lines AI after a human inserts lines above them', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-drift-'));
        const rel = 'scenerio_25.txt';
        // Final on-disk state: 3 human lines on top, then the 5 AI "kerim" lines.
        const fileLines = ['', 'kerimq5xwxw', '', 'kerim', 'kerim', 'kerim', 'kerim', 'kerim'];
        fs.writeFileSync(path.join(repoRoot, rel), fileLines.join('\n'));

        // The AI recorded its 5 lines at their ORIGINAL positions (1-5), one
        // per-line content row, before the human inserted the 3 lines above.
        const kerimSha = sha('kerim');
        const edits: CliEditRow[] = [1, 2, 3, 4, 5].map((ln) => ({
            id: ln,
            ts: 1,
            file_path: rel,
            tool: 'copilot',
            model: 'gpt-5-mini',
            gen_type: 'chat',
            start_line: ln,
            end_line: ln,
            content_sha: kerimSha,
            content_sha_norm: kerimSha,
        }));

        const changedByFile = new Map<string, number[]>([[rel, [1, 2, 3, 4, 5, 6, 7, 8]]]);
        const byFile = new Map<string, ReturnType<BlameMap['getBlame']>>();
        reconcileChangedLinesAttribution(repoRoot, edits, changedByFile, byFile, new BlameMap());

        const byLine = new Map(byFile.get(rel)!.map((e) => [e.lineNumber, e]));
        for (const ln of [4, 5, 6, 7, 8]) {
            assert.equal(byLine.get(ln)?.authorType, 'AI', `line ${ln} should be AI`);
        }
        // The human content on top must stay Human.
        assert.equal(byLine.get(2)?.authorType, 'HUMAN', 'line 2 (kerimq5xwxw) should be Human');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('still flags a human-pasted extra copy beyond the recorded count as Human', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-drift-'));
        const rel = 'extra.txt';
        // AI recorded 2 "dup" lines (at 1-2); the file has a 3rd identical line
        // the human pasted at the end. The original positions still hold "dup",
        // so the 3rd is a copy beyond budget → must stay Human.
        const fileLines = ['dup', 'dup', 'tail', 'dup'];
        fs.writeFileSync(path.join(repoRoot, rel), fileLines.join('\n'));

        const dupSha = sha('dup');
        const edits: CliEditRow[] = [1, 2].map((ln) => ({
            id: ln,
            ts: 1,
            file_path: rel,
            tool: 'copilot',
            model: 'gpt-5-mini',
            gen_type: 'chat',
            start_line: ln,
            end_line: ln,
            content_sha: dupSha,
            content_sha_norm: dupSha,
        }));

        const changedByFile = new Map<string, number[]>([[rel, [1, 2, 3, 4]]]);
        const byFile = new Map<string, ReturnType<BlameMap['getBlame']>>();
        reconcileChangedLinesAttribution(repoRoot, edits, changedByFile, byFile, new BlameMap());

        const byLine = new Map(byFile.get(rel)!.map((e) => [e.lineNumber, e]));
        assert.equal(byLine.get(1)?.authorType, 'AI', 'line 1 should be AI');
        assert.equal(byLine.get(2)?.authorType, 'AI', 'line 2 should be AI');
        assert.equal(byLine.get(4)?.authorType, 'HUMAN', 'line 4 (pasted copy beyond budget) should be Human');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    // The same bug on the UNTRACKED-file path (applyContentShaAttribution), which a
    // brand-new file uses before it's committed — this is what the gutter actually
    // hits in the test workflow (create file, add human lines on top, view gutter).
    // Repro from the field (scenario_4530.txt): 5 AI "heloo" lines recorded at 1-5,
    // 2 human lines inserted on top → AI drifts to 3-7; all of 3-7 must stay AI.
    it('keeps all AI lines AI on the untracked-file drift path', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-drift-'));
        const rel = 'scenario_4530.txt';
        const fileLines = ['dsadas', 'asdas', 'heloo', 'heloo', 'heloo', 'heloo', 'heloo'];
        fs.writeFileSync(path.join(repoRoot, rel), fileLines.join('\n'));

        const helooSha = sha('heloo');
        const edits: CliEditRow[] = [1, 2, 3, 4, 5].map((ln) => ({
            id: ln,
            ts: 1,
            file_path: rel,
            tool: 'copilot',
            model: 'gpt-5-mini',
            gen_type: 'chat',
            start_line: ln,
            end_line: ln,
            content_sha: helooSha,
            content_sha_norm: helooSha,
        }));

        const byFile = new Map<string, ReturnType<BlameMap['getBlame']>>();
        applyContentShaAttribution(repoRoot, edits, [rel], byFile, new Set([rel]));

        const byLine = new Map((byFile.get(rel) ?? []).map((e) => [e.lineNumber, e]));
        for (const ln of [3, 4, 5, 6, 7]) {
            assert.equal(byLine.get(ln)?.authorType, 'AI', `line ${ln} should be AI`);
        }

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});

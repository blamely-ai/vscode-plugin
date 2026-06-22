import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuthorType, WorkingLog, humanAuthor } from '../authorship/attribute';
import { update, loadWorkingLog, workingLogPath } from '../authorship/store';

function typesByLine(wl: WorkingLog, n: number): AuthorType[] {
    const out: AuthorType[] = new Array(n);
    for (const r of wl.lines) {
        for (let ln = r.start; ln <= r.end && ln <= n; ln++) {
            out[ln - 1] = r.author;
        }
    }
    return out;
}

describe('Attribution v2 store (TS)', () => {
    let repo: string;
    beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-store-')); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('chains edits via the stored baseline (type-then-AI) and round-trips', async () => {
        const ai = { author: 'ai' as AuthorType, tool: 'claude', gen_type: 'chat' };

        // 1) Human types two lines (first edit, no stored baseline).
        await update(repo, 'main', 'base0', 'src/f.txt', 'h1\nh2\n', '', humanAuthor(), 1);
        // 2) AI appends — update diffs against the STORED baseline, not a re-supplied one.
        const wl = await update(repo, 'main', 'base0', 'src/f.txt', 'h1\nh2\nai3\n', '', ai, 2);

        assert.deepEqual(typesByLine(wl, 3), ['human', 'human', 'ai']);

        // Reload from disk → identical, and metadata is set.
        const reloaded = await loadWorkingLog(repo, 'main', 'base0', 'src/f.txt');
        assert.ok(reloaded, 'working log should reload');
        assert.deepEqual(typesByLine(reloaded!, 3), ['human', 'human', 'ai']);
        assert.equal(reloaded!.file, 'src/f.txt');
        assert.equal(reloaded!.base_sha, 'base0');
        assert.ok(fs.existsSync(workingLogPath(repo, 'main', 'base0', 'src/f.txt')));
    });

    it('sanitizes branch slashes and keeps spaced filenames in the path', () => {
        const p = workingLogPath('/tmp/repo', 'feature/login', 'abc', 'pages/login page.html');
        assert.ok(!p.includes('feature/login') && !p.includes('feature\\login'), `branch slash not sanitized: ${p}`);
        assert.ok(p.includes('login page.html.json'), `spaced filename not preserved: ${p}`);
    });
});

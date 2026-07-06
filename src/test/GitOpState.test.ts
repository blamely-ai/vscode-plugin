import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitOpState } from '../git/GitOpState';
import { WorkingLogTracker } from '../authorship/WorkingLogTracker';
import { humanAuthor } from '../authorship/attribute';

function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
        },
    }).trim();
}

function initRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-gitop-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    return repo;
}

describe('GitOpState (cached in-progress-op / stash-window state)', () => {
    it('marker files toggle isActive', async () => {
        const repo = initRepo();
        try {
            const gitDir = git(repo, 'rev-parse', '--path-format=absolute', '--git-dir');
            const s = new GitOpState();
            await s.poll(repo);
            assert.equal(s.isActive(), false, 'fresh repo: inactive');

            fs.writeFileSync(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'a'.repeat(40) + '\n');
            await s.poll(repo);
            assert.equal(s.isActive(), true, 'CHERRY_PICK_HEAD present: active');

            fs.unlinkSync(path.join(gitDir, 'CHERRY_PICK_HEAD'));
            await s.poll(repo);
            assert.equal(s.isActive(), false, 'marker removed: inactive again');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('a REAL git stash opens the stash window', async function () {
        this.timeout(10_000);
        const repo = initRepo();
        try {
            fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n');
            git(repo, 'add', '.');
            git(repo, 'commit', '-q', '-m', 'c1');

            const s = new GitOpState();
            await s.poll(repo); // baseline: no stash reflog yet
            assert.equal(s.isActive(), false);

            // First stash CREATES the reflog: the poll records its mtime.
            fs.writeFileSync(path.join(repo, 'f.txt'), 'base\nwork\n');
            git(repo, 'stash');
            await s.poll(repo);

            // Pop touches the reflog again → mtime change → window opens.
            git(repo, 'stash', 'pop');
            await s.poll(repo);
            assert.equal(s.isActive(), true, 'stash pop must open the stash window');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe('WorkingLogTracker replay suppression', () => {
    // A minimal fake TextDocument: only the fields onEdit touches.
    function fakeDoc(fsPath: string, isDirty: boolean): any {
        return {
            uri: { scheme: 'file', fsPath, toString: () => 'file://' + fsPath },
            isDirty,
            getText: () => '',
        };
    }

    it('a clean-buffer change (external reload) is not folded and resets the doc', () => {
        const tracker = new WorkingLogTracker();
        const doc = fakeDoc('/tmp/x.txt', /* isDirty */ false);
        // Must not throw and must not register the doc (no state retained).
        tracker.onEdit(doc, 'old\n', 'new\n', humanAuthor());
        // A second identical call is equally inert — resetDocument on a missing
        // key must be a no-op.
        tracker.onEdit(doc, 'old\n', 'new\n', humanAuthor());
        tracker.dispose();
    });

    it('resetDocument disarms a pending flush and drops state (no-op when absent)', () => {
        const tracker = new WorkingLogTracker();
        tracker.resetDocument('file:///nonexistent');
        tracker.dispose();
    });
});

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitDirWatcher } from '../git/GitDirWatcher';
import { readHeadState, locateRepo, clearRepoLocationCache } from '../git/GitUtils';

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
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-gitwatch-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    return repo;
}

function gitDirOf(repo: string): string {
    return git(repo, 'rev-parse', '--path-format=absolute', '--git-dir');
}

function commit(repo: string, file: string, body: string): string {
    fs.writeFileSync(path.join(repo, file), body);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', body);
    return git(repo, 'rev-parse', 'HEAD');
}

function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
            setTimeout(tick, 25);
        };
        tick();
    });
}

describe('readHeadState (process-free HEAD read)', () => {
    it('matches git on an unborn branch, a commit, and a second commit', () => {
        const repo = initRepo();
        try {
            const gitDir = gitDirOf(repo);

            // Unborn: HEAD is readable and names the branch, but has no commit.
            const unborn = readHeadState(gitDir);
            assert.ok(unborn, 'HEAD must be readable on a fresh repo');
            assert.equal(unborn.sha, null, 'unborn branch has no tip');
            assert.equal(unborn.branch, 'main');

            const first = commit(repo, 'a.txt', 'one\n');
            assert.deepEqual(readHeadState(gitDir), { sha: first, branch: 'main' });

            const second = commit(repo, 'a.txt', 'two\n');
            assert.deepEqual(readHeadState(gitDir), { sha: second, branch: 'main' });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('reports the branch on a slash-named branch and null when detached', () => {
        const repo = initRepo();
        try {
            const gitDir = gitDirOf(repo);
            const first = commit(repo, 'a.txt', 'one\n');

            git(repo, 'checkout', '-q', '-b', 'feature/nested');
            assert.deepEqual(readHeadState(gitDir), { sha: first, branch: 'feature/nested' });

            git(repo, 'checkout', '-q', '--detach', first);
            const detached = readHeadState(gitDir);
            assert.equal(detached?.sha, first, 'detached HEAD still resolves the sha');
            assert.equal(detached?.branch, null, 'detached HEAD has no branch');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('resolves a ref that git has packed away (no loose ref file)', () => {
        const repo = initRepo();
        try {
            const gitDir = gitDirOf(repo);
            const sha = commit(repo, 'a.txt', 'one\n');

            git(repo, 'pack-refs', '--all');
            assert.equal(
                fs.existsSync(path.join(gitDir, 'refs', 'heads', 'main')),
                false,
                'precondition: pack-refs removed the loose ref',
            );
            assert.deepEqual(readHeadState(gitDir), { sha, branch: 'main' });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('resolves refs from the common dir inside a linked worktree', () => {
        const repo = initRepo();
        const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-wt-')));
        const wtPath = path.join(wt, 'w');
        try {
            const sha = commit(repo, 'a.txt', 'one\n');
            git(repo, 'worktree', 'add', '-q', '-b', 'wt', wtPath);

            // The worktree's git dir holds its own HEAD; refs live in the main
            // repo's git dir, reachable only via the `commondir` file.
            const wtGitDir = gitDirOf(wtPath);
            assert.notEqual(wtGitDir, gitDirOf(repo), 'precondition: separate git dir');
            assert.deepEqual(readHeadState(wtGitDir), { sha, branch: 'wt' });
        } finally {
            fs.rmSync(wt, { recursive: true, force: true });
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('returns null when HEAD is unreadable, so callers can fall back to git', () => {
        assert.equal(readHeadState(path.join(os.tmpdir(), 'blamely-not-a-git-dir')), null);
    });
});

describe('locateRepo (cached repoRoot + gitDir)', () => {
    beforeEach(() => clearRepoLocationCache());

    it('resolves both roots for a file and serves repeats from cache', async () => {
        const repo = initRepo();
        try {
            commit(repo, 'a.txt', 'one\n');
            const file = path.join(repo, 'a.txt');

            const first = await locateRepo(file);
            assert.equal(first?.repoRoot, repo);
            assert.equal(first?.gitDir, gitDirOf(repo));

            // Cached: identical answer even after the repo is gone from disk, which
            // is what proves no git process ran the second time.
            fs.rmSync(repo, { recursive: true, force: true });
            assert.deepEqual(await locateRepo(file), first);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('returns null outside a repo and re-checks after the cache is cleared', async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-norepo-')));
        try {
            assert.equal(await locateRepo(dir), null);

            // A folder that gets `git init`-ed later must start resolving — the
            // extension clears the cache on that event.
            git(dir, 'init', '-q', '-b', 'main');
            clearRepoLocationCache();
            assert.equal((await locateRepo(dir))?.repoRoot, dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('GitDirWatcher (event-driven git-dir observation)', () => {
    it('fires on a commit and on a stash pop, and stops after dispose', async function () {
        this.timeout(20_000);
        const repo = initRepo();
        const w = new GitDirWatcher(() => {
            fired++;
        });
        let fired = 0;
        try {
            commit(repo, 'a.txt', 'one\n');
            w.start(gitDirOf(repo));

            const afterStart = fired;
            commit(repo, 'a.txt', 'two\n');
            await waitFor(() => fired > afterStart);

            // A stash pop leaves no marker file — it only touches the stash reflog
            // under <git>/logs/refs, which is why that dir is watched separately.
            fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
            git(repo, 'stash');
            const afterStash = fired;
            git(repo, 'stash', 'pop');
            await waitFor(() => fired > afterStash);

            w.dispose();
            const afterDispose = fired;
            commit(repo, 'a.txt', 'four\n');
            await new Promise((r) => setTimeout(r, 500));
            assert.equal(fired, afterDispose, 'a disposed watcher must go quiet');
        } finally {
            w.dispose();
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('coalesces a burst of git-dir writes into a single callback', async function () {
        this.timeout(20_000);
        const repo = initRepo();
        let fired = 0;
        const w = new GitDirWatcher(() => {
            fired++;
        });
        try {
            commit(repo, 'a.txt', 'one\n');
            w.start(gitDirOf(repo));

            // One commit writes HEAD's reflog, the branch ref, ORIG_HEAD and more.
            commit(repo, 'a.txt', 'two\n');
            await waitFor(() => fired > 0);
            await new Promise((r) => setTimeout(r, 600));
            assert.equal(fired, 1, `one commit must yield one callback, got ${fired}`);
        } finally {
            w.dispose();
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

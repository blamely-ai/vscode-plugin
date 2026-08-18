import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverRepoRoots, repoRootsForFolders, clearRepoLocationCache } from '../git/GitUtils';

function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
        },
    }).trim();
}

/**
 * The one form of a path everything here can be compared in. `fs.realpathSync`
 * is not enough on Windows: it leaves an 8.3 short name (`C:\\Users\\RUNNER~1`)
 * exactly as it found it, while git always answers with the long name, so the
 * temp dir the test made and the repo root git reported never matched. The
 * `.native` variant expands the short name and fixes the separators.
 */
function canon(p: string): string {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return path.normalize(p);
    }
}

function tmpDir(prefix: string): string {
    return canon(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A workspace dir that is NOT a repo, plus the repos created inside it. */
function workspace(...children: string[]): { ws: string; roots: string[] } {
    const ws = tmpDir('blamely-ws-');
    const roots = children.map(rel => {
        const dir = path.join(ws, rel);
        fs.mkdirSync(dir, { recursive: true });
        git(dir, 'init', '-q', '-b', 'main');
        return canon(dir);
    });
    return { ws, roots };
}

describe('discoverRepoRoots (workspace folder opened above its repos)', () => {
    beforeEach(() => clearRepoLocationCache());

    it('inside a repo, returns exactly that repo', async () => {
        const { ws, roots } = workspace('backend');
        try {
            const got = await discoverRepoRoots(roots[0]);
            assert.deepEqual(got.map(canon), [roots[0]]);

            const nested = path.join(roots[0], 'src', 'deep');
            fs.mkdirSync(nested, { recursive: true });
            clearRepoLocationCache();
            const fromDeep = await discoverRepoRoots(nested);
            assert.deepEqual(fromDeep.map(canon), [roots[0]]);
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    it('above sibling clones, returns each of them', async () => {
        const { ws, roots } = workspace('backend', 'frontend');
        try {
            const got = (await discoverRepoRoots(ws)).map(canon).sort();
            assert.deepEqual(got, [...roots].sort());
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    it('skips dependency trees and hidden dirs', async () => {
        const { ws, roots } = workspace('app', 'node_modules/some-dep', '.cache/clone');
        try {
            const got = (await discoverRepoRoots(ws)).map(canon);
            assert.deepEqual(got, [roots[0]]);
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    it('returns nothing when there is no repo at or below the folder', async () => {
        const ws = tmpDir('blamely-ws-');
        try {
            fs.mkdirSync(path.join(ws, 'docs'));
            assert.deepEqual(await discoverRepoRoots(ws), []);
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    it('repoRootsForFolders dedupes repos shared by two folders', async () => {
        const { ws, roots } = workspace('backend', 'frontend');
        try {
            const sub = path.join(roots[0], 'src');
            fs.mkdirSync(sub, { recursive: true });
            const got = (await repoRootsForFolders([ws, roots[0], sub])).map(canon).sort();
            assert.deepEqual(got, [...roots].sort(), 'backend must appear once, not three times');
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });
});

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRepoRoot, repoRelativePath } from '../git/GitUtils';

function git(repo: string, ...args: string[]): string {
    // core.hooksPath= keeps an installed Blamely's global post-commit hook from
    // recording these throwaway repos in the user's real database.
    return execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=', ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
        },
    }).trim();
}

/** A repo at <tmp>/real/repo with README.md and src/deep/a.ts committed, reachable
 *  also as <tmp>/alias/repo through a directory junction (Windows) or symlink. */
function aliasedRepo(): { tmp: string; real: string; alias: string } {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-alias-')));
    const real = path.join(tmp, 'real', 'repo');
    fs.mkdirSync(path.join(real, 'src', 'deep'), { recursive: true });
    git(real, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(real, 'README.md'), 'r\n');
    fs.writeFileSync(path.join(real, 'src', 'deep', 'a.ts'), 'a\n');
    git(real, 'add', '.');
    git(real, 'commit', '-q', '-m', 'c1');
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'alias'), 'junction');
    return { tmp, real, alias: path.join(tmp, 'alias', 'repo') };
}

describe('repoRelativePath (files named as git names them)', () => {
    it('names files reached through an alias of the work tree', async () => {
        const { tmp, real, alias } = aliasedRepo();
        try {
            const root = await getRepoRoot(alias);
            assert.ok(root, 'git resolves the alias to a work tree');
            const cases: Array<[string, string | null]> = [
                [path.join(alias, 'README.md'), 'README.md'], // top level: empty --show-prefix
                [path.join(alias, 'src', 'deep', 'a.ts'), 'src/deep/a.ts'],
                [path.join(alias, 'src', 'deep', 'new.ts'), 'src/deep/new.ts'], // not written yet
                [path.join(alias, 'brand', 'new', 'x.ts'), 'brand/new/x.ts'], // new subtree
                [path.join(real, 'src', 'deep', 'a.ts'), 'src/deep/a.ts'],
                [path.join(tmp, 'elsewhere.ts'), null],
            ];
            for (const [p, want] of cases) {
                assert.equal(await repoRelativePath(root!, p), want, p);
                assert.equal(await repoRelativePath(real, p), want, `${p} (real root)`);
            }
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('is case-insensitive about the drive letter on Windows', async function () {
        if (process.platform !== 'win32') this.skip();
        const { tmp, real } = aliasedRepo();
        try {
            // git reports `C:\…`; VS Code's fsPath is `c:\…`.
            const lower = real[0].toLowerCase() + real.slice(1);
            assert.equal(await repoRelativePath(real, path.join(lower, 'README.md')), 'README.md');
            assert.equal(await repoRelativePath(real, path.join(lower, 'README.md'), false), 'README.md');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('never asks git when askGit is false', async () => {
        const { tmp, real } = aliasedRepo();
        try {
            const other = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-other-'));
            try {
                assert.equal(await repoRelativePath(real, path.join(other, 'x.ts'), false), null);
            } finally {
                fs.rmSync(other, { recursive: true, force: true });
            }
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

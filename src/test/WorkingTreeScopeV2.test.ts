import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LineBlame } from '../blame/BlameMap';
import { collectWorkingTreeState, scopeToUncommittedWorkingTree } from '../cli/CliDataService';
import { toLineBlame, WorkingLogJson } from '../authorship/workingLogBlame';

function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function initRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-scope-'));
    git(repo, 'init', '-q', '-b', 'master');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 't');
    return repo;
}

// A v2 working log for one file marking the given lines AI.
function aiLog(file: string, ...lines: number[]): WorkingLogJson {
    return { file, lines: lines.map((ln) => ({ start: ln, end: ln, author: 'ai', tool: 'claude', gen_type: 'chat' })) };
}

describe('scopeToUncommittedWorkingTree (v2 gutter scoping)', () => {
    it('drops a file that is clean vs HEAD (not in changed/untracked sets)', () => {
        const byFile = new Map<string, LineBlame[]>([['a.txt', toLineBlame(aiLog('a.txt', 1, 2))]]);
        scopeToUncommittedWorkingTree(byFile, new Map(), new Set());
        assert.equal(byFile.has('a.txt'), false, 'clean file must be removed from the map');
    });

    it('keeps only the changed lines of a modified file', () => {
        const byFile = new Map<string, LineBlame[]>([['a.txt', toLineBlame(aiLog('a.txt', 1, 2, 3))]]);
        scopeToUncommittedWorkingTree(byFile, new Map([['a.txt', new Set([2])]]), new Set());
        assert.deepEqual(byFile.get('a.txt')!.map((e) => e.lineNumber), [2]);
    });

    it('keeps every line of an untracked file', () => {
        const byFile = new Map<string, LineBlame[]>([['new.txt', toLineBlame(aiLog('new.txt', 1, 2))]]);
        scopeToUncommittedWorkingTree(byFile, new Map(), new Set(['new.txt']));
        assert.equal(byFile.get('new.txt')!.length, 2);
    });
});

describe('branch-switch stale-changes scenario (Part 1 bug)', () => {
    it('empties the v2 map after committing on a new branch, without deleting the orphaned log', async () => {
        const repo = initRepo();
        try {
            const rel = 'app.txt';
            fs.writeFileSync(path.join(repo, rel), 'l1\nl2\nl3\n');
            git(repo, 'add', rel);
            git(repo, 'commit', '-qm', 'base');
            const m0 = git(repo, 'rev-parse', 'HEAD');

            // Uncommitted AI edit on master; simulate the plugin's on-disk working log.
            fs.writeFileSync(path.join(repo, rel), 'l1\nl2 AI\nl3\nl4 AI\n');
            const wlDir = path.join(repo, '.git', 'blamely', 'working_logs', 'master', m0);
            fs.mkdirSync(wlDir, { recursive: true });
            const wlPath = path.join(wlDir, `${rel}.json`);
            fs.writeFileSync(wlPath, JSON.stringify(aiLog(rel, 2, 4)));

            // Sanity: while uncommitted on master, the log's lines are in the diff.
            let state = await collectWorkingTreeState(repo);
            let byFile = new Map<string, LineBlame[]>([[rel, toLineBlame(aiLog(rel, 2, 4))]]);
            scopeToUncommittedWorkingTree(byFile, state.changedSets, state.untrackedFiles);
            assert.ok((byFile.get(rel) ?? []).length > 0, 'uncommitted edits must still paint on master');

            // checkout -b feature (same SHA) then commit the change on feature.
            git(repo, 'checkout', '-q', '-b', 'feature');
            git(repo, 'commit', '-qam', 'feat on feature');

            // Back on master: working tree is clean; the master/M0 log is orphaned.
            git(repo, 'checkout', '-q', 'master');
            state = await collectWorkingTreeState(repo);
            assert.equal(state.changedSets.size, 0, 'no uncommitted changes on master');
            byFile = new Map<string, LineBlame[]>([[rel, toLineBlame(aiLog(rel, 2, 4))]]);
            scopeToUncommittedWorkingTree(byFile, state.changedSets, state.untrackedFiles);
            assert.equal(byFile.has(rel), false, 'stale orphaned log must NOT paint the gutter/status bar');

            // The fix is display-only: the on-disk log is retained for re-attribution.
            assert.ok(fs.existsSync(wlPath), 'orphaned working log must remain on disk (CLI owns pruning)');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('keeps an untracked new file fully visible on an unborn HEAD', async () => {
        const repo = initRepo();
        try {
            // No commits yet: `git diff HEAD` fails → empty changed sets, file is untracked.
            const rel = 'fresh.txt';
            fs.writeFileSync(path.join(repo, rel), 'a\nb\n');
            const state = await collectWorkingTreeState(repo);
            const byFile = new Map<string, LineBlame[]>([[rel, toLineBlame(aiLog(rel, 1, 2))]]);
            scopeToUncommittedWorkingTree(byFile, state.changedSets, state.untrackedFiles);
            assert.equal((byFile.get(rel) ?? []).length, 2, 'new untracked file keeps all lines');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

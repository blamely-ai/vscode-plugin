import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { baselinePath, loadWorkingLog, update, workingLogPath } from '../authorship/store';
import { getRepoId } from '../cli/repoId';
import { checkoutGitDir } from '../git/GitPaths';
import { getBranchName, runGitCommand } from '../git/GitUtils';
import { CompletionDetector } from '../completion/CompletionDetector';
import { DaemonClient, EditPayload } from '../completion/DaemonClient';
import { CliDataService } from '../cli/CliDataService';
import { BlameMap } from '../blame/BlameMap';
import type * as vscode from 'vscode';

function git(root: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'core.hooksPath=', '-C', root, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    }).trim();
}

describe('linked-worktree attribution', () => {
    let temp: string, main: string, first: string, second: string, sha: string;
    beforeEach(() => {
        temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-worktree-')));
        main = path.join(temp, 'main');
        first = path.join(temp, 'first worktree');
        second = path.join(temp, 'second');
        fs.mkdirSync(main);
        git(main, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(main, 'file.txt'), 'original\n');
        git(main, 'add', '.');
        git(main, 'commit', '-qm', 'initial');
        sha = git(main, 'rev-parse', 'HEAD');
        git(main, 'worktree', 'add', '-q', '-b', 'feature/worktree', first);
        git(main, 'worktree', 'add', '-q', '--detach', second);
    });
    afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

    it('resolves normal, absolute and relative gitfiles to the private Git directory', () => {
        assert.equal(checkoutGitDir(main), path.join(main, '.git'));
        for (const root of [first, second]) {
            const expected = path.normalize(git(root, 'rev-parse', '--absolute-git-dir'));
            assert.equal(checkoutGitDir(root), expected);
            fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.relative(root, expected)}\n`);
            assert.equal(checkoutGitDir(root), expected);
        }
    });

    it('isolates working logs and baselines even with identical branch/base/file keys', async () => {
        const author = { author: 'ai' as const, tool: 'copilot', gen_type: 'chat' };
        for (const [root, tool] of [[main, 'claude'], [first, 'copilot'], [second, 'codex']]) {
            await update(root, 'same', sha, 'file.txt', `${tool}\n`, 'original\n', { ...author, tool });
            const expected = path.join(git(root, 'rev-parse', '--absolute-git-dir'), 'blamely', 'working_logs', 'same', sha);
            assert.equal(workingLogPath(root, 'same', sha, 'file.txt'), path.join(expected, 'file.txt.json'));
            assert.equal(fs.readFileSync(baselinePath(root, 'same', sha, 'file.txt'), 'utf8'), `${tool}\n`);
            assert.equal((await loadWorkingLog(root, 'same', sha, 'file.txt'))?.lines[0].tool, tool);
        }
        assert.equal(fs.statSync(path.join(first, '.git')).isFile(), true);
        assert.equal((await loadWorkingLog(main, 'same', sha, 'file.txt'))?.lines[0].tool, 'claude');
    });

    it('shares repository identity but reads branch/HEAD from the active checkout', async () => {
        assert.equal(await getRepoId(first), await getRepoId(main));
        assert.equal(await getRepoId(second), await getRepoId(main));
        assert.equal(await getBranchName(first), 'feature/worktree');
        assert.equal(await getBranchName(second), null);
        fs.writeFileSync(path.join(first, 'file.txt'), 'worktree commit\n');
        git(first, 'commit', '-qam', 'worktree only');
        assert.notEqual(await runGitCommand(first, 'rev-parse', 'HEAD'), sha);
        assert.equal(await runGitCommand(main, 'rev-parse', 'HEAD'), sha);
    });

    it('sends deletion attribution with canonical identity and the active checkout', async () => {
        const vscode = require('vscode');
        const previousExtensions = vscode.extensions;
        vscode.extensions = { getExtension: () => undefined };
        let captured: EditPayload | undefined;
        const daemon = { send: async (p: EditPayload) => { captured = p; return true; } } as DaemonClient;
        const detector = new CompletionDetector(daemon);
        const internals = detector as unknown as {
            recordDeletedFile(file: string, content: string): Promise<boolean>;
        };
        try {
            fs.unlinkSync(path.join(first, 'file.txt'));
            assert.equal(await internals.recordDeletedFile(path.join(first, 'file.txt'), 'original\n'), true);
            assert.equal(captured?.repo_path, main);
            assert.equal(captured?.worktree_path, first);
            assert.equal(captured?.branch, 'feature/worktree');
            assert.equal(captured?.file_path, 'file.txt');
            assert.equal(captured?.removed_lines?.length, 1);
        } finally {
            detector.dispose();
            vscode.extensions = previousExtensions;
        }
    });

    it('seeds pre-apply snapshots using the checkout, not the canonical identity', async () => {
        const snapshots: string[] = [];
        const daemon = { putSnapshot: async (root: string) => { snapshots.push(root); } } as unknown as DaemonClient;
        const detector = new CompletionDetector(daemon);
        const internals = detector as unknown as {
            maybeStashAgentApplyBaseline(doc: { uri: { fsPath: string }; getText(): string }, content: string,
                changes: { range: { start: { line: number }; end: { line: number } }; text: string }[]): Promise<void>;
        };
        for (const root of [main, first, second]) {
            await internals.maybeStashAgentApplyBaseline({ uri: { fsPath: path.join(root, 'file.txt') },
                getText: () => 'changed\n' }, 'baseline', [{ range: { start: { line: 0 }, end: { line: 1 } }, text: 'changed\n' }]);
        }
        assert.deepEqual(snapshots, [main, first, second]);
        detector.dispose();
    });

    for (const genType of ['completion', 'chat', 'human']) {
        it(`records ${genType} document edits against the active checkout`, async () => {
            const payloads: EditPayload[] = [];
            const snapshots: string[] = [];
            const daemon = {
                send: async (p: EditPayload) => { payloads.push(p); return true; },
                putSnapshot: async (root: string) => { snapshots.push(root); },
            } as unknown as DaemonClient;
            const detector = new CompletionDetector(daemon);
            const internals = detector as unknown as {
                onChange(e: vscode.TextDocumentChangeEvent): Promise<void>;
                docShadows: Map<string, string>;
                inlineSuggestPending: boolean;
                chatApplyPending: boolean;
                clipboardCache: string;
            };
            const file = path.join(first, 'file.txt');
            const content = 'changed content\n';
            const doc = {
                uri: { fsPath: file, scheme: 'file', toString: () => file },
                getText: () => content, lineCount: 2, isDirty: false,
                lineAt: (i: number) => ({ text: content.split('\n')[i] }),
            } as unknown as vscode.TextDocument;
            internals.docShadows.set(file, 'original\n');
            internals.inlineSuggestPending = genType === 'completion';
            internals.chatApplyPending = genType === 'chat';
            internals.clipboardCache = genType === 'human' ? content : '';
            try {
                await internals.onChange({ document: doc, reason: undefined, contentChanges: [{
                    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
                    rangeOffset: 0, rangeLength: 9, text: content,
                }] } as unknown as vscode.TextDocumentChangeEvent);
                assert.equal(payloads.length, 1);
                assert.equal(payloads[0].repo_path, main);
                assert.equal(payloads[0].worktree_path, first);
                assert.equal(payloads[0].gen_type, genType);
                assert.equal(payloads[0].branch, 'feature/worktree');
                if (genType === 'chat') assert.deepEqual(snapshots, [first]);
            } finally {
                detector.dispose();
            }
        });
    }

    it('watches private working logs and HEAD outside the linked checkout', async () => {
        const vscode = require('vscode');
        const previousFolders = vscode.workspace.workspaceFolders;
        const previousWatcher = vscode.workspace.createFileSystemWatcher;
        const previousPattern = vscode.RelativePattern;
        const patterns: { base: string; pattern: string }[] = [];
        const service = new CliDataService(new BlameMap());
        try {
            vscode.workspace.workspaceFolders = [{ uri: { fsPath: first } }];
            vscode.RelativePattern = class {
                constructor(base: string, pattern: string) { patterns.push({ base, pattern }); }
            };
            vscode.workspace.createFileSystemWatcher = () => ({
                onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {},
            });
            await (service as unknown as { setupDataWatchers(): Promise<void> }).setupDataWatchers();
            const gitDir = path.normalize(git(first, 'rev-parse', '--absolute-git-dir'));
            assert.deepEqual(patterns.map(p => ({ base: p.base, pattern: p.pattern })), [
                { base: gitDir, pattern: 'blamely/working_logs/**' },
                { base: gitDir, pattern: 'HEAD' },
            ]);
        } finally {
            service.dispose();
            vscode.workspace.workspaceFolders = previousFolders;
            vscode.workspace.createFileSystemWatcher = previousWatcher;
            vscode.RelativePattern = previousPattern;
        }
    });
});

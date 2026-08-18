import * as vscode from 'vscode';
import { BlameMap } from './blame/BlameMap';
import { CliDataService } from './cli/CliDataService';
import { CliHealthNotifier } from './cli/CliHealthNotifier';
import { CompletionDetector } from './completion/CompletionDetector';
import { DaemonClient } from './completion/DaemonClient';
import { WorkingLogTracker } from './authorship/WorkingLogTracker';
import { StatusBar } from './ui/StatusBar';
import { SidebarProvider } from './ui/SidebarProvider';
import { BlameDecorations } from './ui/BlameDecorations';
import { HistoryProvider } from './ui/HistoryProvider';
import * as GitUtils from './git/GitUtils';
import { gitOpState } from './git/GitOpState';
import { GitDirWatcher } from './git/GitDirWatcher';
import * as Logger from './utils/Logger';

let cliData: CliDataService | undefined;
let statusBar: StatusBar | undefined;
let sidebarProvider: SidebarProvider | undefined;
let blameDecorations: BlameDecorations | undefined;
let historyProvider: HistoryProvider | undefined;
let healthNotifier: CliHealthNotifier | undefined;
let completionDetector: CompletionDetector | undefined;
const disposables: vscode.Disposable[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    Logger.info('Blamely: activating (read-only oobeya-cli consumer)');

    const blameMap = new BlameMap();
    cliData = new CliDataService(blameMap);
    disposables.push(cliData);

    statusBar = new StatusBar(blameMap, cliData);
    disposables.push(statusBar);


    sidebarProvider = new SidebarProvider(blameMap, cliData);
    disposables.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebarProvider)
    );
    disposables.push(sidebarProvider);

    blameDecorations = new BlameDecorations(blameMap, cliData);
    disposables.push(blameDecorations);

    // (Attribution v2 gutter is painted by BlameDecorations from blameMap, which
    // CliDataService.refreshV2 fills via `blamely authorship`. The former GutterV2
    // re-fetched the SAME per-visible authorship and re-painted on every refresh —
    // pure duplication of BlameDecorations + refreshV2 — so it was removed.)

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    historyProvider = new HistoryProvider(workspaceRoot);
    disposables.push(
        vscode.window.registerWebviewViewProvider(HistoryProvider.viewId, historyProvider)
    );

    disposables.push(
        cliData.onRefresh(() => {
            sidebarProvider?.refresh();
            blameDecorations?.updateDecorations();
            void statusBar?.renderAfterRefresh?.();
        })
    );

    disposables.push(
        vscode.commands.registerCommand('blamely.refresh', () => void cliData?.refresh())
    );

    disposables.push(
        vscode.commands.registerCommand('blamely.showBlame', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                void vscode.window.showInformationMessage('No active editor.');
                return;
            }
            blameDecorations?.updateDecorations();
        })
    );

    // Refresh history when HEAD changes (oobeya-cli writes git notes on commit).
    //
    // Event-driven, not polled: GitDirWatcher fires when git writes to the git dir,
    // and the check itself reads HEAD out of that directory instead of shelling out.
    // (This replaced a 3s setInterval that spawned a shell plus `git rev-parse
    // --show-toplevel`, `git rev-parse HEAD` and `git symbolic-ref` on every tick,
    // in every window — which also raced `git commit` for index.lock.)
    let workingLogTracker: WorkingLogTracker | undefined;

    // HEAD/branch are tracked PER REPO: a workspace folder can cover several repos
    // (a multi-root workspace, or — the case that used to be invisible entirely —
    // one folder opened above sibling `backend/`, `frontend/` clones, where
    // `git rev-parse` on the folder finds nothing at all).
    interface WatchedRepo { repoRoot: string; gitDir: string }
    const lastState = new Map<string, { head: string | null; branch: string | null }>();

    // repoRoot + gitDir are the only things still worth a git spawn, and only once:
    // they can't change without the workspace folder changing.
    let repoCache: WatchedRepo[] | null = null;
    const gitDirWatchers = new Map<string, GitDirWatcher>();
    disposables.push({
        dispose: () => {
            for (const w of gitDirWatchers.values()) w.dispose();
            gitDirWatchers.clear();
        },
    });

    const resolveRepos = async (): Promise<WatchedRepo[]> => {
        if (repoCache) return repoCache;
        const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        const repos: WatchedRepo[] = [];
        for (const repoRoot of await GitUtils.repoRootsForFolders(folders)) {
            const gitDir = (
                await GitUtils.runGitCommand(repoRoot, 'rev-parse', '--path-format=absolute', '--git-dir')
            )?.trim();
            if (!gitDir) continue;
            repos.push({ repoRoot, gitDir });
            if (!gitDirWatchers.has(gitDir)) {
                const w = new GitDirWatcher(() => void checkGitState());
                w.start(gitDir);
                gitDirWatchers.set(gitDir, w);
            }
        }
        // Don't cache "nothing found": a folder can be `git init`-ed later.
        if (repos.length === 0) return [];
        repoCache = repos;
        return repoCache;
    };

    const checkRepoState = async (repo: WatchedRepo) => {
        // Refresh the cached git-op / stash-window state the working-log tracker
        // consults synchronously on every change (see GitOpState).
        await gitOpState.poll(repo.repoRoot, repo.gitDir);
        // Falls back to git only if HEAD itself was unreadable — an unborn branch
        // reports a null sha, which the guards below already treat as "no commit".
        const state = GitUtils.readHeadState(repo.gitDir);
        const head = state ? state.sha : await GitUtils.runGitCommand(repo.repoRoot, 'rev-parse', 'HEAD');
        const branch =
            (state ? state.branch : await GitUtils.getBranchName(repo.repoRoot)) ?? 'DETACHED';
        const last = lastState.get(repo.repoRoot) ?? { head: null, branch: null };
        if (head && head !== last.head) {
            const wasInitial = last.head === null;
            lastState.set(repo.repoRoot, { head, branch });
            void cliData?.refresh();
            void historyProvider?.refresh();
            // A real commit (not the first observation at startup) → the trackers'
            // in-memory edits are now history; drop them so the next edit re-baselines
            // against the committed content instead of a stale baseline.
            if (!wasInitial) workingLogTracker?.onHeadChanged();
        } else if (head && last.branch !== null && branch !== last.branch) {
            // Same HEAD SHA, different branch — `git checkout -b feature` (or switching
            // to an existing branch at the same tip). No commit happened, so the
            // in-memory edits are still live; re-persist them under the NEW branch's
            // working-log dir before any commit there reads it, and refresh so the
            // gutter re-scopes to the current branch.
            lastState.set(repo.repoRoot, { head, branch });
            workingLogTracker?.onBranchChanged();
            void cliData?.refresh();
        }
    };

    const checkGitState = async () => {
        for (const repo of await resolveRepos()) {
            await checkRepoState(repo);
        }
    };
    disposables.push(vscode.workspace.onDidSaveTextDocument(() => void checkGitState()));
    // A new folder means a different (or no) repo — re-resolve and re-arm.
    disposables.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            repoCache = null;
            lastState.clear();
            for (const w of gitDirWatchers.values()) w.dispose();
            gitDirWatchers.clear();
            GitUtils.clearRepoLocationCache();
            void checkGitState();
        }),
    );
    void checkGitState(); // prime lastHead/lastBranch and arm the watcher

    healthNotifier = new CliHealthNotifier();
    disposables.push(healthNotifier);
    healthNotifier.start();

    // "Blamely: Show Daemon Status" in the Command Palette. This is how the user
    // checks health on demand after the one-shot startup popup; the status bar folds
    // the daemon state into its tooltip (StatusBar.heartbeat) rather than showing a
    // separate lamp, so the palette is the only entry point.
    disposables.push(
        vscode.commands.registerCommand('blamely.showDaemonStatus', () => {
            void healthNotifier?.showStatusNow();
        }),
    );

    const completionEnabled = vscode.workspace
        .getConfiguration('blamely')
        .get<boolean>('detectInlineCompletion', true);
    if (completionEnabled) {
        const daemonClient = new DaemonClient();
        completionDetector = new CompletionDetector(daemonClient, cliData);
        // Attribution v2 (flag-gated by the blamely.attributionV2 setting inside the
        // tracker): feed every classified change into the working-log tracker. No-op
        // for attribution output until the Phase 3 flip; safe to wire unconditionally.
        const tracker = new WorkingLogTracker();
        workingLogTracker = tracker;
        tracker.register();
        disposables.push(tracker);
        completionDetector.onEditObserved = (doc, prev, next, author) =>
            tracker.onEdit(doc, prev, next, author);
        completionDetector.register();
        disposables.push(completionDetector);
    }

    // blamely.signalInlineAccept is called by the Tab keybinding in package.json
    // (when inlineSuggestionVisible) BEFORE editor.action.inlineSuggest.commit
    // runs. This gives us the exact accept signal without relying on
    // onDidExecuteCommand, which does not fire for keyboard-shortcut commands.
    disposables.push(
        vscode.commands.registerCommand('blamely.signalInlineAccept', () => {
            completionDetector?.signalInlineAccept();
        }),
    );

    await cliData.start();
    blameDecorations?.updateDecorations();
    void statusBar?.renderAfterRefresh();
    void historyProvider.refresh();

    // Blamely can't attribute anything without Git. If the opened folder isn't a
    // repo yet, offer to `git init` it (one-shot, dismissible per folder).
    // There was no git dir to watch until now, so re-resolve to arm the watcher.
    void maybePromptGitInit(context, () => {
        repoCache = null;
        GitUtils.clearRepoLocationCache();
        void checkGitState();
        void cliData?.refresh();
    });

    disposables.push(
        vscode.window.onDidChangeWindowState((e) => {
            if (e.focused) {
                // Catches git run in an external terminal on filesystems where
                // fs.watch doesn't deliver events (network shares, bind mounts).
                void checkGitState();
                void cliData?.refresh();
            }
        }),
    );

    for (const d of disposables) {
        context.subscriptions.push(d);
    }
}

/**
 * Notify the user when an opened workspace folder isn't a Git repository and
 * offer to initialize one — Blamely attributes lines via Git, so it's inert
 * until a repo exists. Honors the `blamely.promptGitInit` setting and a
 * per-folder "Don't Ask Again" choice persisted in workspaceState.
 */
async function maybePromptGitInit(
    context: vscode.ExtensionContext,
    onInitialized: () => void,
): Promise<void> {
    if (!vscode.workspace.getConfiguration('blamely').get<boolean>('promptGitInit', true)) {
        return;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const fsPath = folder.uri.fsPath;
        const dismissKey = `blamely.gitInitDismissed:${fsPath}`;
        if (context.workspaceState.get<boolean>(dismissKey)) continue;
        // Already inside a repo (this folder or a parent) — or a workspace folder
        // holding repos BELOW it, which Blamely now attributes normally → nothing
        // to do. `git init` here would only create a pointless outer repo.
        if ((await GitUtils.discoverRepoRoots(fsPath)).length > 0) continue;

        const choice = await vscode.window.showInformationMessage(
            `Blamely: "${folder.name}" isn't a Git repository yet. Blamely needs Git to track who wrote each line.`,
            'Initialize Git',
            "Don't Ask Again",
        );
        if (choice === 'Initialize Git') {
            const out = await GitUtils.runGitCommand(fsPath, 'init');
            if (out === null) {
                void vscode.window.showErrorMessage(
                    `Blamely: failed to initialize a Git repository in "${folder.name}". Is Git installed and on PATH?`,
                );
            } else {
                void vscode.window.showInformationMessage(
                    `Blamely: initialized a Git repository in "${folder.name}".`,
                );
                onInitialized();
            }
        } else if (choice === "Don't Ask Again") {
            void context.workspaceState.update(dismissKey, true);
        }
    }
}

export function deactivate(): void {
    for (const d of disposables) {
        d.dispose();
    }
    disposables.length = 0;
    cliData = undefined;
    statusBar = undefined;
    sidebarProvider = undefined;
    blameDecorations = undefined;
    historyProvider = undefined;
    healthNotifier = undefined;
    completionDetector = undefined;
    Logger.dispose();
}

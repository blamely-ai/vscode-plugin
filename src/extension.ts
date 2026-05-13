import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore } from './store/TraceStore';
import { BlameMap } from './blame/BlameMap';
import * as BlameSerializer from './blame/BlameSerializer';
import { CompletionInterceptor } from './providers/CompletionInterceptor';
import { ChangeTracker } from './providers/ChangeTracker';
import * as ReportYaml from './report/ReportYaml';
import * as GitHookInstaller from './git/GitHookInstaller';
import { CommitListener } from './git/CommitListener';
import * as GitUtils from './git/GitUtils';
import { LineBlame } from './blame/BlameMap';
import { StatusBar } from './ui/StatusBar';
import { SidebarProvider } from './ui/SidebarProvider';
import { BlameDecorations } from './ui/BlameDecorations';
import { ChatParticipant } from './providers/ChatParticipant';
import { HistoryProvider } from './ui/HistoryProvider';
import * as Logger from './utils/Logger';
import * as AiContextExtractor from './utils/AiContextExtractor';
import {
    blameFileKey,
    collectFileUrisFromGitCommandArgs,
    normalizeLoadedBlameKey,
    workspaceFolderInRepo,
    workspaceFoldersUnderRepo,
    workspaceRootForBlameKey,
} from './utils/WorkspacePaths';
import * as BlamelyRepoPaths from './store/BlamelyRepoPaths';
import { BLAMELY_REPO_DETECTOR_FILENAME } from './utils/Platform';
import { extractPossibleChatPrompt } from './utils/chatPromptFromArgs';
import { chatPanelSignal } from './utils/chatPanelSignal';
import { tabLooksAiChat } from './utils/substantialChatTabPoke';

/** Built-in Git "clean all" for the repo's working tree (SCM Discard All Changes). */
const FULL_DISCARD_GIT_COMMANDS = new Set(['git.cleanAll']);

/** Stash pop/apply — editor updates often run before `repo.state.onDidChange`; open session returns to open/. */
const GIT_STASH_POP_APPLY_COMMANDS = new Set([
    'git.stashPop',
    'git.stashPopLatest',
    'git.stashPopEditor',
    'git.stashApply',
    'git.stashApplyLatest',
    'git.stashApplyEditor',
]);

/** Stash creation — park open session under stash/ (same tree as git stash pop restore). */
const GIT_STASH_PUSH_COMMANDS = new Set([
    'git.stash',
    'git.stashIncludeUntracked',
    'git.stashExcludeUntracked',
    'git.stashUntracked',
    'vscode.git.stageAndStash',
]);

let traceStore: TraceStore;
let blameMap: BlameMap;
let statusBar: StatusBar;
let sidebarProvider: SidebarProvider;
let blameDecorations: BlameDecorations;
let completionInterceptor: CompletionInterceptor;
let changeTracker: ChangeTracker;
let commitListener: CommitListener;
let chatParticipant: ChatParticipant;
let expirationTimer: NodeJS.Timeout;
/** One-shot notice when traffic logging is on but the host lacks command execution events. */
let loggedChatTrafficNoExecuteCommand = false;

function isLogChatPanelMessages(): boolean {
    try {
        return !!vscode.workspace.getConfiguration('blamely').get<boolean>('logChatPanelMessages');
    } catch {
        return false;
    }
}

function collapseSelectionAfterAccept(): void {
    setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return;
        const end = editor.selection.end;
        editor.selection = new vscode.Selection(end, end);
    }, 0);
}

function tryRepoRootFromGitRepositoryArg(arg: unknown): string | null {
    if (!arg || typeof arg !== 'object') {
        return null;
    }
    const rec = arg as Record<string, unknown>;
    const rootUri = rec['rootUri'];
    if (rootUri && typeof rootUri === 'object' && 'fsPath' in rootUri) {
        return path.normalize((rootUri as vscode.Uri).fsPath);
    }
    const root = rec['root'];
    if (typeof root === 'string' && root.length > 0) {
        return path.normalize(root);
    }
    return null;
}

/** Repo root from built-in Git `Repository` argument, or unique roots for every workspace folder. */
async function resolveGitRepoRootsFromOptionalRepositoryArg(arg0: unknown): Promise<string[]> {
    const rr = arg0 != null ? tryRepoRootFromGitRepositoryArg(arg0) : null;
    if (rr) {
        return [rr];
    }
    const roots: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const r = await GitUtils.getRepoRoot(folder.uri.fsPath);
        if (r) {
            roots.push(r);
        }
    }
    return [...new Set(roots)];
}

async function removeOpenSessionsAfterFullDiscard(
    command: string,
    args: unknown[] | undefined,
    refresh: () => void
): Promise<void> {
    try {
        const repoRoot = args?.[0] != null ? tryRepoRootFromGitRepositoryArg(args[0]) : null;
        if (repoRoot) {
            await BlameSerializer.clearCurrentBranchSnapshots(repoRoot);
        } else {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
                const api = git.getAPI(1);
                for (const repo of api.repositories ?? []) {
                    const root = repo.rootUri?.fsPath;
                    if (root) {
                        await BlameSerializer.clearCurrentBranchSnapshots(root);
                    }
                }
            }
        }
        refresh();
        Logger.info(`Blamely: cleared branch snapshots after ${command}`);
    } catch (err) {
        Logger.warn(`clearCurrentBranchSnapshots on discard: ${err}`);
    }
}

async function forEachWorkspaceGitRepo(cb: (repoRoot: string) => Promise<void>): Promise<void> {
    const seen = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const r = await GitUtils.getRepoRoot(folder.uri.fsPath);
        const norm = r ? path.normalize(r) : null;
        if (norm && !seen.has(norm)) {
            seen.add(norm);
            await cb(norm);
        }
    }
}

/** True for `git.stash*` that creates stash but is not pop/apply variants. */
function isLikelyStashCreationCommand(commandId: string): boolean {
    const id = commandId.toLowerCase();
    if (!id.startsWith('git.stash')) {
        return false;
    }
    if (
        id.includes('pop') ||
        id.includes('apply') ||
        id.includes('drop') ||
        id.includes('clear')
    ) {
        return false;
    }
    return true;
}

/** Commands that may relate to chat / agent / apply (used for selective [CHAT-DEBUG] logging). */
function commandLooksChatRelated(commandId: string): boolean {
    const id = commandId.toLowerCase();
    return (
        id.includes('chat') ||
        id.includes('composer') ||
        id.includes('copilot') ||
        id.includes('inlinechat') ||
        id.includes('agent') ||
        id.startsWith('cursor.') ||
        id.includes('anthropic') ||
        id.includes('claude') ||
        id.includes('cline') ||
        id.includes('workbench.action.chat') ||
        id.startsWith('composer.') ||
        id.includes('inlineedit') ||
        id.includes('inline-edit') ||
        id.includes('multidiff') ||
        id.includes('multi-diff')
    );
}

function looksLikeApplyOrKeepIntent(commandId: string): boolean {
    const id = commandId.toLowerCase();
    return (
        id.includes('apply') ||
        id.includes('accept') ||
        id.includes('keep') ||
        id.includes('insert') ||
        id.includes('approve') ||
        id.includes('commit')
    );
}

/** Short string for onDidExecuteCommand arguments (chat / apply debugging). */
function summarizeChatCommandArgs(args: unknown[] | undefined): string {
    if (args === undefined || args.length === 0) {
        return '(no args)';
    }
    try {
        const parts: string[] = [];
        const n = Math.min(args.length, 5);
        for (let i = 0; i < n; i++) {
            const a = args[i];
            if (a === undefined || a === null) {
                parts.push(`arg${i}:null`);
                continue;
            }
            if (typeof a === 'object' && a !== null && 'fsPath' in a && 'scheme' in a) {
                parts.push(`arg${i}:Uri ${String((a as vscode.Uri).fsPath).slice(0, 160)}`);
                continue;
            }
            if (typeof a === 'object' && a !== null && 'resourceUri' in a) {
                const ru = (a as { resourceUri?: { fsPath?: string } }).resourceUri;
                parts.push(`arg${i}:resourceUri=${ru?.fsPath ?? '?'}`);
                continue;
            }
            const s = typeof a === 'object' ? JSON.stringify(a).slice(0, 160) : String(a).slice(0, 160);
            parts.push(`arg${i}:${s}`);
        }
        if (args.length > n) {
            parts.push(`(+${args.length - n} more)`);
        }
        return parts.join(' | ');
    } catch {
        return '(unreadable args)';
    }
}

/** Debug Console: chat / composer AI hooks (filter `[Blamely][chat-panel]`). */
function logChatPanelConsole(phase: string, payload: Record<string, unknown>): void {
    console.log('[Blamely][chat-panel]', { phase, ...payload });
}

/** When the active editor tab looks like Chat/Composer/Agent — soft AI attribution window for the next edits. */
function pokeSoftAiWindowFromChatTabs(changeTracker: ChangeTracker): void {
    try {
        for (const g of vscode.window.tabGroups.all) {
            for (const tab of g.tabs) {
                if (tab?.isActive && tabLooksAiChat(tab)) {
                    const provider = AiContextExtractor.detectProvider();
                    const label = typeof tab.label === 'string' ? tab.label.toLowerCase() : '';
                    const longAgentSurface = ['agent', 'composer', 'cloud', 'background'].some(h => label.includes(h));
                    changeTracker.armChatTrafficInterceptWindow(
                        longAgentSurface ? 20_000 : 12_000,
                        provider
                    );
                    chatPanelSignal('poke-active-chat-tab', {
                        tabLabel: typeof tab.label === 'string' ? tab.label : '?',
                        durationMs: longAgentSurface ? 20_000 : 12_000,
                        provider: provider ?? null,
                    });
                    Logger.chatDebug(
                        `pokeSoftAiWindow: activeTab="${typeof tab.label === 'string' ? tab.label : '?'}" ` +
                            `durationMs=${longAgentSurface ? 20_000 : 12_000} provider=${provider ?? 'null'}`
                    );
                    return;
                }
            }
        }
    } catch {
        /* Tab API unavailable in minimal hosts */
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('[blamely] activate() called');

    try {
        Logger.info('Blamely extension activating...');

        const workspaceRoot = getWorkspaceRoot();
        console.log('[blamely] workspaceRoot:', workspaceRoot);

        if (!workspaceRoot) {
            const msg = 'Blamely: No workspace folder open — a folder is required';
            Logger.warn(msg);
            vscode.window.showWarningMessage(msg);
            return;
        }

        await initializeRepoPersistenceDirs();

        void (async () => {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                const root = folder.uri.fsPath;
                if (!(await GitUtils.isGitRepo(root))) {
                    continue;
                }
                if (!(await GitUtils.getLatestCommitSha(root))) {
                    Logger.info(
                        `Blamely: folder "${folder.name}" is a Git repo with no commits yet — ` +
                            '`git blame ... HEAD` fails until the first commit exists (unrelated Blamely errors may appear from IDE Git features).'
                    );
                }
            }
        })();

        // Initialize core state
        traceStore = new TraceStore();
        blameMap = new BlameMap();

        // Load persisted state for the current branch.
        // Do not filter by "currently dirty files": users expect tracked attribution to survive
        // IDE restart and branch switches.
        const workspaceRoots = getWorkspaceFolderRoots();
        if (workspaceRoots.length === 1) {
            await traceStore.load(workspaceRoots[0]);
        } else {
            await traceStore.mergeLoadFromWorkspaceRoots(workspaceRoots);
        }
        let loadedBlameFiles = 0;
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const savedBlame = await BlameSerializer.loadAll(folder.uri.fsPath);
            for (const [file, entries] of savedBlame) {
                const key = normalizeLoadedBlameKey(file, folder);
                blameMap.setFileBlame(key, entries);
                loadedBlameFiles++;
            }
        }
        if (loadedBlameFiles > 0) {
            Logger.info(`Loaded persisted blame for ${loadedBlameFiles} file snapshot(s)`);
        }

        // Snapshots may be longer than buffers after stash/checkout/restart — trim to open editors.
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.uri.scheme !== 'file') {
                continue;
            }
            const k = blameFileKey(ed.document.uri);
            blameMap.clipLinesToDocumentLength(k, ed.document.lineCount);
        }

        // Initialize UI
        statusBar = new StatusBar(blameMap);
        sidebarProvider = new SidebarProvider(blameMap, traceStore);
        blameDecorations = new BlameDecorations(blameMap);

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebarProvider)
        );

        const historyProvider = new HistoryProvider(workspaceRoot);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(HistoryProvider.viewId, historyProvider)
        );

        // Delayed refresh after loading persisted blame (matches IntelliJ 500ms post-restore alarm)
        setTimeout(() => {
            statusBar.update();
            sidebarProvider.refresh();
            blameDecorations.updateDecorations();
        }, 500);

        // Callback when blame is updated
        const onBlameUpdated = () => {
            statusBar.update();
            sidebarProvider.refresh();
            blameDecorations.updateDecorations();
        };

        // Initialize providers
        completionInterceptor = new CompletionInterceptor(traceStore);
        changeTracker = new ChangeTracker(traceStore, blameMap, onBlameUpdated);
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === 'file') {
                changeTracker.seedDocSnapshot(doc);
            }
        }
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.uri.scheme === 'file') {
                changeTracker.seedDocSnapshot(ed.document);
            }
        }
        context.subscriptions.push(
            vscode.window.onDidChangeVisibleTextEditors(() => {
                for (const ed of vscode.window.visibleTextEditors) {
                    if (ed.document.uri.scheme === 'file') {
                        changeTracker.seedDocSnapshot(ed.document);
                    }
                }
            })
        );
        AiContextExtractor.invalidateAiCodingAssistantHostCache();
        const copilotReadyInvalidate1 = setTimeout(() => AiContextExtractor.invalidateAiCodingAssistantHostCache(), 2500);
        const copilotReadyInvalidate2 = setTimeout(() => AiContextExtractor.invalidateAiCodingAssistantHostCache(), 8000);
        context.subscriptions.push({
            dispose: () => {
                clearTimeout(copilotReadyInvalidate1);
                clearTimeout(copilotReadyInvalidate2);
            },
        });
        context.subscriptions.push(
            vscode.extensions.onDidChange(() => AiContextExtractor.invalidateAiCodingAssistantHostCache())
        );
        // Suppress the "clean document → external VCS" guard briefly so auto-formats / LSP
        // rewrites that arrive immediately after restore do not clobber loaded AI blame.
        if (loadedBlameFiles > 0) {
            changeTracker.setPostRestoreGrace(5000);
        }

        // Periodic blame auto-save: deactivate() may not run on crash/kill, so flush every 30s.
        const blameAutosaveInterval = setInterval(async () => {
            try {
                if (!blameMap) {
                    return;
                }
                for (const [filePath, entries] of blameMap.getRawMap()) {
                    if (entries.length === 0 || changeTracker.isSnapshotPersistSuppressed(filePath)) {
                        continue;
                    }
                    const root = workspaceRootForBlameKey(filePath);
                    if (root) {
                        await BlameSerializer.save(root, filePath, entries);
                    }
                }
            } catch (err) {
                Logger.warn(`Periodic blame autosave failed: ${err}`);
            }
        }, 30_000);
        context.subscriptions.push({ dispose: () => clearInterval(blameAutosaveInterval) });

        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (doc.uri.scheme !== 'file') {
                    return;
                }
                changeTracker.seedDocSnapshot(doc);
                const k = blameFileKey(doc.uri);
                if (blameMap.clipLinesToDocumentLength(k, doc.lineCount)) {
                    onBlameUpdated();
                }
            })
        );

        // Initialize Git integration
        commitListener = new CommitListener(blameMap, traceStore, onBlameUpdated, ({ repoRoot, gitNoteWritten }) => {
            historyProvider.notifyPostCommit({ gitNoteWritten });
            if (gitNoteWritten) {
                void traceStore.resetTraceAfterBlamelyNote(repoRoot);
            }
        });

        // Initialize Chat Participant for prompt/model capture
        chatParticipant = new ChatParticipant(traceStore, blameMap, onBlameUpdated);

        // Detect VCS rollback / git checkout / branch switch / push via Git extension
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
                const api = git.getAPI(1);
                if (api && api.repositories.length > 0) {
                    for (const repo of api.repositories) {
                        let lastBranch: string | undefined = repo.state.HEAD?.name;
                        let lastAhead: number | undefined = repo.state.HEAD?.ahead;
                        let lastWorktreeFp = '';
                        const repoRoot = repo.rootUri.fsPath;

                        repo.state.onDidChange(() => {
                            const currentBranch = repo.state.HEAD?.name;
                            const currentAhead: number | undefined = repo.state.HEAD?.ahead;
                            const newFp = gitWorktreeFingerprint(repo);

                            if (lastBranch && currentBranch && currentBranch !== lastBranch) {
                                const oldBranch = lastBranch;
                                const newBranch = currentBranch;
                                Logger.info(`Branch switch in ${repoRoot}: ${oldBranch} -> ${newBranch}`);
                                changeTracker.notifyExternalVcsApply(20_000);
                                void (async () => {
                                    for (const folder of vscode.workspace.workspaceFolders ?? []) {
                                        if (!workspaceFolderInRepo(repoRoot, folder.uri.fsPath)) {
                                            continue;
                                        }
                                        const subset = filterBlameMapForFolder(blameMap, folder);
                                        try {
                                            await BlameSerializer.saveAllToBranch(folder.uri.fsPath, oldBranch, subset);
                                        } catch (err) {
                                            Logger.warn(`Failed to persist branch snapshot for ${oldBranch}: ${err}`);
                                        }
                                    }
                                    try {
                                        await traceStore.onGitBranchSwitch(repoRoot, oldBranch, newBranch);
                                    } catch (err) {
                                        Logger.warn(`Trace session branch switch failed: ${err}`);
                                    }
                                    try {
                                        await reloadBlameMapsForRepoAfterBranchSwitch(repoRoot);
                                        Logger.info(`Reloaded Blamely snapshots for branch ${newBranch}`);
                                    } catch (err) {
                                        Logger.warn(`Failed to reload blame after branch switch: ${err}`);
                                    }
                                    changeTracker.notifyRollback();
                                })();
                            } else if (
                                lastWorktreeFp !== '' &&
                                newFp !== lastWorktreeFp &&
                                currentBranch
                            ) {
                                // Must run synchronously so stash/apply document events see the grace window first.
                                changeTracker.notifyExternalVcsApply(60_000);
                                Logger.info(
                                    `Git worktree update in ${repoRoot}; clip blame to open buffers (keeping snapshots for reindex)`
                                );
                                void (async () => {
                                    try {
                                        clipVisibleEditorsUnderRepo(repoRoot);
                                        onBlameUpdated();
                                    } catch (err) {
                                        Logger.warn(`Worktree blame sync failed: ${err}`);
                                    }
                                })();
                            }

                            if (lastAhead !== undefined && lastAhead > 0 &&
                                currentAhead !== undefined && currentAhead < lastAhead) {
                                Logger.info(`Push detected (ahead ${lastAhead} -> ${currentAhead}), pushing blamely notes`);
                                GitUtils.pushGitNotes(repoRoot).catch(err =>
                                    Logger.warn(`Auto-push notes after push failed: ${err}`)
                                );
                            }

                            lastBranch = currentBranch;
                            lastAhead = currentAhead;
                            lastWorktreeFp = newFp;
                        });
                    }
                }
            }
        } catch (err) {
            Logger.warn(`Could not wire Git extension listeners: ${err}`);
        }

        // Listen for git.clean / git.checkout commands as rollback triggers
        const rollbackCommands = [
            'git.clean',
            'git.cleanAll',
            'git.cleanAllTracked',
            'git.cleanAllUntracked',
            'git.checkout',
            'git.undoCommit',
        ];
        for (const cmd of rollbackCommands) {
            try {
                context.subscriptions.push(
                    vscode.commands.registerCommand(`blamely.after.${cmd}`, () => {
                        changeTracker.notifyRollback();
                        if (FULL_DISCARD_GIT_COMMANDS.has(cmd)) {
                            void removeOpenSessionsAfterFullDiscard(cmd, undefined, onBlameUpdated);
                        }
                    })
                );
            } catch {
                // Command may already be registered
            }
        }

        // Optional `blamely.intercept.<cmd>` commands: only run when a keybinding/menu invokes them.
        // Chat/Composer "Apply" / "Keep" in the UI executes the real command ID — attribution uses
        // `onDidExecuteCommand` + an immediate debounce flush (see ChangeTracker.flushDeferredClassificationAfterApplyCommand).
        const aiCommandsToWatch = [
            ...AiContextExtractor.AI_COMMAND_PATTERNS.chatPanel,
            ...AiContextExtractor.AI_COMMAND_PATTERNS.chatInline,
        ];
        for (const cmd of aiCommandsToWatch) {
            try {
                const wrapperId = `blamely.intercept.${cmd}`;
                context.subscriptions.push(
                    vscode.commands.registerCommand(wrapperId, async () => {
                        chatPanelSignal('intercept-wrapper-start', { wrappedCommand: cmd, wrapperId });
                        changeTracker.recordChatApplyCommandObserved(cmd);
                        const interactionType = AiContextExtractor.detectInteractionType(cmd);
                        const ctx = await AiContextExtractor.extract(cmd);
                        const duration = AiContextExtractor.getAiWindowDuration(interactionType);
                        changeTracker.markNextChangeAsAi(duration, null, ctx.model, ctx.provider, interactionType);
                        logChatPanelConsole('intercept-wrapper-before-apply', {
                            wrappedCommand: cmd,
                            interactionType,
                            provider: ctx.provider,
                            model: ctx.model,
                            durationMs: duration,
                        });
                        Logger.chatDebug(
                            `wrapper intercept → markNextChangeAsAi: cmd=${cmd} durationMs=${duration} ` +
                                `type=${interactionType ?? 'null'} model=${ctx.model ?? 'null'}`
                        );
                        Logger.info(`AI command intercepted: ${cmd} (type=${interactionType}, model=${ctx.model})`);
                        try {
                            await vscode.commands.executeCommand(cmd);
                        } catch { /* command may not exist */ }
                        changeTracker.flushDeferredClassificationAfterApplyCommand();
                        chatPanelSignal('intercept-wrapper-done', { wrappedCommand: cmd });
                    })
                );
            } catch {
                // Command already registered or unavailable
            }
        }

        chatPanelSignal('chat-panel-intercept-hooks-installed', {
            interceptWrapperCommandsRegistered: aiCommandsToWatch.length,
            contributedDefaultKeys: [
                'ctrl+shift+enter / cmd+shift+enter → blamely.intercept.github.copilot.chat.apply',
                'alt+enter → blamely.intercept.workbench.action.chat.apply',
            ],
            note: 'Stock VS Code has no chat Apply command listener; shortcuts route Apply through Blamely first.',
        });
        console.log(
            '[Blamely][chat-traffic] Chat-panel intercept hooks installed: ' +
                `${aiCommandsToWatch.length} blamely.intercept.* wrappers. Default keys: Cmd/Ctrl+Shift+Enter → Copilot apply, Alt+Enter → workbench chat apply (override in Keyboard Shortcuts if needed).`
        );

        // Real chat/apply/keep commands. Note: vscode.commands.onDidExecuteCommand is not part of the
        // stable VS Code extension API — it is absent in stock VS Code (including Copilot Chat). Some
        // forks may patch it in; when missing, attribution relies on ChangeTracker heuristics + intercept wrappers.
        type CommandsWithExecuteListener = typeof vscode.commands & {
            onDidExecuteCommand?: (
                listener: (e: { command: string; arguments?: unknown[] }) => void
            ) => vscode.Disposable;
        };
        const commandsWithListener = vscode.commands as CommandsWithExecuteListener;
        
        if (typeof commandsWithListener.onDidExecuteCommand === 'function') {
            context.subscriptions.push(
                commandsWithListener.onDidExecuteCommand((e) => {
                    if (commandLooksChatRelated(e.command)) {
                        Logger.chatDebug(`onDidExecuteCommand: ${e.command} | ${summarizeChatCommandArgs(e.arguments)}`);
                    }
                    if (GIT_STASH_POP_APPLY_COMMANDS.has(e.command)) {
                        changeTracker.notifyExternalVcsApply(60_000);
                        return;
                    }
                    if (GIT_STASH_PUSH_COMMANDS.has(e.command) || isLikelyStashCreationCommand(e.command)) {
                        changeTracker.notifyExternalVcsApply(60_000);
                        return;
                    }
                    if (e.command === 'git.clean') {
                        changeTracker.notifyRollback();
                        const uris = collectFileUrisFromGitCommandArgs(e.arguments);
                        void changeTracker.removePersistedSnapshotsForFileUris(uris);
                        return;
                    }
                    if (e.command === 'git.cleanAllTracked') {
                        changeTracker.notifyRollback();
                        void (async () => {
                            const roots = await resolveGitRepoRootsFromOptionalRepositoryArg(e.arguments?.[0]);
                            await changeTracker.clearPersistedSnapshotsForRepoRoots(roots);
                        })();
                        return;
                    }
                    if (FULL_DISCARD_GIT_COMMANDS.has(e.command)) {
                        changeTracker.notifyRollback();
                        void removeOpenSessionsAfterFullDiscard(e.command, e.arguments, onBlameUpdated);
                        return;
                    }
                    if (e.command === 'git.checkout' || e.command === 'git.undoCommit') {
                        changeTracker.notifyRollback();
                        return;
                    }
                    if (AiContextExtractor.isChatSendCommand(e.command)) {
                        changeTracker.recordChatRequestSent();
                        chatPanelSignal('executeCommand-chat-send', {
                            command: e.command,
                            argCount: e.arguments?.length ?? 0,
                        });
                        console.log('[Blamely][chat-traffic] executeCommand chat-send', {
                            command: e.command,
                            argCount: e.arguments?.length ?? 0,
                        });
                        logChatPanelConsole('chat-send-command', {
                            command: e.command,
                            argsSummary: summarizeChatCommandArgs(e.arguments),
                            argCount: e.arguments?.length ?? 0,
                        });
                        Logger.chatDebug(`onDidExecuteCommand chat send: ${e.command}`);
                        if (isLogChatPanelMessages()) {
                            const prompt = extractPossibleChatPrompt(e.arguments);
                            const bits = [`Blamely [chat-send] command=${e.command}`];
                            if (prompt) {
                                bits.push(`prompt=${JSON.stringify(prompt)}`);
                            } else {
                                bits.push(
                                    'prompt=(not present in command args — host may omit text from execution events)'
                                );
                            }
                            bits.push(`args=${summarizeChatCommandArgs(e.arguments)}`);
                            console.log(bits.join(' | '));
                        }
                        return;
                    }
                    if (AiContextExtractor.matchesTrackedAiRejectCommand(e.command)) {
                        changeTracker.resetAiInterceptState();
                        chatPanelSignal('executeCommand-ai-reject-reset', { command: e.command });
                        Logger.info(`AI intercept reset after reject/discard: ${e.command}`);
                        return;
                    }
                    if (!AiContextExtractor.matchesTrackedAiApplyCommand(e.command)) {
                        if (
                            commandLooksChatRelated(e.command) &&
                            looksLikeApplyOrKeepIntent(e.command)
                        ) {
                            chatPanelSignal('executeCommand-chat-apply-untracked-id', {
                                command: e.command,
                                hint: 'Consider adding to trackedAiApplyCommands',
                            });
                            Logger.chatDebug(
                                `NOT in tracked apply list (edits may count as Human): ${e.command}. ` +
                                    `Report this id to Blamely or add under trackedAiApplyCommands / AiContextExtractor.`
                            );
                        }
                        return;
                    }
                    if (
                        AiContextExtractor.isInlineGhostSuggestionCommand(e.command) &&
                        !vscode.workspace.getConfiguration('blamely').get<boolean>(
                            'attributeInlineGhostCompletion',
                            true
                        )
                    ) {
                        return;
                    }
                    changeTracker.recordChatApplyCommandObserved(e.command);
                    // Mark synchronously to avoid race condition: the text change event
                    // can arrive before an async handler resolves, causing AI edits to be
                    // attributed as HUMAN. Model is resolved asynchronously afterwards.
                    const interactionType = AiContextExtractor.detectInteractionType(e.command);
                    const provider = AiContextExtractor.detectProvider();
                    const duration = AiContextExtractor.getAiWindowDuration(interactionType);
                    chatPanelSignal('executeCommand-chat-apply', {
                        command: e.command,
                        interactionType: interactionType ?? null,
                        provider: provider ?? null,
                        durationMs: duration,
                    });
                    console.log('[Blamely][chat-traffic] executeCommand chat-apply', {
                        command: e.command,
                        interactionType: interactionType ?? null,
                        durationMs: duration,
                        provider: provider ?? null,
                    });
                    changeTracker.markNextChangeAsAi(duration, null, null, provider, interactionType);
                    changeTracker.flushDeferredClassificationAfterApplyCommand();
                    logChatPanelConsole('chat-apply-command', {
                        command: e.command,
                        interactionType,
                        provider,
                        durationMs: duration,
                        argsSummary: summarizeChatCommandArgs(e.arguments),
                        note:
                            'LLM response body is not available here — only Apply/Keep to editor; edits stream via handleChange.',
                    });
                    Logger.chatDebug(
                        `tracked apply → markNextChangeAsAi: command=${e.command} durationMs=${duration} ` +
                            `interactionType=${interactionType ?? 'null'} provider=${provider ?? 'null'}`
                    );
                    Logger.info(`AI command observed: ${e.command} (type=${interactionType})`);
                    if (isLogChatPanelMessages()) {
                        console.log(
                            `Blamely [chat-apply] command=${e.command} interactionType=${interactionType ?? 'null'} | ` +
                                'assistant reply text is not exposed to extensions — logging Apply/Keep only; ' +
                                `args=${summarizeChatCommandArgs(e.arguments)}`
                        );
                    }
                    AiContextExtractor.detectModel().then(model => {
                        if (model) {
                            changeTracker.markNextChangeAsAi(duration, null, model, provider, interactionType);
                            Logger.chatDebug(`detectModel → extend window: model=${model}`);
                            changeTracker.flushDeferredClassificationAfterApplyCommand();
                            logChatPanelConsole('chat-apply-resolved-model', {
                                command: e.command,
                                model,
                                provider,
                                interactionType,
                            });
                            if (isLogChatPanelMessages()) {
                                console.log(
                                    `Blamely [chat-apply-model] command=${e.command} resolvedModel=${JSON.stringify(model)}`
                                );
                            }
                            console.log('[Blamely][chat-traffic] executeCommand chat-apply model resolved', {
                                command: e.command,
                                model,
                            });
                            chatPanelSignal('executeCommand-chat-apply-model-resolved', {
                                command: e.command,
                                model,
                                provider,
                                interactionType,
                            });
                        }
                    });
                })
            );
            chatPanelSignal('listener', { onDidExecuteCommand: 'subscribed' });
            Logger.info('Subscribed to onDidExecuteCommand for chat/apply attribution');
        } else {
            chatPanelSignal('listener', {
                onDidExecuteCommand: 'unavailable',
                appName: vscode.env.appName,
                detail:
                    'Standard VS Code does not expose vscode.commands.onDidExecuteCommand to extensions ' +
                    '(GitHub Copilot Chat Apply/Send are not observable via the Commands API).',
            });
            Logger.info(
                `Blamely: executed-command events unavailable (${vscode.env.appName}). ` +
                    'VS Code does not provide vscode.commands.onDidExecuteCommand to extensions, so Copilot Chat ' +
                    'Apply/Keep is attributed via editor-change heuristics and substantial-insert AI windows. ' +
                    'For tighter hooks bind shortcuts to blamely.intercept.<commandId> — see README ' +
                    '“Chat Apply without command events”. Use Chat @Blamely for full LM prompt/response logs.'
            );
            if (!loggedChatTrafficNoExecuteCommand) {
                loggedChatTrafficNoExecuteCommand = true;
                console.log(
                    '[Blamely][chat-traffic] No vscode.commands.onDidExecuteCommand — this is normal on **VS Code** ' +
                        `(including with Copilot Chat): extensions cannot listen to chat Apply/Send commands. ` +
                        `Host: ${vscode.env.appName}. Blamely uses large-insert / AI-host heuristics for attribution; ` +
                        'use **Chat @Blamely** for Extension Host logs of prompt + reply text.'
                );
            }
        }

        // Detect chat send commands to measure time_waiting_for_ai
        for (const cmd of AiContextExtractor.AI_COMMAND_PATTERNS.chatSend) {
            try {
                const wrapperId = `blamely.chatSend.${cmd}`;
                context.subscriptions.push(
                    vscode.commands.registerCommand(wrapperId, async () => {
                        changeTracker.recordChatRequestSent();
                        chatPanelSignal('chat-send-wrapper', { wrappedCommand: cmd, wrapperId });
                        logChatPanelConsole('chat-send-wrapper', {
                            wrappedCommand: cmd,
                            note: 'User invoked blamely.chatSend.* wrapper before delegating to chat.',
                        });
                        console.log(`Blamely: Chat send detected (wrapper): ${cmd}`);
                        if (isLogChatPanelMessages()) {
                            console.log(
                                `Blamely [chat-send] via keybinding wrapper blamely.chatSend.${cmd} — ` +
                                    'prompt text is not passed through wrappers; use native send or @blamely chat for logging.'
                            );
                        }
                        try {
                            await vscode.commands.executeCommand(cmd);
                        } catch { /* command may not exist */ }
                    })
                );
            } catch {
                // Command already registered
            }
        }

        // Log detected AI providers on startup
        const detectedProviders = AiContextExtractor.detectAllProviders();
        if (detectedProviders.length > 0) {
            Logger.info(`AI providers detected: ${detectedProviders.join(', ')}`);
        }
        AiContextExtractor.detectModel().then(model => {
            if (model) Logger.info(`AI model detected: ${model}`);
        });

        /** Best-effort: Chat / Composer foreground tab lengthens AI intercept for streaming applies. */
        try {
            if (vscode.window.tabGroups?.onDidChangeTabs) {
                context.subscriptions.push(
                    vscode.window.tabGroups.onDidChangeTabs(() => pokeSoftAiWindowFromChatTabs(changeTracker))
                );
            }
            context.subscriptions.push(
                vscode.window.onDidChangeActiveTextEditor(() => pokeSoftAiWindowFromChatTabs(changeTracker))
            );
            /**
             * Large inserts + chat tab: AI window is opened synchronously inside {@link ChangeTracker.handleChange}
             * before classification so edits are not attributed Human due to listener order (this listener ran too late).
             */
        } catch {
            /* optional */
        }

        // Auto-install hook if configured
        const config = vscode.workspace.getConfiguration('blamely');
        if (config.get('autoInstallHook', true)) {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                if (await GitUtils.isGitRepo(folder.uri.fsPath)) {
                    const hookResult = await GitHookInstaller.install(folder.uri.fsPath, context.extensionPath);
                    console.log('[blamely] Hook install result:', folder.name, hookResult);
                }
            }
        }

        // Set up suggestion expiration
        const timeout = config.get<number>('suggestionTimeout', 30000);
        expirationTimer = setInterval(() => {
            traceStore.expirePending(timeout);
        }, timeout / 2);

        // Register commands
        context.subscriptions.push(
            vscode.commands.registerCommand('blamely.generateReport', async () => {
                if (!getWorkspaceRoot()) { return; }
                await generateReports();
                vscode.window.showInformationMessage(
                    'Blamely: Report written under ~/.blamely/repos/<repo>/<branch>/report.yml'
                );
            }),

            vscode.commands.registerCommand('blamely.showBlame', () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('Blamely: No file selected');
                    return;
                }
                const relativePath = blameFileKey(editor.document.uri);
                const entries = blameMap.getBlame(relativePath);
                if (entries.length === 0) {
                    vscode.window.showInformationMessage(`Blamely: No blame data for ${relativePath}`);
                    return;
                }
                blameDecorations.updateDecorations();
                const ai = entries.filter(e => e.authorType === 'AI').length;
                const human = entries.filter(e => e.authorType === 'HUMAN').length;
                vscode.window.showInformationMessage(`Blamely: Blame for ${relativePath}: ${ai} AI lines, ${human} human lines`);
            }),

            vscode.commands.registerCommand('blamely.installHook', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const success = await GitHookInstaller.install(wsRoot, context.extensionPath);
                if (success) {
                    vscode.window.showInformationMessage('Blamely: Git pre-commit hook installed');
                } else {
                    vscode.window.showErrorMessage('Blamely: Not a git repository or failed to install hook');
                }
            }),

            vscode.commands.registerCommand('blamely.restoreHook', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const result = await GitHookInstaller.uninstall(wsRoot);
                if (result === 'restored') {
                    vscode.window.showInformationMessage('Blamely: Pre-commit hook restored from backup');
                } else if (result === 'removed') {
                    vscode.window.showInformationMessage('Blamely: Pre-commit hook removed');
                } else {
                    vscode.window.showInformationMessage('Blamely: No pre-commit hook or backup found');
                }
            }),

            vscode.commands.registerCommand('blamely.attachGitNote', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const sha = await GitUtils.getLatestCommitSha(wsRoot);
                if (!sha) {
                    vscode.window.showErrorMessage('Blamely: Could not get current commit (HEAD)');
                    return;
                }
                try {
                    const noteContent = await buildNoteContentForCommit(wsRoot, sha);
                    const ok = await GitUtils.addGitNote(sha, noteContent, wsRoot);
                    await GitUtils.pushGitNotes(wsRoot);
                    if (ok) {
                        vscode.window.showInformationMessage(`Blamely: Git note attached for ${sha.slice(0, 8)}. Verify: git notes --ref=blamely show HEAD`);
                    } else {
                        vscode.window.showErrorMessage('Blamely: Failed to attach git note (see Output / logs)');
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Blamely: Failed to attach git note — ${msg}`);
                }
            }),

            vscode.commands.registerCommand('blamely.attachGitNoteForSha', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const headSha = await GitUtils.getLatestCommitSha(wsRoot);
                const sha = await vscode.window.showInputBox({
                    title: 'Attach Git Note for Commit',
                    prompt: 'Enter commit SHA (e.g. from "no note found" error)',
                    value: headSha ?? '',
                    placeHolder: 'full or short SHA',
                    validateInput: (v) => (v.trim().length >= 8 ? null : 'Enter at least 8 characters'),
                });
                if (sha === undefined || !sha.trim()) return;
                const fullSha = sha.trim().length === 40 ? sha.trim() : (await GitUtils.resolveCommitSha(wsRoot, sha.trim()) ?? sha.trim());
                try {
                    const noteContent = await buildNoteContentForCommit(wsRoot, fullSha);
                    const ok = await GitUtils.addGitNote(fullSha, noteContent, wsRoot);
                    await GitUtils.pushGitNotes(wsRoot);
                    if (ok) {
                        vscode.window.showInformationMessage(`Blamely: Git note attached for ${fullSha.slice(0, 8)}`);
                    } else {
                        vscode.window.showErrorMessage('Blamely: Failed to attach git note (see Output / logs)');
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Blamely: Failed to attach git note — ${msg}`);
                }
            }),

            vscode.commands.registerCommand('blamely.acceptInlineSuggestion', async () => {
                const attrGhost = vscode.workspace
                    .getConfiguration('blamely')
                    .get<boolean>('attributeInlineGhostCompletion', true);
                const ctx = await AiContextExtractor.extract('editor.action.inlineSuggest.commit');
                if (attrGhost) {
                    changeTracker.markNextChangeAsAi(
                        AiContextExtractor.getAiWindowDuration('completion'),
                        null,
                        ctx.model,
                        ctx.provider,
                        'completion'
                    );
                }
                await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
                collapseSelectionAfterAccept();
            }),

            vscode.commands.registerCommand('blamely.acceptNextWord', async () => {
                const attrGhost = vscode.workspace
                    .getConfiguration('blamely')
                    .get<boolean>('attributeInlineGhostCompletion', true);
                const ctx = await AiContextExtractor.extract('editor.action.inlineSuggest.acceptNextWord');
                if (attrGhost) {
                    changeTracker.markNextChangeAsAi(
                        AiContextExtractor.getAiWindowDuration('completion'),
                        null,
                        ctx.model,
                        ctx.provider,
                        'completion'
                    );
                }
                await vscode.commands.executeCommand('editor.action.inlineSuggest.acceptNextWord');
                collapseSelectionAfterAccept();
            }),

            vscode.commands.registerCommand('blamely.acceptNextLine', async () => {
                const attrGhost = vscode.workspace
                    .getConfiguration('blamely')
                    .get<boolean>('attributeInlineGhostCompletion', true);
                const ctx = await AiContextExtractor.extract('editor.action.inlineSuggest.acceptNextLine');
                if (attrGhost) {
                    changeTracker.markNextChangeAsAi(
                        AiContextExtractor.getAiWindowDuration('completion'),
                        null,
                        ctx.model,
                        ctx.provider,
                        'completion'
                    );
                }
                await vscode.commands.executeCommand('editor.action.inlineSuggest.acceptNextLine');
                collapseSelectionAfterAccept();
            }),

            vscode.commands.registerCommand('blamely.debug.dumpLastClassification', async () => {
                try {
                    const logPath = path.join(os.tmpdir(), `blamely-classification-${Date.now()}.txt`);
                    const body = `# Blamely classification log (recent gate decisions)\n\n${changeTracker.getClassificationDebugLog()}`;
                    await fs.promises.writeFile(logPath, body, 'utf-8');
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
                    await vscode.window.showTextDocument(doc, { preview: true });
                    vscode.window.showInformationMessage('Blamely: Opened classification log');
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Blamely: Could not dump classification — ${msg}`);
                }
            }),

            vscode.commands.registerCommand('blamely.showCommitReport', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const sha = await GitUtils.getLatestCommitSha(wsRoot);
                if (!sha) {
                    vscode.window.showInformationMessage('Blamely: No commits in repository');
                    return;
                }

                try {
                    const execStr = `git log -1 --show-notes=blamely --format="%N" ${sha}`;
                    const cp = require('child_process');
                    cp.exec(execStr, { cwd: wsRoot }, async (err: Error, stdout: string) => {
                        if (err || !stdout.trim()) {
                            vscode.window.showInformationMessage(`Blamely: No git note for commit ${sha.slice(0, 8)}`);
                            return;
                        }

                        const parts = stdout.trim().split('\n---\nblame_snapshot:\n');
                        const yamlContent = parts[0];

                        const doc = await vscode.workspace.openTextDocument({
                            content: yamlContent,
                            language: 'yaml'
                        });
                        await vscode.window.showTextDocument(doc);
                        vscode.window.showInformationMessage(`Blamely: Opened report from git note for commit ${sha.slice(0, 8)}`);
                    });
                } catch {
                    vscode.window.showErrorMessage('Blamely: Failed to fetch git note. Are you inside a git repository?');
                }
            })
        );

        // Save handler: persist blame and optionally regenerate reports
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(async (document) => {
                if (document.uri.scheme !== 'file') { return; }

                const blameKey = blameFileKey(document.uri);
                const wsRoot = workspaceRootForBlameKey(blameKey);
                if (!wsRoot) { return; }

                const relativePath = blameKey;
                const basenameCheck = relativePath.includes('/')
                    ? relativePath.slice(relativePath.lastIndexOf('/') + 1)
                    : relativePath;

                // Skip blamely's own logs/reports
                if (basenameCheck === BLAMELY_REPO_DETECTOR_FILENAME || basenameCheck === 'blamely-report.md') {
                    return;
                }

                console.log('[blamely] File saved:', relativePath);

                const entries = blameMap.getBlame(relativePath);
                if (!changeTracker.isSnapshotPersistSuppressed(relativePath) && entries.length > 0) {
                    await BlameSerializer.save(wsRoot, relativePath, entries);
                }

                // Persist session
                await traceStore.persistToAllWorkspaceRoots(getWorkspaceFolderRoots());

                // Regenerate reports if configured
                const cfg = vscode.workspace.getConfiguration('blamely');
                if (cfg.get('reportOnSave', true)) {
                    await generateReports();
                }
            })
        );

        // Register disposables
        context.subscriptions.push(
            statusBar,
            sidebarProvider,
            blameDecorations,
            completionInterceptor,
            changeTracker,
            commitListener
        );

        // Generate initial report files immediately
        console.log('[blamely] Generating initial reports at:', workspaceRoot);
        await generateReports();

        Logger.info('Blamely extension activated successfully');
        console.log('[blamely] Extension activated successfully');
        vscode.window.showInformationMessage('Blamely is active.');

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[blamely] Activation FAILED:', msg, err);
        Logger.error('Blamely failed to activate', err);
        vscode.window.showErrorMessage(`Blamely: Failed to activate — ${msg}`);
    }
}

/**
 * Build git note content for a commit (diff + current blame state). Matches IntelliJ AttachGitNoteAction.
 * Does not clear blameMap; used for "Attach Git Note for Current Commit" and "Attach Git Note for Commit SHA...".
 */
async function buildNoteContentForCommit(workspaceRoot: string, commitSha: string): Promise<string> {
    const repoRoot = await GitUtils.getRepoRoot(workspaceRoot);
    if (!repoRoot) throw new Error('Not a git repository');

    let changedRepoRelative = await GitUtils.getFilesChangedInCommit(repoRoot, commitSha);
    if (changedRepoRelative.length === 0) {
        await new Promise(r => setTimeout(r, 300));
        changedRepoRelative = await GitUtils.getFilesChangedInCommit(repoRoot, commitSha);
    }

    const entireBlame: Record<string, LineBlame[]> = {};
    const ts = new Date().toISOString();

    for (const repoRel of changedRepoRelative) {
        const absFile = path.join(repoRoot, repoRel);
        const projectRel = blameFileKey(vscode.Uri.file(absFile));
        const stats = await GitUtils.getDiffStats(repoRoot, commitSha, repoRel);
        if (stats.addedCount === 0 && stats.deletedCount === 0) continue;

        const trackerBlame = blameMap.getBlame(projectRel);
        const trackerByLine = new Map(trackerBlame.map(e => [e.lineNumber, e]));
        const entries: LineBlame[] = [];

        for (const line of [...stats.addedLines].sort((a, b) => a - b)) {
            const tracked = trackerByLine.get(line);
            const authorType = tracked?.authorType ?? 'HUMAN';
            const provider = authorType === 'AI' ? (tracked?.provider ?? 'unknown') : null;
            const model = authorType === 'AI' ? (tracked?.model ?? null) : null;
            const prompt = authorType === 'AI' ? (tracked?.prompt ?? null) : null;
            entries.push({
                lineNumber: line,
                authorType: authorType,
                provider,
                timestamp: ts,
                commitSha: commitSha,
                model,
                prompt,
                interactionType: null,
                aiChars: authorType === 'AI' ? 1 : 0,
                humanChars: authorType === 'HUMAN' ? 1 : 0,
                changeType: 'ADD',
                newLineNumber: line,
                oldLineNumber: null,
                codingType: 'TYPING',
            });
        }

        for (const oldLine of [...stats.deletedLines].sort((a, b) => a - b)) {
            const deletedByAi = blameMap.wasLineDeletedByAi(projectRel, oldLine);
            const authorType = deletedByAi ? 'AI' : 'HUMAN';
            entries.push({
                lineNumber: oldLine,
                authorType: authorType,
                provider: deletedByAi ? 'github-copilot' : null,
                timestamp: ts,
                commitSha: commitSha,
                model: deletedByAi ? 'unknown' : null,
                prompt: null,
                interactionType: null,
                aiChars: deletedByAi ? 1 : 0,
                humanChars: deletedByAi ? 0 : 1,
                changeType: 'DELETE',
                newLineNumber: null,
                oldLineNumber: oldLine,
                codingType: 'TYPING',
            });
        }

        if (entries.length > 0) {
            entries.sort((a, b) => (a.newLineNumber ?? a.oldLineNumber ?? 0) - (b.newLineNumber ?? b.oldLineNumber ?? 0));
            entireBlame[repoRel] = entries;
        }
    }

    const reportMetrics: ReportYaml.ReportMetrics = {
        firstStartCodingTimeMs: blameMap.firstStartCodingTimeMs,
        timeWaitingForAiMs: blameMap.totalTimeWaitingForAiMs,
    };
    const yamlReport = await ReportYaml.generateFromBlameSnapshot(
        repoRoot,
        entireBlame,
        traceStore,
        commitSha,
        vscode.env.appName,
        reportMetrics
    );
    const snapshotYaml = ReportYaml.blameSnapshotToYamlForReport(entireBlame);
    return `${yamlReport}\n---\nblames:\n${snapshotYaml}`;
}

async function generateReports(): Promise<void> {
    try {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            return;
        }
        const metrics = {
            firstStartCodingTimeMs: blameMap.firstStartCodingTimeMs,
            timeWaitingForAiMs: blameMap.totalTimeWaitingForAiMs,
        };
        if (folders.length === 1) {
            const root = folders[0].uri.fsPath;
            const payload = await ReportYaml.generateYamlAndHookTotals(
                root,
                blameMap,
                traceStore,
                undefined,
                vscode.env.appName,
                metrics,
                null
            );
            const repo = await GitUtils.getRepoRoot(root);
            if (payload && repo) {
                const { yaml, hookTotals } = payload;
                const branch = await GitUtils.getBranch(root);
                const reportPath = await BlamelyRepoPaths.reportYamlPath(repo, branch);
                if (reportPath) {
                    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
                    await fs.promises.writeFile(reportPath, yaml, 'utf-8');
                }
                const preamble = ReportYaml.detectorHookPreamble(hookTotals);
                const detectorPath = await GitUtils.blamelyDetectorAiPath(repo);
                if (detectorPath) {
                    await fs.promises.mkdir(path.dirname(detectorPath), { recursive: true });
                    await fs.promises.writeFile(detectorPath, preamble + yaml, 'utf-8');
                }
            }
            return;
        }
        for (const folder of folders) {
            const prefix = `${folder.name}/`;
            const payload = await ReportYaml.generateYamlAndHookTotals(
                folder.uri.fsPath,
                blameMap,
                traceStore,
                undefined,
                vscode.env.appName,
                metrics,
                prefix
            );
            const repo = await GitUtils.getRepoRoot(folder.uri.fsPath);
            if (payload && repo) {
                const { yaml, hookTotals } = payload;
                const branch = await GitUtils.getBranch(folder.uri.fsPath);
                const reportPath = await BlamelyRepoPaths.reportYamlPath(repo, branch);
                if (reportPath) {
                    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
                    await fs.promises.writeFile(reportPath, yaml, 'utf-8');
                }
                const preamble = ReportYaml.detectorHookPreamble(hookTotals);
                const detectorPath = await GitUtils.blamelyDetectorAiPath(repo);
                if (detectorPath) {
                    await fs.promises.mkdir(path.dirname(detectorPath), { recursive: true });
                    await fs.promises.writeFile(detectorPath, preamble + yaml, 'utf-8');
                }
            }
        }
    } catch (err) {
        console.error('[blamely] Failed to generate report.yml:', err);
    }
}

export async function deactivate(): Promise<void> {
    Logger.info('Blamely extension deactivating...');

    if (expirationTimer) {
        clearInterval(expirationTimer);
    }

    const roots = getWorkspaceFolderRoots();
    if (roots.length > 0 && traceStore) {
        if (blameMap) {
            for (const [filePath, entries] of blameMap.getRawMap()) {
                const root = workspaceRootForBlameKey(filePath);
                if (root && entries.length > 0) {
                    await BlameSerializer.save(root, filePath, entries);
                }
            }
            Logger.info(`Persisted blame for ${blameMap.getRawMap().size} files on deactivate`);
        }
        await traceStore.persistToAllWorkspaceRoots(roots);
    }

    Logger.dispose();
}

function getWorkspaceFolderRoots(): string[] {
    return vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
}

function getWorkspaceRoot(): string | undefined {
    return getWorkspaceFolderRoots()[0];
}

async function initializeRepoPersistenceDirs(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const repoRoot = await GitUtils.getRepoRoot(folder.uri.fsPath);
        if (!repoRoot) {
            continue;
        }
        const branch = await GitUtils.getBranch(repoRoot);
        try {
            await BlamelyRepoPaths.ensureBranchPersistenceDirs(repoRoot, branch);
        } catch (err) {
            Logger.warn(`Failed to initialize Blamely repo data dirs for ${repoRoot}: ${err}`);
        }
    }
}

/** Stable fingerprint of HEAD + index/working tree/merge resources (Git extension API). */
function gitWorktreeFingerprint(repo: { state: any }): string {
    const head = repo.state?.HEAD?.commit ?? '';
    const paths: string[] = [];
    for (const prop of ['workingTreeChanges', 'indexChanges', 'mergeChanges'] as const) {
        const coll = repo.state?.[prop] as readonly { resourceUri?: vscode.Uri }[] | undefined;
        if (!Array.isArray(coll)) {
            continue;
        }
        for (const r of coll) {
            const p = r.resourceUri?.fsPath;
            if (p) {
                paths.push(path.normalize(p));
            }
        }
    }
    paths.sort();
    return `${head}\n${paths.join('\n')}`;
}

/** Replace in-memory blame with persisted snapshots for the current branch (after checkout). */
async function reloadBlameMapsForRepoAfterBranchSwitch(repoRoot: string): Promise<void> {
    for (const folder of workspaceFoldersUnderRepo(repoRoot)) {
        const keysToRemove = [...filterBlameMapForFolder(blameMap, folder).keys()];
        for (const k of keysToRemove) {
            blameMap.removeFile(k);
        }
        const saved = await BlameSerializer.loadAll(folder.uri.fsPath);
        for (const [file, entries] of saved) {
            const key = normalizeLoadedBlameKey(file, folder);
            blameMap.setFileBlame(key, entries);
        }
    }
}

function clipVisibleEditorsUnderRepo(repoRoot: string): void {
    const normR = path.normalize(repoRoot);
    for (const ed of vscode.window.visibleTextEditors) {
        const d = ed.document;
        if (d.uri.scheme !== 'file') {
            continue;
        }
        const nf = path.normalize(d.uri.fsPath);
        if (nf !== normR && !nf.startsWith(normR + path.sep)) {
            continue;
        }
        const key = blameFileKey(d.uri);
        blameMap.clipLinesToDocumentLength(key, d.lineCount);
    }
}

function filterBlameMapForFolder(map: BlameMap, folder: vscode.WorkspaceFolder): Map<string, LineBlame[]> {
    const out = new Map<string, LineBlame[]>();
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const prefix = multi ? `${folder.name}/` : null;
    for (const [k, v] of map.getRawMap()) {
        if (!prefix || k.startsWith(prefix)) {
            out.set(k, v);
        }
    }
    return out;
}


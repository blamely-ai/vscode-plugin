import * as vscode from 'vscode';
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

function collapseSelectionAfterAccept(): void {
    setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return;
        const end = editor.selection.end;
        editor.selection = new vscode.Selection(end, end);
    }, 0);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('[ai-trace] activate() called');

    try {
        Logger.info('AI Trace extension activating...');

        const workspaceRoot = getWorkspaceRoot();
        console.log('[ai-trace] workspaceRoot:', workspaceRoot);

        if (!workspaceRoot) {
            const msg = 'AI Trace: No workspace folder open — extension requires an open folder';
            Logger.warn(msg);
            vscode.window.showWarningMessage(msg);
            return;
        }

        // Initialize core state
        traceStore = new TraceStore();
        blameMap = new BlameMap();

        // Load persisted state, then discard stale blame for files with no uncommitted changes
        await traceStore.load(workspaceRoot);
        const savedBlame = await BlameSerializer.loadAll(workspaceRoot);
        if (savedBlame.size > 0) {
            const repoRoot = await GitUtils.getRepoRoot(workspaceRoot);
            const dirtyFiles = await GitUtils.getUncommittedFiles(repoRoot || workspaceRoot);
            const pathMap = repoRoot
                ? GitUtils.repoRelativeToProjectRelative(repoRoot, workspaceRoot, [...dirtyFiles])
                : null;
            const dirtyProjectPaths = new Set<string>();
            if (pathMap) {
                for (const projRel of pathMap.values()) {
                    dirtyProjectPaths.add(projRel.replace(/\\/g, '/'));
                }
            } else {
                for (const f of dirtyFiles) dirtyProjectPaths.add(f);
            }

            let loaded = 0;
            let discarded = 0;
            for (const [file, entries] of savedBlame) {
                const norm = file.replace(/\\/g, '/');
                if (dirtyProjectPaths.has(norm)) {
                    blameMap.setFileBlame(file, entries);
                    loaded++;
                } else {
                    discarded++;
                }
            }
            Logger.info(`Loaded blame for ${loaded} dirty files, discarded ${discarded} stale files`);

            if (discarded > 0) {
                await BlameSerializer.clearCurrentBranchSnapshots(workspaceRoot);
                for (const [file, entries] of savedBlame) {
                    const norm = file.replace(/\\/g, '/');
                    if (dirtyProjectPaths.has(norm)) {
                        await BlameSerializer.save(workspaceRoot, file, entries);
                    }
                }
            }
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

        // Initialize Git integration
        commitListener = new CommitListener(blameMap, traceStore, workspaceRoot, onBlameUpdated);

        // Initialize Chat Participant for prompt/model capture
        chatParticipant = new ChatParticipant(traceStore, blameMap, onBlameUpdated);

        // Detect VCS rollback / git checkout / branch switch / push via Git extension
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
                const api = git.getAPI(1);
                if (api && api.repositories.length > 0) {
                    const repo = api.repositories[0];
                    let lastBranch: string | undefined = repo.state.HEAD?.name;
                    let lastAhead: number | undefined = repo.state.HEAD?.ahead;

                    repo.state.onDidChange(() => {
                        const currentBranch = repo.state.HEAD?.name;
                        const currentAhead: number | undefined = repo.state.HEAD?.ahead;

                        if (lastBranch && currentBranch && currentBranch !== lastBranch) {
                            Logger.info(`Branch switch detected: ${lastBranch} -> ${currentBranch}`);
                            changeTracker.notifyRollback();
                        }

                        // Detect push: ahead count decreased (user pushed commits to remote)
                        if (lastAhead !== undefined && lastAhead > 0 &&
                            currentAhead !== undefined && currentAhead < lastAhead) {
                            Logger.info(`Push detected (ahead ${lastAhead} -> ${currentAhead}), pushing ai-trace notes`);
                            GitUtils.pushGitNotes(workspaceRoot).catch(err =>
                                Logger.warn(`Auto-push notes after push failed: ${err}`)
                            );
                        }

                        lastBranch = currentBranch;
                        lastAhead = currentAhead;
                    });
                }
            }
        } catch (err) {
            Logger.warn(`Could not wire Git extension listeners: ${err}`);
        }

        // Listen for git.clean / git.checkout commands as rollback triggers
        const rollbackCommands = ['git.clean', 'git.cleanAll', 'git.checkout', 'git.undoCommit'];
        for (const cmd of rollbackCommands) {
            try {
                context.subscriptions.push(
                    vscode.commands.registerCommand(`ai-trace.after.${cmd}`, () => {
                        changeTracker.notifyRollback();
                    })
                );
            } catch {
                // Command may already be registered
            }
        }

        // Detect AI-related commands and mark next change as AI (mirrors IntelliJ AnActionListener + CommandListener).
        // This catches Copilot Chat Apply, inline chat accept, Cursor apply, etc.
        const aiCommandsToWatch = [
            ...AiContextExtractor.AI_COMMAND_PATTERNS.chatPanel,
            ...AiContextExtractor.AI_COMMAND_PATTERNS.chatInline,
        ];
        for (const cmd of aiCommandsToWatch) {
            try {
                const wrapperId = `ai-trace.intercept.${cmd}`;
                context.subscriptions.push(
                    vscode.commands.registerCommand(wrapperId, async () => {
                        const interactionType = AiContextExtractor.detectInteractionType(cmd);
                        const ctx = await AiContextExtractor.extract(cmd);
                        const duration = AiContextExtractor.getAiWindowDuration(interactionType);
                        changeTracker.markNextChangeAsAi(duration, null, ctx.model, ctx.provider, interactionType);
                        Logger.info(`AI command intercepted: ${cmd} (type=${interactionType}, model=${ctx.model})`);
                        try {
                            await vscode.commands.executeCommand(cmd);
                        } catch { /* command may not exist */ }
                    })
                );
            } catch {
                // Command already registered or unavailable
            }
        }

        // Detect chat send commands to measure time_waiting_for_ai
        for (const cmd of AiContextExtractor.AI_COMMAND_PATTERNS.chatSend) {
            try {
                const wrapperId = `ai-trace.chatSend.${cmd}`;
                context.subscriptions.push(
                    vscode.commands.registerCommand(wrapperId, async () => {
                        changeTracker.recordChatRequestSent();
                        Logger.info(`Chat send detected: ${cmd}`);
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

        // Auto-install hook if configured
        const config = vscode.workspace.getConfiguration('aiTrace');
        if (config.get('autoInstallHook', true)) {
            const hookResult = await GitHookInstaller.install(workspaceRoot, context.extensionPath);
            console.log('[ai-trace] Hook install result:', hookResult);
        }

        // Set up suggestion expiration
        const timeout = config.get<number>('suggestionTimeout', 30000);
        expirationTimer = setInterval(() => {
            traceStore.expirePending(timeout);
        }, timeout / 2);

        // Register commands
        context.subscriptions.push(
            vscode.commands.registerCommand('ai-trace.generateReport', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                await generateReports(wsRoot);
                vscode.window.showInformationMessage('Blamely: Report generated at .git/ai-trace/report.yml');
            }),

            vscode.commands.registerCommand('ai-trace.showBlame', () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('Blamely: No file selected');
                    return;
                }
                const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
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

            vscode.commands.registerCommand('ai-trace.installHook', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const success = await GitHookInstaller.install(wsRoot, context.extensionPath);
                if (success) {
                    vscode.window.showInformationMessage('Blamely: Git pre-commit hook installed');
                } else {
                    vscode.window.showErrorMessage('Blamely: Not a git repository or failed to install hook');
                }
            }),

            vscode.commands.registerCommand('ai-trace.restoreHook', async () => {
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

            vscode.commands.registerCommand('ai-trace.attachGitNote', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const sha = await GitUtils.getLatestCommitSha(wsRoot);
                if (!sha) {
                    vscode.window.showErrorMessage('Blamely: Could not get current commit (HEAD)');
                    return;
                }
                try {
                    const noteContent = await buildNoteContentForCommit(wsRoot, sha);
                    await GitUtils.addGitNote(sha, noteContent, wsRoot);
                    await GitUtils.pushGitNotes(wsRoot);
                    vscode.window.showInformationMessage(`Blamely: Git note attached for ${sha.slice(0, 8)}. Verify: git notes --ref=ai-trace show HEAD`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Blamely: Failed to attach git note — ${msg}`);
                }
            }),

            vscode.commands.registerCommand('ai-trace.attachGitNoteForSha', async () => {
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
                    await GitUtils.addGitNote(fullSha, noteContent, wsRoot);
                    await GitUtils.pushGitNotes(wsRoot);
                    vscode.window.showInformationMessage(`Blamely: Git note attached for ${fullSha.slice(0, 8)}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Blamely: Failed to attach git note — ${msg}`);
                }
            }),

            vscode.commands.registerCommand('ai-trace.acceptInlineSuggestion', async () => {
                const ctx = await AiContextExtractor.extract('editor.action.inlineSuggest.commit');
                changeTracker.markNextChangeAsAi(
                    AiContextExtractor.getAiWindowDuration('completion'),
                    null, ctx.model, ctx.provider, 'completion'
                );
                await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
                collapseSelectionAfterAccept();
            }),

            vscode.commands.registerCommand('ai-trace.acceptNextWord', async () => {
                const ctx = await AiContextExtractor.extract('editor.action.inlineSuggest.acceptNextWord');
                changeTracker.markNextChangeAsAi(
                    AiContextExtractor.getAiWindowDuration('completion'),
                    null, ctx.model, ctx.provider, 'completion'
                );
                await vscode.commands.executeCommand('editor.action.inlineSuggest.acceptNextWord');
                collapseSelectionAfterAccept();
            }),

            vscode.commands.registerCommand('ai-trace.acceptNextLine', async () => {
                const ctx = await AiContextExtractor.extract('editor.action.inlineSuggest.acceptNextLine');
                changeTracker.markNextChangeAsAi(
                    AiContextExtractor.getAiWindowDuration('completion'),
                    null, ctx.model, ctx.provider, 'completion'
                );
                await vscode.commands.executeCommand('editor.action.inlineSuggest.acceptNextLine');
                collapseSelectionAfterAccept();
            }),

            vscode.commands.registerCommand('ai-trace.showCommitReport', async () => {
                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }
                const sha = await GitUtils.getLatestCommitSha(wsRoot);
                if (!sha) {
                    vscode.window.showInformationMessage('Blamely: No commits in repository');
                    return;
                }

                try {
                    const execStr = `git log -1 --show-notes=ai-trace --format="%N" ${sha}`;
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

                const wsRoot = getWorkspaceRoot();
                if (!wsRoot) { return; }

                const relativePath = vscode.workspace.asRelativePath(document.uri, false);

                // Skip ai-trace's own logs/reports
                if (relativePath === 'detector.ai' || relativePath === 'ai-trace-report.md') {
                    return;
                }

                console.log('[ai-trace] File saved:', relativePath);

                // Persist blame for this file
                const entries = blameMap.getBlame(relativePath);
                if (entries.length > 0) {
                    await BlameSerializer.save(wsRoot, relativePath, entries);
                }

                // Persist session
                await traceStore.persist(wsRoot);

                // Regenerate reports if configured
                const cfg = vscode.workspace.getConfiguration('aiTrace');
                if (cfg.get('reportOnSave', true)) {
                    await generateReports(wsRoot);
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
        console.log('[ai-trace] Generating initial reports at:', workspaceRoot);
        await generateReports(workspaceRoot);

        Logger.info('AI Trace extension activated successfully');
        console.log('[ai-trace] Extension activated successfully');
        vscode.window.showInformationMessage('🤖 AI Trace: Extension activated — tracking code changes');

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[ai-trace] Activation FAILED:', msg, err);
        Logger.error('AI Trace failed to activate', err);
        vscode.window.showErrorMessage(`AI Trace: Failed to activate — ${msg}`);
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

    const repoToProject = GitUtils.repoRelativeToProjectRelative(repoRoot, workspaceRoot, changedRepoRelative);
    const entireBlame: Record<string, LineBlame[]> = {};
    const ts = new Date().toISOString();

    for (const repoRel of changedRepoRelative) {
        const projectRel = repoToProject.get(repoRel) ?? repoRel;
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
        workspaceRoot,
        entireBlame,
        traceStore,
        commitSha,
        vscode.env.appName,
        reportMetrics
    );
    const snapshotYaml = ReportYaml.blameSnapshotToYamlForReport(entireBlame);
    return `${yamlReport}\n---\nblames:\n${snapshotYaml}`;
}

async function generateReports(workspaceRoot: string): Promise<void> {
    try {
        const metrics = {
            firstStartCodingTimeMs: blameMap.firstStartCodingTimeMs,
            timeWaitingForAiMs: blameMap.totalTimeWaitingForAiMs,
        };
        const yaml = await ReportYaml.generate(
            workspaceRoot,
            blameMap,
            traceStore,
            undefined,
            vscode.env.appName,
            metrics
        );
        const aiTraceDir = await GitUtils.getAiTraceDir(workspaceRoot);
        if (aiTraceDir && yaml) {
            const fs = await import('fs');
            await fs.promises.mkdir(aiTraceDir, { recursive: true });
            await fs.promises.writeFile(path.join(aiTraceDir, 'report.yml'), yaml, 'utf-8');
        }
    } catch (err) {
        console.error('[ai-trace] Failed to generate report.yml:', err);
    }
}

export async function deactivate(): Promise<void> {
    Logger.info('AI Trace extension deactivating...');

    if (expirationTimer) {
        clearInterval(expirationTimer);
    }

    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot && traceStore) {
        await traceStore.persist(workspaceRoot);
    }

    Logger.dispose();
}

function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

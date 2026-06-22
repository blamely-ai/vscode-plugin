import * as vscode from 'vscode';
import { BlameMap } from './blame/BlameMap';
import { CliDataService } from './cli/CliDataService';
import { CliHealthNotifier } from './cli/CliHealthNotifier';
import { CompletionDetector } from './completion/CompletionDetector';
import { DaemonClient } from './completion/DaemonClient';
import { WorkingLogTracker } from './authorship/WorkingLogTracker';
import { GutterV2 } from './authorship/GutterV2';
import { StatusBar } from './ui/StatusBar';
import { SidebarProvider } from './ui/SidebarProvider';
import { BlameDecorations } from './ui/BlameDecorations';
import { HistoryProvider } from './ui/HistoryProvider';
import * as GitUtils from './git/GitUtils';
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

    // Attribution v2 gutter overlay (flag-gated by blamely.attributionV2; inert when
    // off). Paints the active editor from `blamely authorship` — the same working log
    // the commit note flips to (I4).
    const gutterV2 = new GutterV2(blameMap, () => blameDecorations?.updateDecorations());
    gutterV2.activate();
    disposables.push(gutterV2);

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
    let lastHead: string | null = null;
    const pollHead = async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return;
        const repoRoot = await GitUtils.getRepoRoot(root);
        if (!repoRoot) return;
        const head = await GitUtils.runGitCommand(repoRoot, 'rev-parse', 'HEAD');
        if (head && head !== lastHead) {
            lastHead = head;
            void cliData?.refresh();
            void historyProvider?.refresh();
        }
    };
    disposables.push(vscode.workspace.onDidSaveTextDocument(() => void pollHead()));
    const headTimer = setInterval(() => void pollHead(), 3000);
    disposables.push(new vscode.Disposable(() => clearInterval(headTimer)));

    healthNotifier = new CliHealthNotifier();
    disposables.push(healthNotifier);
    healthNotifier.start();

    // Clicking the daemon status-bar lamp shows current health on demand. This is
    // how the user checks status after the one-shot startup popup — the daemon
    // lamp's `command` (blamely.showDaemonStatus) was contributed but never
    // registered, so the click previously did nothing.
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
        const workingLogTracker = new WorkingLogTracker();
        workingLogTracker.register();
        disposables.push(workingLogTracker);
        completionDetector.onEditObserved = (doc, prev, next, author) =>
            workingLogTracker.onEdit(doc, prev, next, author);
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

    disposables.push(
        vscode.window.onDidChangeWindowState((e) => {
            if (e.focused) {
                void cliData?.refresh();
            }
        }),
    );

    for (const d of disposables) {
        context.subscriptions.push(d);
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

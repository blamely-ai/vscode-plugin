import * as vscode from 'vscode';
import { BlameMap } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { getWorkingTreeDirtyBlameKeys } from '../utils/WorkspacePaths';
import * as GitUtils from '../git/GitUtils';

/**
 * Status bar — reads runtime attribution from oobeya-cli SQLite via CliDataService.
 */
export class StatusBar implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private blameMap: BlameMap;
    private cliData: CliDataService;
    private disposables: vscode.Disposable[] = [];

    private static readonly ICON_CHARS = 'ⓒ';
    private static readonly ICON_LINES = '≡';

    constructor(blameMap: BlameMap, cliData: CliDataService) {
        this.blameMap = blameMap;
        this.cliData = cliData;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'blamelySidebar.focus';
        void this.update();
        this.item.show();
        this.disposables.push(cliData.onRefresh(() => void this.update()));
    }

    async update(): Promise<void> {
        const dirtyKeys = await getWorkingTreeDirtyBlameKeys();
        const summary =
            dirtyKeys === null
                ? this.blameMap.getSummary()
                : this.blameMap.getSummary(dirtyKeys);

        const totalChars = summary.aiChars + summary.humanChars;
        const totalLines = summary.totalLines;
        const daemon = this.cliData.getDaemonStatus();
        const daemonHint = daemon.running
            ? `blamely daemon :${daemon.port}`
            : 'blamely daemon offline';

        if (totalChars === 0 && totalLines === 0) {
            this.item.text = `🤖 AI: 0 ${StatusBar.ICON_CHARS} 0 ${StatusBar.ICON_LINES} 0% | 👤 Human: 0 ${StatusBar.ICON_CHARS} 0 ${StatusBar.ICON_LINES} 0%`;
            this.item.tooltip = `Blamely — ${daemonHint}. Run blamely install && blamely daemon.`;
            return;
        }

        const totalForPercent = Math.max(totalChars, 1);
        const aiPercent = Math.round((summary.aiChars / totalForPercent) * 100);
        const humanPercent = Math.round((summary.humanChars / totalForPercent) * 100);
        this.item.text =
            `🤖 AI: ${summary.aiChars} ${StatusBar.ICON_CHARS} ${summary.aiLines} ${StatusBar.ICON_LINES} ${aiPercent}% | ` +
            `👤 Human: ${summary.humanChars} ${StatusBar.ICON_CHARS} ${summary.humanLines} ${StatusBar.ICON_LINES} ${humanPercent}%`;
        this.item.tooltip = `Blamely runtime (${daemonHint}) — ⓒ chars, ≡ lines. Click for Changes.`;
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.item.dispose();
    }
}

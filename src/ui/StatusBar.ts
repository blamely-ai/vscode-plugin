import * as vscode from 'vscode';
import { BlameMap } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';

/**
 * Status bar — reads runtime attribution from oobeya-cli SQLite via CliDataService.
 */
export class StatusBar implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private blameMap: BlameMap;
    private cliData: CliDataService;
    private disposables: vscode.Disposable[] = [];

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
        const summary = this.blameMap.getSummary();
        const daemon = this.cliData.getDaemonStatus();
        const daemonHint = daemon.running
            ? `blamely daemon :${daemon.port}`
            : 'blamely daemon offline';

        const totalLines = summary.aiLines + summary.humanLines;

        if (totalLines === 0) {
            this.item.text = `🤖 AI: 0 ${StatusBar.ICON_LINES} 0% | 👤 Human: 0 ${StatusBar.ICON_LINES} 0%`;
            this.item.tooltip = `Blamely — ${daemonHint}. Run blamely install && blamely daemon.`;
            return;
        }

        const aiPercent = Math.round((summary.aiLines / totalLines) * 100);
        const humanPercent = 100 - aiPercent;
        this.item.text =
            `🤖 AI: ${summary.aiLines} ${StatusBar.ICON_LINES} ${aiPercent}% | ` +
            `👤 Human: ${summary.humanLines} ${StatusBar.ICON_LINES} ${humanPercent}%`;
        this.item.tooltip = `Blamely runtime (${daemonHint}) — ≡ lines. Click for Changes.`;
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.item.dispose();
    }
}

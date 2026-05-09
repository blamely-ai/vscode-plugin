import * as vscode from 'vscode';
import { BlameMap } from '../blame/BlameMap';
import { getWorkingTreeDirtyBlameKeys } from '../utils/WorkspacePaths';

/**
 * Status bar widget showing AI & Human by characters, lines, and percentage.
 * Matches IntelliJ BlamelyStatusBarWidget: ⓒ = chars, ≡ = lines.
 * Format: 🤖 AI: 20 ⓒ 1 ≡ 20% | 👤 Human: 35 ⓒ 2 ≡ 80%
 * Only counts uncommitted entries (commit_sha === null) on files Git still reports as dirty when in a repo,
 * so counts stay aligned with the sidebar Changes list after discard/commit.
 * Refreshes every 2 seconds (matching IntelliJ statusBarAlarm) and on every onBlameUpdated call.
 */
export class StatusBar implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private blameMap: BlameMap;
    private refreshInterval: NodeJS.Timeout;

    private static readonly ICON_CHARS = 'ⓒ';
    private static readonly ICON_LINES = '≡';

    constructor(blameMap: BlameMap) {
        this.blameMap = blameMap;
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = 'blamelySidebar.focus';
        this.item.tooltip = 'Blamely — ⓒ chars, ≡ lines. Click to view details. blamely.ai';
        void this.update();
        this.item.show();

        this.refreshInterval = setInterval(() => void this.update(), 2000);
    }

    async update(): Promise<void> {
        const dirtyKeys = await getWorkingTreeDirtyBlameKeys();
        const summary =
            dirtyKeys === null
                ? this.blameMap.getSummary()
                : this.blameMap.getSummary(dirtyKeys);
        const totalChars = summary.aiChars + summary.humanChars;
        const totalLines = summary.totalLines;

        if (totalChars === 0 && totalLines === 0) {
            this.item.text = `🤖 AI: 0 ${StatusBar.ICON_CHARS} 0 ${StatusBar.ICON_LINES} 0% | 👤 Human: 0 ${StatusBar.ICON_CHARS} 0 ${StatusBar.ICON_LINES} 0%`;
            return;
        }

        const totalForPercent = Math.max(totalChars, 1);
        const aiPercent = Math.round((summary.aiChars / totalForPercent) * 100);
        const humanPercent = Math.round((summary.humanChars / totalForPercent) * 100);
        this.item.text =
            `🤖 AI: ${summary.aiChars} ${StatusBar.ICON_CHARS} ${summary.aiLines} ${StatusBar.ICON_LINES} ${aiPercent}% | ` +
            `👤 Human: ${summary.humanChars} ${StatusBar.ICON_CHARS} ${summary.humanLines} ${StatusBar.ICON_LINES} ${humanPercent}%`;
    }

    dispose(): void {
        clearInterval(this.refreshInterval);
        this.item.dispose();
    }
}

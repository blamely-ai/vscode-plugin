import * as http from 'http';
import * as vscode from 'vscode';
import { BlameMap } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { readDaemonPort } from '../cli/paths';

const HEARTBEAT_MS = 5_000;

/**
 * Blamely status bar item — shows AI/Human attribution percentages and a
 * daemon connection lamp that updates every 5 seconds via a /health heartbeat.
 *
 * 🟢 $(circle-filled) = daemon reachable   🔴 $(circle-filled) = daemon offline
 */
export class StatusBar implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private blameMap: BlameMap;
    private cliData: CliDataService;
    private disposables: vscode.Disposable[] = [];
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private daemonAlive = false;

    private static readonly ICON_LINES = '≡';

    constructor(blameMap: BlameMap, cliData: CliDataService) {
        this.blameMap = blameMap;
        this.cliData = cliData;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'blamelySidebar.focus';
        this.item.show();

        // Immediate first render + heartbeat loop.
        void this.heartbeat();
        this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);

        this.disposables.push(cliData.onRefresh(() => void this.render()));
    }

    /** Ping /health, update the lamp, then re-render. */
    private async heartbeat(): Promise<void> {
        this.daemonAlive = await this.pingHealth();
        void this.render();
    }

    /** Called after CliDataService finishes a refresh (in addition to onRefresh). */
    async renderAfterRefresh(): Promise<void> {
        await this.render();
    }

    private async render(): Promise<void> {
        const summary = this.blameMap.getSummary();
        const lamp = this.daemonAlive
            ? '$(circle-filled) '
            : '$(circle-outline) ';
        const lampColor = this.daemonAlive
            ? new vscode.ThemeColor('charts.green')
            : new vscode.ThemeColor('charts.red');

        const totalLines = summary.aiLines + summary.humanLines;
        const aiPercent = totalLines === 0 ? 0 : Math.round((summary.aiLines / totalLines) * 100);
        const humanPercent = 100 - aiPercent;

        this.item.text =
            `${lamp}🤖 AI: ${summary.aiLines} ${StatusBar.ICON_LINES} ${aiPercent}% | ` +
            `👤 Human: ${summary.humanLines} ${StatusBar.ICON_LINES} ${humanPercent}%`;
        this.item.color = lampColor;
        this.item.tooltip = this.daemonAlive
            ? `Blamely daemon running — click for Changes`
            : `Blamely daemon offline — run: blamely daemon`;
    }

    private pingHealth(): Promise<boolean> {
        return new Promise((resolve) => {
            const port = readDaemonPort();
            if (port == null) { resolve(false); return; }
            const req = http.request(
                { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 },
                (res) => { res.resume(); resolve(res.statusCode === 200); },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    dispose(): void {
        if (this.heartbeatTimer != null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const d of this.disposables) d.dispose();
        this.item.dispose();
    }
}

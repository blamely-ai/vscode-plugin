import * as http from 'http';
import * as vscode from 'vscode';
import { BlameMap } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { readDaemonPort, readDaemonSocket } from '../cli/paths';
import { blameFileKey } from '../utils/WorkspacePaths';

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
        // The count is scoped to the active file, so re-render when the user
        // switches editors (otherwise it would show the previous file's numbers).
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => void this.render()),
        );
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
        // Count the ACTIVE FILE only, so the status bar matches the gutter icons
        // in front of the user (getSummaryForFile shares getBlame's path
        // resolution and the gutter's per-line dedup). No file editor focused
        // (e.g. a settings tab) → empty summary rather than a stale workspace total.
        const editor = vscode.window.activeTextEditor;
        const summary = editor && editor.document.uri.scheme === 'file'
            ? this.blameMap.getSummaryForFile(blameFileKey(editor.document.uri))
            : { aiChars: 0, humanChars: 0, aiLines: 0, humanLines: 0, totalLines: 0 };
        const lamp = this.daemonAlive
            ? '$(circle-filled) '
            : '$(circle-outline) ';
        const lampColor = this.daemonAlive
            ? new vscode.ThemeColor('charts.green')
            : new vscode.ThemeColor('charts.red');

        const totalLines = summary.aiLines + summary.humanLines;
        const aiPercent = totalLines === 0 ? 0 : Math.round((summary.aiLines / totalLines) * 100);
        const humanPercent = totalLines === 0 ? 0 : 100 - aiPercent;

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
            const sock = readDaemonSocket();
            const port = sock == null ? readDaemonPort() : null;
            if (sock == null && port == null) { resolve(false); return; }
            const opts: http.RequestOptions = { path: '/health', method: 'GET', timeout: 2000 };
            if (sock != null) { opts.socketPath = sock; } else { opts.host = '127.0.0.1'; opts.port = port!; }
            const req = http.request(opts, (res) => { res.resume(); resolve(res.statusCode === 200); });
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

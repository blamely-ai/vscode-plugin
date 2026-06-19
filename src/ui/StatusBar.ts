import * as http from 'http';
import * as vscode from 'vscode';
import { BlameMap } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { readDaemonPort, readDaemonSocket } from '../cli/paths';
import * as Logger from '../utils/Logger';

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
    // Hysteresis: a single missed /health ping (a busy event loop, a GC pause,
    // the daemon mid-restart) shouldn't flip the lamp to "offline". Only show
    // offline after this many CONSECUTIVE failures; any success resets it.
    private consecutiveFailures = 0;
    private static readonly FAILURE_THRESHOLD = 3;

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

        // Session-wide total — driven by data refreshes + the heartbeat. No need
        // to re-render on editor switch (the count is not scoped to the active file).
        this.disposables.push(cliData.onRefresh(() => void this.render()));
    }

    /** Ping /health, update the lamp, then re-render. */
    private async heartbeat(): Promise<void> {
        if (await this.pingHealth()) {
            this.consecutiveFailures = 0;
            this.daemonAlive = true;
        } else if (++this.consecutiveFailures >= StatusBar.FAILURE_THRESHOLD) {
            this.daemonAlive = false;
        }
        void this.render();
    }

    /** Called after CliDataService finishes a refresh (in addition to onRefresh). */
    async renderAfterRefresh(): Promise<void> {
        await this.render();
    }

    private async render(): Promise<void> {
        // Count the WHOLE SESSION — every changed file tracked this session, not
        // just the active editor. getSummary() applies the same per-line dedup as
        // the per-file view, so the totals reconcile with the gutter icons.
        const summary = this.blameMap.getSummary();
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
            if (sock == null && port == null) { Logger.debugConn('/health skipped: no daemon socket/port file'); resolve(false); return; }
            const via = sock != null ? 'unix' : `tcp:${port}`;
            const t0 = Date.now();
            const done = (ok: boolean, why?: string) => {
                Logger.debugConn(`/health ${ok ? 'ok' : 'FAIL'} via ${via} (${Date.now() - t0}ms)${why ? ' ' + why : ''}`);
                resolve(ok);
            };
            const opts: http.RequestOptions = { path: '/health', method: 'GET', timeout: 3000 };
            if (sock != null) { opts.socketPath = sock; } else { opts.host = '127.0.0.1'; opts.port = port!; }
            const req = http.request(opts, (res) => { res.resume(); done(res.statusCode === 200, `status=${res.statusCode}`); });
            req.on('error', (e) => done(false, e.message));
            req.on('timeout', () => { req.destroy(); done(false, 'timeout'); });
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

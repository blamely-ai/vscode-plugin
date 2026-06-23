import * as http from 'http';
import * as vscode from 'vscode';
import { BlameMap } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { readDaemonPort, readDaemonSocket } from '../cli/paths';
import * as Logger from '../utils/Logger';

const HEARTBEAT_MS = 5_000;

/**
 * Blamely status bar — shows AI/Human attribution percentages and a daemon
 * connection lamp that updates every 5 seconds via a /health heartbeat.
 *
 * Rendered as TWO adjacent items so each side can carry its own color: on dark
 * (and high-contrast) themes AI is blue and Human is green for a colorful bar;
 * on light themes both fall back to the default foreground (a colored item there
 * washed out). 🟢/🔴 emoji lamp signals daemon reachability in any theme.
 */
export class StatusBar implements vscode.Disposable {
    private aiItem: vscode.StatusBarItem;
    private humanItem: vscode.StatusBarItem;
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
        // Higher priority renders further left, so AI sits left of Human.
        this.aiItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.humanItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        for (const item of [this.aiItem, this.humanItem]) {
            item.command = 'blamelySidebar.focus';
            item.show();
        }

        // Immediate first render + heartbeat loop.
        void this.heartbeat();
        this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);

        // Session-wide total — driven by data refreshes + the heartbeat. No need
        // to re-render on editor switch (the count is not scoped to the active file).
        this.disposables.push(cliData.onRefresh(() => void this.render()));
        // Re-color when the user switches between light and dark themes.
        this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => void this.render()));
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
        // Colored emoji lamp keeps its own color in any theme.
        const lamp = this.daemonAlive ? '🟢 ' : '🔴 ';

        const totalLines = summary.aiLines + summary.humanLines;
        const aiPercent = totalLines === 0 ? 0 : Math.round((summary.aiLines / totalLines) * 100);
        const humanPercent = totalLines === 0 ? 0 : 100 - aiPercent;

        const lineLabel = (n: number) => `${StatusBar.ICON_LINES} ${n} ${n === 1 ? 'line' : 'lines'}`;
        this.aiItem.text = `${lamp}🤖 AI: ${aiPercent}% ${lineLabel(summary.aiLines)}`;
        this.humanItem.text = `👤 Human: ${humanPercent}% ${lineLabel(summary.humanLines)}`;

        // Colorful on dark / high-contrast themes (AI blue, Human green). On light
        // themes a tinted status-bar item washes out, so fall back to the default
        // foreground there — the emoji still carry color.
        const kind = vscode.window.activeColorTheme.kind;
        const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
        this.aiItem.color = dark ? new vscode.ThemeColor('charts.blue') : undefined;
        this.humanItem.color = dark ? new vscode.ThemeColor('charts.green') : undefined;

        const tooltip = this.daemonAlive
            ? `Blamely daemon running — click for Changes`
            : `Blamely daemon offline — run: blamely daemon`;
        this.aiItem.tooltip = tooltip;
        this.humanItem.tooltip = tooltip;
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
        this.aiItem.dispose();
        this.humanItem.dispose();
    }
}

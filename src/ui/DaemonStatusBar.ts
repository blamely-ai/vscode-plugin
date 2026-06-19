import * as http from 'http';
import * as vscode from 'vscode';
import { readDaemonPort, readDaemonSocket } from '../cli/paths';
import * as Logger from '../utils/Logger';

const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * DaemonStatusBar shows a dedicated status-bar lamp that turns green when the
 * blamely daemon is reachable and red when it is not. A /health ping fires
 * every 5 seconds so the icon updates immediately after the daemon starts or
 * stops — no manual refresh needed.
 *
 * The lamp sits to the right of the main Blamely attribution item.
 */
export class DaemonStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private timer: ReturnType<typeof setInterval> | null = null;
    // Hysteresis: only turn the lamp red after several CONSECUTIVE failed pings,
    // so a momentarily busy event loop or a daemon restart doesn't flap it.
    private consecutiveFailures = 0;
    private static readonly FAILURE_THRESHOLD = 3;
    private lastAlive = false;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            10000,
        );
        this.item.command = 'blamely.showDaemonStatus';
        this.item.show();
    }

    /** Start the heartbeat loop and do an immediate first check. */
    start(): void {
        void this.ping();
        this.timer = setInterval(() => void this.ping(), HEARTBEAT_INTERVAL_MS);
    }

    private async ping(): Promise<void> {
        if (await this.checkHealth()) {
            this.consecutiveFailures = 0;
            this.lastAlive = true;
        } else if (++this.consecutiveFailures >= DaemonStatusBar.FAILURE_THRESHOLD) {
            this.lastAlive = false;
        }
        const alive = this.lastAlive;
        if (alive) {
            this.item.text = '$(circle-filled) blamely';
            this.item.color = new vscode.ThemeColor('charts.green');
            this.item.tooltip = 'Blamely daemon is running — click for status';
        } else {
            this.item.text = '$(circle-filled) blamely';
            this.item.color = new vscode.ThemeColor('charts.red');
            this.item.tooltip =
                'Blamely daemon is offline — run `blamely daemon` to start it';
        }
    }

    private checkHealth(): Promise<boolean> {
        return new Promise((resolve) => {
            const sock = readDaemonSocket();
            const port = sock == null ? readDaemonPort() : null;
            if (sock == null && port == null) {
                Logger.debugConn('/health skipped: no daemon socket/port file');
                resolve(false);
                return;
            }
            const via = sock != null ? 'unix' : `tcp:${port}`;
            const t0 = Date.now();
            const done = (ok: boolean, why?: string) => {
                Logger.debugConn(`/health ${ok ? 'ok' : 'FAIL'} via ${via} (${Date.now() - t0}ms)${why ? ' ' + why : ''} [fails=${ok ? 0 : this.consecutiveFailures + 1}]`);
                resolve(ok);
            };
            const opts: http.RequestOptions = { path: '/health', method: 'GET', timeout: 3_000 };
            if (sock != null) { opts.socketPath = sock; } else { opts.host = '127.0.0.1'; opts.port = port!; }
            const req = http.request(opts, (res) => { res.resume(); done(res.statusCode === 200, `status=${res.statusCode}`); });
            req.on('error', (e) => done(false, e.message));
            req.on('timeout', () => { req.destroy(); done(false, 'timeout'); });
            req.end();
        });
    }

    dispose(): void {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.item.dispose();
    }
}

import * as http from 'http';
import * as vscode from 'vscode';
import { readDaemonPort, readDaemonSocket } from '../cli/paths';

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
        const alive = await this.checkHealth();
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
            if (sock == null && port == null) { resolve(false); return; }
            const opts: http.RequestOptions = { path: '/health', method: 'GET', timeout: 2_000 };
            if (sock != null) { opts.socketPath = sock; } else { opts.host = '127.0.0.1'; opts.port = port!; }
            const req = http.request(opts, (res) => { res.resume(); resolve(res.statusCode === 200); });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
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

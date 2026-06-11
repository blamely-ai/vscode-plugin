import * as http from 'http';
import { readDaemonPort, readDaemonSocket } from '../cli/paths';
import * as Logger from '../utils/Logger';

export interface EditRange {
    start: number;
    end: number;
    content_sha?: string;
}

export interface EditPayload {
    tool: string;
    confidence?: string;
    gen_type?: string;
    repo_path: string;
    file_path: string;
    model?: string;
    suggested_lines?: number;
    lines: EditRange[];
    raw_meta?: string;
    // Branch the editor was on when the edit was made. The daemon scopes
    // attribution by branch-based work session; resolved from repo if empty.
    branch?: string;
}

// DaemonClient posts attribution events to the blamely daemon's /edit endpoint.
// The daemon now uses a Unix domain socket at ~/.blamely/daemon.sock, which
// bypasses any network-level security tools that intercept localhost TCP.
// Falls back to the TCP port file for backward compat with old daemons.
export class DaemonClient {
    private lastWarnAt = 0;

    async send(payload: EditPayload): Promise<boolean> {
        const sock = readDaemonSocket();
        const port = sock == null ? readDaemonPort() : null;
        if (sock == null && port == null) {
            this.maybeWarn('daemon socket/port file missing (blamely daemon not running?)');
            return false;
        }
        try {
            await this.post(sock, port, payload);
            return true;
        } catch (err) {
            this.maybeWarn(`POST /edit failed: ${(err as Error).message}`);
            return false;
        }
    }

    private post(sock: string | null, port: number | null, payload: EditPayload): Promise<void> {
        return new Promise((resolve, reject) => {
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            const opts: http.RequestOptions = {
                path: '/edit',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                },
                timeout: 1500,
            };
            if (sock != null) {
                opts.socketPath = sock;
            } else {
                opts.host = '127.0.0.1';
                opts.port = port!;
            }
            const req = http.request(opts, (res) => {
                res.resume();
                if (res.statusCode === 204) {
                    resolve();
                } else {
                    reject(new Error(`daemon returned ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.write(body);
            req.end();
        });
    }

    // Throttle warnings so a stopped daemon doesn't spam the log on every
    // keystroke.
    private maybeWarn(msg: string): void {
        const now = Date.now();
        if (now - this.lastWarnAt < 30_000) return;
        this.lastWarnAt = now;
        Logger.warn(`DaemonClient: ${msg}`);
    }
}

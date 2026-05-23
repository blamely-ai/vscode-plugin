import * as http from 'http';
import { readDaemonPort } from '../cli/paths';
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
}

// DaemonClient posts attribution events to the blamely daemon's /edit HTTP
// endpoint. The daemon listens on a random localhost port written to
// ~/.blamely/daemon.port; we re-read that file on every failure so a
// daemon restart (which picks a new port) heals automatically.
export class DaemonClient {
    private cachedPort: number | null = null;
    private lastWarnAt = 0;

    async send(payload: EditPayload): Promise<boolean> {
        const port = this.resolvePort();
        if (port == null) {
            this.maybeWarn('daemon port file missing (blamely daemon not running?)');
            return false;
        }
        try {
            await this.post(port, payload);
            return true;
        } catch (err) {
            // Invalidate cache so the next call re-reads the port file —
            // covers the daemon-restart-with-new-port case.
            this.cachedPort = null;
            this.maybeWarn(`POST /edit failed: ${(err as Error).message}`);
            return false;
        }
    }

    private resolvePort(): number | null {
        if (this.cachedPort != null) return this.cachedPort;
        const p = readDaemonPort();
        if (p != null) this.cachedPort = p;
        return p;
    }

    private post(port: number, payload: EditPayload): Promise<void> {
        return new Promise((resolve, reject) => {
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/edit',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': body.length,
                    },
                    timeout: 1500,
                },
                (res) => {
                    res.resume();
                    if (res.statusCode === 204) {
                        resolve();
                    } else {
                        reject(new Error(`daemon returned ${res.statusCode}`));
                    }
                }
            );
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

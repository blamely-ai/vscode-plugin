import * as http from 'http';
import { readDaemonPort, readDaemonSocket } from '../cli/paths';
import * as Logger from '../utils/Logger';

export interface EditRange {
    start: number;
    end: number;
    content_sha?: string;
}

// Content hashes of lines an edit DELETED (no position — deleted lines have no
// stable post-edit location). The daemon matches these against a commit's diff
// "-" lines to attribute the deletion. Mirrors the Go RemovedLineHash.
export interface RemovedLineHash {
    content_sha: string;
    content_sha_norm?: string;
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
    // Hashes of lines this edit removed (file deletion / replaced content).
    removed_lines?: RemovedLineHash[];
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
        const via = sock != null ? 'unix' : `tcp:${port}`;
        const t0 = Date.now();
        try {
            await this.request(sock, port, 'POST', '/edit', payload);
            Logger.debugConn(`POST /edit ok via ${via} (${Date.now() - t0}ms) ${payload.tool}/${payload.gen_type ?? '?'} ${payload.file_path} lines=${payload.lines.length}`);
            return true;
        } catch (err) {
            Logger.debugConn(`POST /edit FAILED via ${via} (${Date.now() - t0}ms): ${(err as Error).message}`);
            this.maybeWarn(`POST /edit failed: ${(err as Error).message}`);
            return false;
        }
    }

    /**
     * Stores the pre-chat file content in the daemon so the chat watcher can
     * use it as an accurate diff baseline. Call this right after send() returns
     * true for a chat-apply edit, passing prevText (the document content before
     * the AI applied its changes). Fire-and-forget: failures are silently ignored
     * since this is a best-effort optimisation, not a required step.
     */
    async putSnapshot(repoPath: string, filePath: string, content: string): Promise<void> {
        const sock = readDaemonSocket();
        const port = sock == null ? readDaemonPort() : null;
        if (sock == null && port == null) { return; }
        try {
            await this.request(sock, port, 'PUT', '/snapshot', { repo: repoPath, file: filePath, content });
        } catch {
            // best-effort — watcher falls back to recording all lines
        }
    }

    private request(
        sock: string | null, port: number | null,
        method: string, path: string, body: object,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
            const opts: http.RequestOptions = {
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': bodyBuf.length,
                },
                // 4s, not 1.5s: /edit does real work (session resolve, SQLite
                // write, snapshot) and can briefly exceed a tight timeout on
                // Windows or while the extension-host event loop is busy. A
                // too-short timeout aborts an edit the daemon would have stored,
                // and skips the follow-up putSnapshot — hurting attribution.
                timeout: 4000,
            };
            if (sock != null) {
                opts.socketPath = sock;
            } else {
                opts.host = '127.0.0.1';
                opts.port = port!;
            }
            const req = http.request(opts, (res) => {
                res.resume();
                if (res.statusCode === 204 || res.statusCode === 200) {
                    resolve();
                } else {
                    reject(new Error(`daemon returned ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.write(bodyBuf);
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

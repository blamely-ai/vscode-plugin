import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as http from 'http';
import {
    blamelyHome,
    daemonPortPath,
    daemonSocketPath,
    gitHooksDir,
    installedBinaryPath,
    readDaemonPort,
    readDaemonSocket,
    statePath,
} from './paths';
import { DaemonStatus } from './types';

const execFileAsync = promisify(execFile);

export type CliHealthStatus = 'healthy' | 'not_installed' | 'daemon_offline' | 'git_hook_misconfigured';

export interface CliHealthReport {
    status: CliHealthStatus;
    title: string;
    message: string;
    detail?: string;
    installUrl: string;
    daemon?: DaemonStatus;
}

const INSTALL_URL = 'https://blamely.ai';

function blamelyDirExists(): boolean {
    try {
        return fs.existsSync(blamelyHome());
    } catch {
        return false;
    }
}

function isCliInstalled(): boolean {
    try {
        if (fs.existsSync(statePath())) return true;
        if (fs.existsSync(installedBinaryPath())) return true;
        if (fs.existsSync(daemonPortPath())) return true;
        if (fs.existsSync(daemonSocketPath())) return true;
        if (fs.existsSync(path.join(blamelyHome(), 'db.sqlite'))) return true;
    } catch {
        /* ignore */
    }
    return false;
}

async function probeDaemon(): Promise<DaemonStatus> {
    const sock = readDaemonSocket();
    const port = sock == null ? readDaemonPort() : null;
    if (sock == null && port == null) {
        return { running: false };
    }
    return new Promise(resolve => {
        const opts: http.RequestOptions = { path: '/health', timeout: 800 };
        if (sock != null) {
            opts.socketPath = sock;
        } else {
            opts.host = '127.0.0.1';
            opts.port = port!;
        }
        const req = http.get(opts, res => {
            let body = '';
            res.on('data', (c: string) => { body += c; });
            res.on('end', () => {
                resolve({
                    running: res.statusCode === 200 && body.includes('"ok"'),
                    port: port ?? undefined,
                });
            });
        });
        req.on('error', () => resolve({ running: false, port: port ?? undefined }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ running: false, port: port ?? undefined });
        });
    });
}

async function readGlobalGitHooksPath(): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('git', ['config', '--global', 'core.hooksPath'], { timeout: 3000 });
        const val = stdout.trim();
        return val ? path.normalize(val) : null;
    } catch {
        return null;
    }
}

function gitHookConfigured(hooksPath: string | null): boolean {
    if (!hooksPath) return false;
    const expected = path.normalize(gitHooksDir());
    if (hooksPath === expected) return true;
    return hooksPath.replace(/\\/g, '/').endsWith('/.blamely/git-hooks')
        || hooksPath.replace(/\\/g, '/').endsWith('/git-hooks');
}

/** Lightweight install/daemon/hook checks — mirrors key `blamely doctor` signals. */
export async function checkCliHealth(): Promise<CliHealthReport> {
    const installUrl = INSTALL_URL;

    if (!blamelyDirExists() || !isCliInstalled()) {
        return {
            status: 'not_installed',
            title: 'Blamely CLI not installed',
            message:
                'This extension reads attribution from the Blamely CLI (oobeya-cli). ' +
                'Install it from blamely.ai, then run `blamely install` in a terminal.',
            detail: 'Without the CLI, runtime edits and commit reports will not be captured.',
            installUrl,
            daemon: { running: false },
        };
    }

    const daemon = await probeDaemon();
    if (!daemon.running) {
        return {
            status: 'daemon_offline',
            title: 'Blamely daemon offline',
            message:
                'The Blamely daemon is not responding. Run `blamely install` to re-register it, ' +
                'or inspect ~/.blamely/daemon.log for errors.',
            detail: daemon.port
                ? `Port file exists (${daemon.port}) but /health did not respond.`
                : 'No daemon.sock or daemon.port file — the daemon may never have started.',
            installUrl,
            daemon,
        };
    }

    const hooksPath = await readGlobalGitHooksPath();
    if (!gitHookConfigured(hooksPath)) {
        return {
            status: 'git_hook_misconfigured',
            title: 'Blamely git hook not configured',
            message:
                'Global git core.hooksPath is not pointing at ~/.blamely/git-hooks. ' +
                'Run `blamely install` so commit reports are written to git notes.',
            detail: hooksPath
                ? `Current core.hooksPath: ${hooksPath}`
                : 'core.hooksPath is not set.',
            installUrl,
            daemon,
        };
    }

    return {
        status: 'healthy',
        title: 'Blamely CLI healthy',
        message: daemon.port ? `Daemon running on port ${daemon.port}.` : 'Daemon running via Unix socket.',
        installUrl,
        daemon,
    };
}

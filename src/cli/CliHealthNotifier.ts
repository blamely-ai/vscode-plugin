import * as vscode from 'vscode';
import { checkCliHealth, CliHealthReport, CliHealthStatus } from './CliHealth';

const CHECK_INTERVAL_MS = 30_000;
// Delay the one-shot startup check so a daemon still coming up at IDE open (or a
// port file mid-rewrite) doesn't trigger a false "offline" popup.
const STARTUP_DELAY_MS = 4_000;
const INSTALL_URL = 'https://blamely.ai';

/**
 * Surfaces oobeya-cli problems. The daemon-offline warning is shown at most ONCE
 * per session — a single popup at IDE startup. After that it never auto-pops
 * again (it was flapping too often); the user reads the status-bar lamp and
 * clicks it (blamely.showDaemonStatus → showStatusNow) to see details on demand.
 * Stable install/git-hook problems still notify when they first appear.
 */
export class CliHealthNotifier implements vscode.Disposable {
    private timer?: NodeJS.Timeout;
    private startupTimer?: NodeJS.Timeout;
    private lastStatus: CliHealthStatus | null = null;
    private disposed = false;

    start(): void {
        this.startupTimer = setTimeout(() => void this.evaluate(true), STARTUP_DELAY_MS);
        this.timer = setInterval(() => void this.evaluate(false), CHECK_INTERVAL_MS);
    }

    private async evaluate(isStartup: boolean): Promise<void> {
        if (this.disposed) return;
        const report = await checkCliHealth();
        if (report.status === 'healthy') {
            this.lastStatus = 'healthy';
            return;
        }
        // The daemon going offline is the noisy/flaky case: auto-notify only at
        // the startup check. On every later (periodic) check, just remember the
        // state silently — no popup. The lamp shows it; clicking shows details.
        if (report.status === 'daemon_offline' && !isStartup) {
            this.lastStatus = report.status;
            return;
        }
        if (!isStartup && report.status === this.lastStatus) {
            return;
        }
        this.lastStatus = report.status;
        await this.showNotification(report);
    }

    /**
     * On-demand status check, wired to the status-bar lamp click. Always shows
     * the current health — a confirmation when healthy, the fixable warning when
     * not — bypassing the once-per-session throttling above.
     */
    async showStatusNow(): Promise<void> {
        if (this.disposed) return;
        const report = await checkCliHealth();
        this.lastStatus = report.status;
        if (report.status === 'healthy') {
            const where = report.daemon?.port ? `port ${report.daemon.port}` : 'a Unix socket';
            void vscode.window.showInformationMessage(`Blamely: daemon running on ${where}.`);
            return;
        }
        await this.showNotification(report);
    }

    private async showNotification(report: CliHealthReport): Promise<void> {
        const openGuide = 'Open install guide';
        const openDoctor = 'Show fix steps';
        const dismiss = 'Dismiss';

        const choice = await vscode.window.showWarningMessage(
            `${report.title}: ${report.message}`,
            openGuide,
            openDoctor,
            dismiss
        );

        if (choice === openGuide) {
            await vscode.env.openExternal(vscode.Uri.parse(report.installUrl || INSTALL_URL));
            return;
        }
        if (choice === openDoctor) {
            const steps = buildFixSteps(report);
            const doc = await vscode.workspace.openTextDocument({
                content: steps,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
        }
        if (this.timer) {
            clearInterval(this.timer);
        }
    }
}

function buildFixSteps(report: CliHealthReport): string {
    const lines = [
        `# ${report.title}`,
        '',
        report.message,
        '',
    ];
    if (report.detail) {
        lines.push(`> ${report.detail}`, '');
    }
    lines.push(
        '## Recommended steps',
        '',
        '1. Install Blamely CLI from [blamely.ai](https://blamely.ai)',
        '2. In a terminal, run:',
        '',
        '```bash',
        'blamely install',
        '```',
        '',
        '3. Verify everything is healthy:',
        '',
        '```bash',
        'blamely doctor',
        'blamely status',
        '```',
        '',
        '## If the daemon still will not start',
        '',
        '- Check `~/.blamely/daemon.log`',
        '- Re-run `blamely install` (idempotent)',
        '- Restart your IDE after install',
    );
    return lines.join('\n');
}

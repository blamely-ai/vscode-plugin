import * as vscode from 'vscode';
import { checkCliHealth, CliHealthReport, CliHealthStatus } from './CliHealth';

const CHECK_INTERVAL_MS = 30_000;
const INSTALL_URL = 'https://blamely.ai';

/**
 * Shows a user-visible warning when oobeya-cli is missing or misconfigured.
 * Notifies once per issue per session; re-notifies when status changes.
 */
export class CliHealthNotifier implements vscode.Disposable {
    private timer?: NodeJS.Timeout;
    private lastStatus: CliHealthStatus | null = null;
    private disposed = false;

    start(): void {
        void this.evaluate(true);
        this.timer = setInterval(() => void this.evaluate(false), CHECK_INTERVAL_MS);
    }

    private async evaluate(forceOnStartup: boolean): Promise<void> {
        if (this.disposed) return;
        const report = await checkCliHealth();
        if (report.status === 'healthy') {
            this.lastStatus = 'healthy';
            return;
        }
        if (!forceOnStartup && report.status === this.lastStatus) {
            return;
        }
        this.lastStatus = report.status;
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

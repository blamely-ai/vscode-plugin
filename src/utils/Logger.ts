let outputChannel: any;

function getChannel(): any {
    if (!outputChannel) {
        try {
            const vscode = require('vscode');
            outputChannel = vscode.window.createOutputChannel('AI Trace');
        } catch {
            // Running outside VSCode (e.g., in tests) — use console
            outputChannel = {
                appendLine: (msg: string) => console.log(msg),
                show: () => { },
                dispose: () => { },
            };
        }
    }
    return outputChannel;
}

export function info(message: string): void {
    getChannel().appendLine(`[INFO  ${new Date().toISOString()}] ${message}`);
}

export function warn(message: string): void {
    getChannel().appendLine(`[WARN  ${new Date().toISOString()}] ${message}`);
}

export function error(message: string, err?: unknown): void {
    const suffix = err instanceof Error ? `: ${err.message}` : '';
    getChannel().appendLine(`[ERROR ${new Date().toISOString()}] ${message}${suffix}`);
}

export function show(): void {
    getChannel().show(true);
}

export function dispose(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}

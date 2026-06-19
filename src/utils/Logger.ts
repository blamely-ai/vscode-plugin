let outputChannel: any;

function getChannel(): any {
    if (!outputChannel) {
        try {
            const vscode = require('vscode');
            outputChannel = vscode.window.createOutputChannel('Blamely');
        } catch {
            outputChannel = {
                appendLine: (_msg: string) => { },
                show: () => { },
                dispose: () => { },
            };
        }
    }
    return outputChannel;
}

function emit(level: 'info' | 'warn' | 'error', line: string): void {
    getChannel().appendLine(line);
    const prefixed = `[Blamely] ${line}`;
    if (level === 'info') {
        console.log(prefixed);
    } else if (level === 'warn') {
        console.warn(prefixed);
    } else {
        console.error(prefixed);
    }
}

export function info(message: string): void {
    emit('info', `[INFO  ${new Date().toISOString()}] ${message}`);
}

export function warn(message: string): void {
    emit('warn', `[WARN  ${new Date().toISOString()}] ${message}`);
}

/** Logged when `blamely.debugDetection` is enabled (matches IntelliJ debug gutter logs). */
export function debug(message: string): void {
    try {
        const vscode = require('vscode');
        if (!vscode.workspace.getConfiguration('blamely').get('debugDetection', false)) {
            return;
        }
    } catch {
        return;
    }
    emit('info', `[DEBUG ${new Date().toISOString()}] ${message}`);
}

/** Logged when `blamely.debugConnection` is enabled — daemon↔plugin traffic. */
export function debugConn(message: string): void {
    try {
        const vscode = require('vscode');
        if (!vscode.workspace.getConfiguration('blamely').get('debugConnection', false)) {
            return;
        }
    } catch {
        return;
    }
    emit('info', `[CONN  ${new Date().toISOString()}] ${message}`);
}

export function error(message: string, err?: unknown): void {
    const suffix = err instanceof Error ? `: ${err.message}` : '';
    emit('error', `[ERROR ${new Date().toISOString()}] ${message}${suffix}`);
}

export function show(): void {
    getChannel().show(true);
}

export function dispose(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}

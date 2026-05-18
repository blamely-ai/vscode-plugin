let outputChannel: any;

function getChannel(): any {
    if (!outputChannel) {
        try {
            const vscode = require('vscode');
            outputChannel = vscode.window.createOutputChannel('Blamely');
        } catch {
            // Running outside VSCode (e.g., in tests) — emit() writes to console
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
    /* Always mirror to Debug Console — some hosts hide or alias unprefixed extension logs. */
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

export function error(message: string, err?: unknown): void {
    const suffix = err instanceof Error ? `: ${err.message}` : '';
    emit('error', `[ERROR ${new Date().toISOString()}] ${message}${suffix}`);
}

export function show(): void {
    getChannel().show(true);
}

/** Append lines without the standard [INFO ISO...] prefix (e.g. post-commit attribution bar block). */
export function appendPlainBlock(text: string): void {
    const ch = getChannel();
    for (const line of text.split('\n')) {
        ch.appendLine(line);
    }
}

export function dispose(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}

/** When `blamely.debugChatAttribution` is true, log to the Blamely output channel (prefix [CHAT-DEBUG]). */
export function chatDebug(message: string): void {
    const line = `[CHAT-DEBUG ${new Date().toISOString()}] ${message}`;
    console.log('[Blamely]', line);
    try {
        const vscode = require('vscode') as {
            workspace: { getConfiguration: (s: string) => { get: <T>(k: string) => T | undefined } };
        };
        if (!vscode.workspace.getConfiguration('blamely').get<boolean>('debugChatAttribution')) {
            return;
        }
        getChannel().appendLine(line);
    } catch {
        /* tests / non-VS Code */
    }
}

/** When `blamely.debugInlineCompletion` is true, log inline-completion interception (Output + Debug Console). Prefix [INLINE-DEBUG]. */
export function completionDebug(message: string): void {
    try {
        const vscode = require('vscode') as {
            workspace: { getConfiguration: (s: string) => { get: <T>(k: string) => T | undefined } };
        };
        if (!vscode.workspace.getConfiguration('blamely').get<boolean>('debugInlineCompletion')) {
            return;
        }
        const line = `[INLINE-DEBUG ${new Date().toISOString()}] ${message}`;
        getChannel().appendLine(line);
        console.log('[Blamely]', line);
    } catch {
        /* tests / non-VS Code */
    }
}

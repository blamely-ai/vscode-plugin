import * as path from 'path';

export function isWindows(): boolean {
    return process.platform === 'win32';
}

export function isMac(): boolean {
    return process.platform === 'darwin';
}

export function isLinux(): boolean {
    return process.platform === 'linux';
}

export function normalizePath(filePath: string): string {
    return filePath.split(path.sep).join(path.posix.sep);
}

export function shellCommand(cmd: string): string {
    if (isWindows()) {
        return `cmd.exe /c "${cmd}"`;
    }
    return cmd;
}

export function hookScriptContent(extensionPath: string): string {
    const runner = path.join(extensionPath, 'out', 'hookRunner.js');
    if (isWindows()) {
        return `@echo off\r\nnode "${runner.replace(/\//g, '\\\\')}"\r\nIF %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%\r\n`;
    }
    return `#!/bin/sh\nnode "${runner}"\n`;
}

export function hookBatWrapper(extensionPath: string): string {
    const runner = path.join(extensionPath, 'out', 'hookRunner.js').replace(/\//g, '\\\\');
    return `@echo off\r\nnode "${runner}"\r\nIF %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%\r\n`;
}

export function encodeFilePath(relativePath: string): string {
    return relativePath.replace(/[/\\]/g, '__');
}

export function decodeFilePath(encoded: string): string {
    return encoded.replace(/__/g, path.posix.sep);
}

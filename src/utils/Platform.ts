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

function winCmdQuoteArg(p: string): string {
    return '"' + p.replace(/"/g, '""') + '"';
}

/** Escape for double-quoted POSIX sh argument (minimal set). */
function shEscapeDoubleQuoted(p: string): string {
    return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

/**
 * Pre-commit hook body: runs hookRunner from the per-repo Blamely data dir (see GitUtils.getBlamelyDataDir),
 * installed by GitHookInstaller — not from the extension path.
 */
export function hookScriptContent(hookRunnerAbsolutePath: string): string {
    if (isWindows()) {
        return [
            '@echo off',
            `node ${winCmdQuoteArg(hookRunnerAbsolutePath)}`,
            'IF %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%',
            '',
        ].join('\r\n');
    }
    return [
        '#!/bin/sh',
        `exec node "${shEscapeDoubleQuoted(path.normalize(hookRunnerAbsolutePath))}"`,
        '',
    ].join('\n');
}

export function hookBatWrapper(hookRunnerAbsolutePath: string): string {
    return [
        '@echo off',
        `node ${winCmdQuoteArg(hookRunnerAbsolutePath)}`,
        'IF %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%',
        '',
    ].join('\r\n');
}

export function encodeFilePath(relativePath: string): string {
    return relativePath.replace(/[/\\]/g, '__');
}

export function decodeFilePath(encoded: string): string {
    return encoded.replace(/__/g, path.posix.sep);
}

/**
 * Decode workspace path from VS Code Git extension `git:` URI query JSON (`path` + `ref`, etc.).
 * Matches vscode `extensions/git/src/uri.ts` `toGitUri`.
 */
export function workspacePathFromGitExtensionUriQuery(query: string): string | undefined {
    try {
        const q = JSON.parse(query) as { path?: string };
        if (typeof q.path === 'string' && q.path.length > 0) {
            return normalizePath(q.path);
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

/** Written under `<git-dir>/blamely/` (not the working tree); read by `hookRunner.js`. */
export const BLAMELY_REPO_DETECTOR_FILENAME = 'blamely-detector.ai';

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
 * Pre-commit hook: try primary runner (~/.blamely/repos/…), then `.git/blamely/hookRunner.js`.
 * If neither exists, exit 0 so commits are not blocked (re-run Blamely “Install Git Hook” to restore files).
 */
export function hookScriptContent(hookRunnerPrimaryPath: string, hookRunnerFallbackPath: string): string {
    const pq = shEscapeDoubleQuoted(path.normalize(hookRunnerPrimaryPath));
    const fq = shEscapeDoubleQuoted(path.normalize(hookRunnerFallbackPath));
    if (isWindows()) {
        const pqw = winCmdQuoteArg(path.normalize(hookRunnerPrimaryPath));
        const fqw = winCmdQuoteArg(path.normalize(hookRunnerFallbackPath));
        return [
            '@echo off',
            `IF EXIST ${pqw} (`,
            `  node ${pqw} %*`,
            `  exit /b %ERRORLEVEL%`,
            `)`,
            `IF EXIST ${fqw} (`,
            `  node ${fqw} %*`,
            `  exit /b %ERRORLEVEL%`,
            `)`,
            `echo [blamely] hookRunner.js missing — skipping pre-commit helper ^(run Blamely: Install Git Hook^)`,
            'exit /b 0',
            '',
        ].join('\r\n');
    }
    return [
        '#!/bin/sh',
        `if [ -f "${pq}" ]; then`,
        `  exec node "${pq}" "$@"`,
        `fi`,
        `if [ -f "${fq}" ]; then`,
        `  exec node "${fq}" "$@"`,
        `fi`,
        `echo "[blamely] hookRunner.js missing — skipping pre-commit helper (run Blamely: Install Git Hook)"`,
        'exit 0',
        '',
    ].join('\n');
}

export function hookBatWrapper(hookRunnerPrimaryPath: string, hookRunnerFallbackPath: string): string {
    const pqw = winCmdQuoteArg(path.normalize(hookRunnerPrimaryPath));
    const fqw = winCmdQuoteArg(path.normalize(hookRunnerFallbackPath));
    return [
        '@echo off',
        `IF EXIST ${pqw} (`,
        `  node ${pqw} %*`,
        `  exit /b %ERRORLEVEL%`,
        `)`,
        `IF EXIST ${fqw} (`,
        `  node ${fqw} %*`,
        `  exit /b %ERRORLEVEL%`,
        `)`,
        `echo [blamely] hookRunner.js missing — skipping`,
        'exit /b 0',
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

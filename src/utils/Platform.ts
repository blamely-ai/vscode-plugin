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
 * Pre-commit hook: run hookRunner.js from ~/.blamely/repos/<repoKey>/hookRunner.js only
 * (no writes under .git/blamely). Duplicate path args keep parity with older two-path installers.
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

/** If path is a persisted blame sidecar (.../snapshots/.../*.blame.json), return the source blame key. */
export function blameKeyFromSnapshotSidecarPath(pathStr: string): string | null {
    const norm = normalizePath(pathStr.replace(/\\/g, '/'));
    const parts = norm.split('/').filter(p => p.length > 0);
    let snapIdx = -1;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'snapshots') {
            snapIdx = i;
        }
    }
    if (snapIdx === -1 || snapIdx + 1 >= parts.length) {
        return null;
    }
    const before = parts.slice(0, snapIdx);
    let last = parts[parts.length - 1];
    let low = last.toLowerCase();
    const suf = '.blame.json';
    while (low.endsWith(suf)) {
        last = last.slice(0, -suf.length);
        low = last.toLowerCase();
    }
    if (!last) {
        return null;
    }
    let decoded = decodeFilePath(last);
    let out = normalizePath(decoded.replace(/\\/g, '/'));
    const outLow = out.toLowerCase();
    if (outLow.includes('/.blamely/') && outLow.includes('/snapshots/')) {
        out = path.posix.basename(out);
    }
    if (before.length === 1 && before[0] !== 'logs') {
        return normalizePath(`${before[0]}/${out}`);
    }
    return out;
}

/**
 * Blame persistence key for *.blame.json files — never a snapshot sidecar path or a *.blame.json key
 * (avoids ...foo.blame.json.blame.json when a snapshot file is open).
 */
export function normalizeBlamePersistenceKey(filePath: string, workspaceRoot?: string): string {
    const snap = blameKeyFromSnapshotSidecarPath(filePath);
    if (snap) {
        return snap;
    }
    if (workspaceRoot) {
        try {
            const rel = path.relative(path.normalize(workspaceRoot), path.normalize(filePath));
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                const snap2 = blameKeyFromSnapshotSidecarPath(rel);
                if (snap2) {
                    return snap2;
                }
            }
        } catch {
            /* ignore */
        }
    }
    let k = normalizePath(filePath.replace(/\\/g, '/'));
    while (k.toLowerCase().endsWith('.blame.json')) {
        k = k.slice(0, -'.blame.json'.length);
    }
    return k;
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

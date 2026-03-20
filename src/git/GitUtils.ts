import { exec } from 'child_process';
import * as path from 'path';
import * as Logger from '../utils/Logger';
import { isWindows } from '../utils/Platform';

function run(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const shell = isWindows() ? 'cmd.exe' : '/bin/sh';
        exec(cmd, { cwd, shell }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`${cmd} failed: ${stderr || err.message}`));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

async function runSafe(cwd: string, ...args: string[]): Promise<string | null> {
    try {
        const cmd = `git ${args.map(a => (a.includes(' ') || a.includes('^') ? `"${a}"` : a)).join(' ')}`;
        return await run(cmd, cwd);
    } catch {
        return null;
    }
}

export interface FileDiffStats {
    addedLines: number[];
    deletedLines: number[];
    addedCount: number;
    deletedCount: number;
}

/** Paths (repo-relative) of files changed in the given commit. */
export async function getFilesChangedInCommit(cwd: string, commitSha: string): Promise<string[]> {
    let out = await runSafe(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', commitSha);
    if (!out?.trim()) {
        const hasParent = await runSafe(cwd, 'rev-parse', `${commitSha}^`) != null;
        if (!hasParent) {
            out = await runSafe(cwd, 'ls-tree', '-r', '--name-only', commitSha);
        }
    }
    if (!out?.trim()) return [];
    return out
        .split('\n')
        .map(s => s.trim().replace(/\\/g, '/'))
        .filter(Boolean);
}

/**
 * Parse unified diff for a file in a commit. Added lines are 1-based in the NEW file; deleted in the OLD file.
 */
export async function getDiffStats(
    cwd: string,
    commitSha: string,
    filePathRepoRelative: string
): Promise<FileDiffStats> {
    const out = await runSafe(cwd, 'show', commitSha, '-p', '--', filePathRepoRelative);
    if (!out) return { addedLines: [], deletedLines: [], addedCount: 0, deletedCount: 0 };
    const added: number[] = [];
    const deleted: number[] = [];
    let currentNewLine = 0;
    let currentOldLine = 0;
    const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
    for (const line of out.split('\n')) {
        const hunk = hunkRe.exec(line);
        if (hunk) {
            currentOldLine = parseInt(hunk[1], 10) || 0;
            currentNewLine = parseInt(hunk[2], 10) || 0;
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            added.push(currentNewLine);
            currentNewLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            deleted.push(currentOldLine);
            currentOldLine++;
        } else if (line.startsWith(' ')) {
            currentNewLine++;
            currentOldLine++;
        }
    }
    return {
        addedLines: added,
        deletedLines: deleted,
        addedCount: added.length,
        deletedCount: deleted.length,
    };
}

/** Convert repo-relative paths to workspace-relative. Returns Map(repoRelative -> projectRelative). */
export function repoRelativeToProjectRelative(
    repoRoot: string,
    workspaceRoot: string | null,
    repoRelativePaths: string[]
): Map<string, string> {
    const result = new Map<string, string>();
    const norm = (s: string) => path.normalize(s).replace(/\\/g, '/').replace(/\/$/, '');
    if (!workspaceRoot?.trim()) {
        repoRelativePaths.forEach(p => result.set(p.replace(/\\/g, '/'), p.replace(/\\/g, '/')));
        return result;
    }
    const normRepo = norm(repoRoot);
    const normWs = norm(workspaceRoot);
    const normalizedPaths = repoRelativePaths.map(p => p.replace(/\\/g, '/'));
    if (normWs === normRepo) {
        normalizedPaths.forEach(p => result.set(p, p));
        return result;
    }
    if (!normWs.startsWith(normRepo + '/')) {
        normalizedPaths.forEach(p => result.set(p, p));
        return result;
    }
    const prefix = normWs.slice(normRepo.length + 1) + '/';
    for (const p of normalizedPaths) {
        if (p === prefix.slice(0, -1)) result.set(p, '');
        else if (p.startsWith(prefix)) result.set(p, p.slice(prefix.length));
        else result.set(p, p);
    }
    return result;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
    try {
        await run('git rev-parse --is-inside-work-tree', cwd);
        return true;
    } catch {
        return false;
    }
}

export async function gitAdd(files: string[], cwd: string): Promise<void> {
    try {
        const fileArgs = files.map(f => `"${f}"`).join(' ');
        await run(`git add ${fileArgs}`, cwd);
        Logger.info(`Staged files: ${files.join(', ')}`);
    } catch (err) {
        Logger.error('Failed to stage files', err);
    }
}

export async function getLatestCommitSha(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse HEAD', cwd);
    } catch {
        return null;
    }
}

/** Resolve a short or full commit SHA to full 40-char SHA. */
export async function resolveCommitSha(cwd: string, ref: string): Promise<string | null> {
    try {
        return await run(`git rev-parse ${ref}`, cwd);
    } catch {
        return null;
    }
}

export async function getShortSha(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse --short=8 HEAD', cwd);
    } catch {
        return null;
    }
}

export async function getGitDir(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse --git-dir', cwd);
    } catch {
        return null;
    }
}

/** Repository root (absolute path). */
export async function getRepoRoot(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse --show-toplevel', cwd);
    } catch {
        return null;
    }
}

export async function getBranch(cwd: string): Promise<string | null> {
    try {
        return await run('git rev-parse --abbrev-ref HEAD', cwd);
    } catch {
        return null;
    }
}

export async function getCommitMessage(cwd: string): Promise<string | null> {
    try {
        return await run('git log -1 --pretty=%B', cwd);
    } catch {
        return null;
    }
}

export async function getAiTraceDir(cwd: string): Promise<string | null> {
    const gitDir = await getGitDir(cwd);
    if (!gitDir) return null;
    const path = require('path');
    return path.resolve(cwd, gitDir, 'ai-trace');
}

export async function addGitNote(sha: string, content: string, cwd: string): Promise<void> {
    try {
        // Use a temporary file to pass the content to avoid shell escaping issues with newlines
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const tmpPath = path.join(os.tmpdir(), `ai-trace-note-${sha}.txt`);
        await fs.promises.writeFile(tmpPath, content, 'utf-8');

        await run(`git notes --ref=ai-trace add -F "${tmpPath}" -f ${sha}`, cwd);
        await fs.promises.unlink(tmpPath);
        Logger.info(`Added git note to commit ${sha}`);
    } catch (err) {
        Logger.error(`Failed to add git note to ${sha}`, err);
    }
}

/** Files with uncommitted changes (staged + unstaged), repo-relative. */
export async function getUncommittedFiles(cwd: string): Promise<Set<string>> {
    const result = new Set<string>();
    const unstaged = await runSafe(cwd, 'diff', '--name-only');
    const staged = await runSafe(cwd, 'diff', '--cached', '--name-only');
    for (const out of [unstaged, staged]) {
        if (out?.trim()) {
            for (const line of out.split('\n')) {
                const f = line.trim().replace(/\\/g, '/');
                if (f) result.add(f);
            }
        }
    }
    return result;
}

export async function pushGitNotes(cwd: string): Promise<void> {
    try {
        const remotes = await run('git remote', cwd);
        if (remotes.trim().length > 0) {
            await run('git push origin refs/notes/ai-trace', cwd);
            Logger.info('Pushed ai-trace notes to remote');
        }
    } catch (err) {
        Logger.warn(`Could not push git notes (might not have upstream access): ${err}`);
    }
}

/** Read git note content for a specific commit (from refs/notes/ai-trace). */
export async function getNoteContent(cwd: string, sha: string): Promise<string | null> {
    return runSafe(cwd, 'notes', '--ref=ai-trace', 'show', sha);
}

/** Public exported wrapper for arbitrary git commands (returns stdout or null). */
export async function runGitCommand(cwd: string, ...args: string[]): Promise<string | null> {
    return runSafe(cwd, ...args);
}

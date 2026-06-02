import { exec } from 'child_process';
import * as fs from 'fs';
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

export async function getRepoRoot(cwdOrFile: string): Promise<string | null> {
    try {
        let dir = path.normalize(cwdOrFile);
        try {
            const st = await fs.promises.stat(dir);
            if (!st.isDirectory()) {
                dir = path.dirname(dir);
            }
        } catch {
            dir = path.dirname(dir);
        }
        return await run('git rev-parse --show-toplevel', dir);
    } catch {
        return null;
    }
}

export async function getWorkingTreeChangedFiles(cwd: string): Promise<Set<string>> {
    const result = new Set<string>();
    for (const args of [['diff', '--name-only'], ['diff', '--cached', '--name-only']] as const) {
        const out = await runSafe(cwd, ...args);
        if (out?.trim()) {
            for (const line of out.split('\n')) {
                const f = line.trim().replace(/\\/g, '/');
                if (f) result.add(f);
            }
        }
    }
    const untracked = await runSafe(cwd, 'ls-files', '--others', '--exclude-standard');
    if (untracked?.trim()) {
        for (const line of untracked.split('\n')) {
            const f = line.trim().replace(/\\/g, '/');
            if (f) result.add(f);
        }
    }
    return result;
}

export async function getNoteContent(cwd: string, sha: string): Promise<string | null> {
    return runSafe(cwd, 'notes', '--ref=blamely', 'show', sha);
}

/**
 * Short name of the checked-out branch for the repo at [cwd], or null when HEAD
 * is detached. Used to tag edits with their branch-based work session.
 */
export async function getBranchName(cwd: string): Promise<string | null> {
    const out = await runSafe(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    const b = out?.trim();
    return b ? b : null;
}

/**
 * Reports whether the repo at [cwd] is mid-way through a history-rewriting
 * operation (cherry-pick, merge, revert, rebase). Edits observed during these
 * are replays of existing content, not fresh authorship, so detectors pause.
 */
export async function inProgressGitOp(cwd: string): Promise<boolean> {
    const gitDir = (await runSafe(cwd, 'rev-parse', '--absolute-git-dir'))?.trim();
    if (!gitDir) return false;
    for (const marker of ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
        if (fs.existsSync(path.join(gitDir, marker))) return true;
    }
    return false;
}

export async function runGitCommand(cwd: string, ...args: string[]): Promise<string | null> {
    return runSafe(cwd, ...args);
}

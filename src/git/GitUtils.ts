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

/** Current HEAD, read straight out of the git dir. */
export interface HeadState {
    /** Tip commit, or null on an unborn branch (fresh `git init`, no commits). */
    sha: string | null;
    /** Branch name, or null when HEAD is detached. */
    branch: string | null;
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Directory holding this repo's refs. For a LINKED WORKTREE the per-worktree git
 * dir has its own HEAD and logs, but `refs/` and `packed-refs` live in the main
 * repo's git dir, pointed at by the `commondir` file.
 */
function commonDir(gitDir: string): string {
    try {
        const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (raw) return path.resolve(gitDir, raw);
    } catch {
        // no commondir → an ordinary git dir, refs are right here
    }
    return gitDir;
}

/** Resolve a full ref name (`refs/heads/main`) to its object id, or null. */
function resolveRef(gitDir: string, ref: string): string | null {
    const common = commonDir(gitDir);
    // Loose ref first: a commit always writes one. packed-refs only holds refs
    // that `git gc` / `git pack-refs` has since folded away. A worktree's own
    // git dir can also hold per-worktree refs (refs/bisect/*), so check both.
    for (const base of common === gitDir ? [gitDir] : [gitDir, common]) {
        try {
            const raw = fs.readFileSync(path.join(base, ...ref.split('/')), 'utf8').trim();
            if (OBJECT_ID.test(raw)) return raw;
        } catch {
            // not a loose ref under this base
        }
    }
    try {
        const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8');
        for (const line of packed.split('\n')) {
            // '# pack-refs with: ...' header, and '^<sha>' peel lines for tags.
            if (!line || line[0] === '#' || line[0] === '^') continue;
            const sp = line.indexOf(' ');
            if (sp > 0 && line.slice(sp + 1).trim() === ref) return line.slice(0, sp);
        }
    } catch {
        // no packed-refs file
    }
    return null;
}

/**
 * HEAD's commit and branch WITHOUT spawning git — the process-free equivalent of
 * `git rev-parse HEAD` + `git symbolic-ref --short HEAD`. Every operation that
 * moves HEAD (commit, checkout, reset, merge, rebase) rewrites `.git/HEAD` or the
 * branch ref, so this is exactly as current as a spawn would be.
 *
 * Returns null only when HEAD itself is unreadable (not a git dir, or a race with
 * git rewriting it) — callers can then fall back to spawning git. An unborn branch
 * is NOT a failure: it returns a state with a null sha, same as `rev-parse` failing.
 */
export function readHeadState(gitDir: string): HeadState | null {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    } catch {
        return null;
    }
    if (raw.startsWith('ref:')) {
        const ref = raw.slice(4).trim();
        // `symbolic-ref --short` strips the refs/heads/ prefix; for the rare
        // non-branch symbolic HEAD keep the full ref so it's still a stable,
        // distinct name for the change comparison.
        const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        return { sha: resolveRef(gitDir, ref), branch: branch || null };
    }
    return { sha: OBJECT_ID.test(raw) ? raw : null, branch: null };
}

/** Where a path's repo lives. Both fields are fixed for as long as the path is in
 *  the same repo, which is what makes caching them safe. */
export interface RepoLocation {
    repoRoot: string;
    gitDir: string;
}

// Resolving repoRoot/gitDir is the ONLY part of reading git state that still needs
// a git process, so it must not happen per edit. Positive results are cached for
// the session; a miss is re-checked after NEGATIVE_TTL_MS so a folder that gets
// `git init`-ed later starts working without a reload.
const repoLocations = new Map<string, { loc: RepoLocation | null; at: number }>();
const NEGATIVE_TTL_MS = 30_000;

/**
 * repoRoot + gitDir for a file or directory, cached. Pair with readHeadState to
 * read branch/HEAD with no child process at all.
 */
export async function locateRepo(fsPath: string): Promise<RepoLocation | null> {
    let dir = path.normalize(fsPath);
    try {
        if (!(await fs.promises.stat(dir)).isDirectory()) dir = path.dirname(dir);
    } catch {
        dir = path.dirname(dir);
    }
    const hit = repoLocations.get(dir);
    if (hit && (hit.loc !== null || Date.now() - hit.at < NEGATIVE_TTL_MS)) {
        return hit.loc;
    }
    let loc: RepoLocation | null = null;
    const repoRoot = await getRepoRoot(dir);
    if (repoRoot) {
        const gitDir = (await runSafe(repoRoot, 'rev-parse', '--path-format=absolute', '--git-dir'))?.trim();
        if (gitDir) loc = { repoRoot, gitDir };
    }
    repoLocations.set(dir, { loc, at: Date.now() });
    return loc;
}

/** Drop the location cache (workspace folders changed, or a repo was just created). */
export function clearRepoLocationCache(): void {
    repoLocations.clear();
    discoveredRepos.clear();
}

// ── Nested repo discovery ────────────────────────────────────────────────────

/** How deep below a workspace folder we look for repos. 1 covers
 *  `workspace/{backend,frontend}`; 3 also covers `workspace/services/api`. */
const MAX_CHILD_REPO_DEPTH = 3;
/** A folder holding more clones than this is a checkout root, not a project. */
const MAX_CHILD_REPOS = 25;
/** Dependency/build trees: no attributable source, huge directory counts, and
 *  sometimes vendored .git dirs that would be reported as the user's repos. */
const SKIP_SCAN_DIRS = new Set([
    'node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj',
    'coverage', 'venv', 'Pods', 'DerivedData', '__pycache__', 'tmp', 'temp',
]);

const discoveredRepos = new Map<string, { roots: string[]; at: number }>();

/**
 * The git repositories a workspace folder covers.
 *
 * Normally exactly one: the repo containing [dir]. But a folder opened ABOVE its
 * repos — a workspace holding separate `backend/` and `frontend/` clones — is in
 * no repo at all, and `git rev-parse` can't help because it only searches upward.
 * Everything keyed off the folder (gutter, sidebar, history, watchers) then found
 * nothing, even though Blamely had captured the edits correctly. So when the
 * folder isn't in a repo we scan a bounded distance DOWNWARD instead, and the
 * callers treat each result as its own repo — the same shape a multi-root
 * workspace already produces.
 *
 * Mirrors gitutil.DiscoverRepos in the CLI; keep the two in step.
 */
export async function discoverRepoRoots(dir: string): Promise<string[]> {
    const key = path.normalize(dir);
    const hit = discoveredRepos.get(key);
    if (hit && (hit.roots.length > 0 || Date.now() - hit.at < NEGATIVE_TTL_MS)) {
        return hit.roots;
    }
    let roots: string[] = [];
    const own = await getRepoRoot(key);
    if (own) {
        roots = [own];
    } else {
        const found: string[] = [];
        const walk = async (d: string, depth: number): Promise<void> => {
            if (depth > MAX_CHILD_REPO_DEPTH || found.length >= MAX_CHILD_REPOS) return;
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(d, { withFileTypes: true });
            } catch {
                return;
            }
            // A .git entry makes this a repo root: take it and stop descending —
            // a repo nested inside a work tree is a submodule, already covered.
            if (entries.some(e => e.name === '.git')) {
                const root = await getRepoRoot(d);
                if (root) found.push(root);
                return;
            }
            for (const e of entries) {
                // isDirectory() is false for symlinks, which is what we want:
                // following one can escape the folder or loop.
                if (!e.isDirectory()) continue;
                if (e.name.startsWith('.') || SKIP_SCAN_DIRS.has(e.name)) continue;
                await walk(path.join(d, e.name), depth + 1);
            }
        };
        await walk(key, 0);
        roots = [...new Set(found)].sort();
    }
    discoveredRepos.set(key, { roots, at: Date.now() });
    return roots;
}

/**
 * Every distinct repo across all workspace folders, in folder order. A multi-root
 * workspace can mix independent repos, and a single folder opened above sibling
 * clones expands to those clones — both arrive here as a flat, deduped list.
 *
 * `folders` is injected (rather than read from `vscode.workspace`) so this module
 * stays free of the vscode API and testable outside the extension host.
 */
export async function repoRootsForFolders(folders: readonly string[]): Promise<string[]> {
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
        for (const root of await discoverRepoRoots(folder)) {
            const norm = path.normalize(root);
            if (seen.has(norm)) continue; // two folders inside one repo
            seen.add(norm);
            roots.push(root);
        }
    }
    return roots;
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as GitUtils from '../git/GitUtils';

/**
 * Per-repo bucket under ~/.blamely/repos/<repo-name>/ (matches blamely-cli + IntelliJ).
 */
export function userRepoDataDir(repoRoot: string): string {
    const canon = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    return path.join(GitUtils.userBlamelyReposRoot(), GitUtils.repoBucketDirName(canon));
}

/**
 * IntelliJ `BlamelyRepoPaths.safeBranchName` parity — path-safe branch segment.
 */
export function sanitizedBranchDirName(branch: string | null | undefined): string {
    let b = branch?.trim() || 'HEAD';
    b = b
        .replace(/\//g, '-')
        .replace(/\\/g, '-')
        .replace(/:/g, '-')
        .replace(/\*/g, '-')
        .replace(/\?/g, '-')
        .replace(/"/g, '-')
        .replace(/</g, '-')
        .replace(/>/g, '-')
        .replace(/\|/g, '-');
    const out = b || 'HEAD';
    // Prevent path.Join from collapsing ~/.blamely/repos/<bucket>/branches/.. out of branches/
    if (out === '.' || out === '..') {
        return 'HEAD';
    }
    return out;
}

/** ~/.blamely/repos/<key>/logs/commits/<commitSha>/ — report.yml + snapshots/ (mirrors top-level snapshots/). */
export function commitLogDir(repoRoot: string, commitShaFull: string): string {
    const sha = commitShaFull?.trim();
    if (!sha) {
        return '';
    }
    const resolved = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    return path.join(userRepoDataDir(resolved), 'logs', 'commits', sha);
}

/** ~/.blamely/repos/<key>/logs/commits/<commitSha>/report.yml — post-commit report beside archived blame. */
export function commitLogReportPath(repoRoot: string, commitShaFull: string): string {
    const d = commitLogDir(repoRoot, commitShaFull);
    if (!d) {
        return '';
    }
    return path.join(d, 'report.yml');
}

/** ~/.blamely/repos/<key>/logs/commits/<commitSha>/snapshots/ — archived *.blame.json for that commit. */
export function closedCommitSnapshotsDir(
    repoRoot: string,
    _branch: string | null | undefined,
    commitShaFull: string
): string {
    const d = commitLogDir(repoRoot, commitShaFull);
    return d ? path.join(d, 'snapshots') : '';
}

/** Legacy: ~/.blamely/repos/<key>/branches/<branch>/closed/<commitSha>/snapshots/ — read fallback only. */
export function legacyClosedCommitSnapshotsDir(
    repoRoot: string,
    branch: string | null | undefined,
    commitShaFull: string
): string {
    const sha = commitShaFull?.trim();
    if (!sha) {
        return '';
    }
    return path.join(canonicalBranchWorkDir(repoRoot, branch), 'closed', sha, 'snapshots');
}

/**
 * After commit: copy `snapshots/<branch>/*.blame.json` → `logs/commits/<headSha>/snapshots/`
 * from both `~/.blamely/repos/.../snapshots/<branch>/` and `<git-dir>/blamely/snapshots/<branch>/`,
 * then remove the originals. Opt out: BLAMELY_ARCHIVE_TRACE_ON_COMMIT=0.
 */
/** `<git-dir>/blamely/snapshots/<branch>/` (legacy / migration); same basename rules as home mirror. */
export async function gitBlamelyBranchSnapshotsDir(
    repoRoot: string,
    branch: string | null | undefined
): Promise<string | null> {
    const gitDirRaw = await GitUtils.getGitDir(repoRoot);
    if (!gitDirRaw) {
        return null;
    }
    const absGit = path.isAbsolute(gitDirRaw) ? path.normalize(gitDirRaw) : path.resolve(repoRoot, gitDirRaw);
    return path.join(absGit, 'blamely', 'snapshots', sanitizedBranchDirName(branch));
}

export async function archiveBranchBlameSnapshotsToClosed(
    repoRoot: string,
    branch: string | null | undefined,
    headShaFull: string
): Promise<void> {
    if (process.env.BLAMELY_ARCHIVE_TRACE_ON_COMMIT?.trim() === '0') {
        return;
    }
    const sha = headShaFull?.trim();
    if (!sha) {
        return;
    }
    const resolved = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    const destDir = closedCommitSnapshotsDir(resolved, branch, sha);
    const mirror = userReposMirrorSnapshotsDir(resolved, branch);
    const gitDirSnaps = await gitBlamelyBranchSnapshotsDir(resolved, branch);
    const uniq = new Set<string>();
    uniq.add(mirror);
    if (gitDirSnaps) {
        uniq.add(gitDirSnaps);
    }
    await fs.promises.mkdir(destDir, { recursive: true });
    for (const src of uniq) {
        let names: string[];
        try {
            names = (await fs.promises.readdir(src)).filter(
                n => n.endsWith('.blame.json') && !n.startsWith('.')
            );
        } catch {
            continue;
        }
        if (names.length === 0) {
            continue;
        }
        for (const name of names) {
            const from = path.join(src, name);
            const to = path.join(destDir, name);
            try {
                const st = await fs.promises.stat(from);
                if (!st.isFile()) {
                    continue;
                }
                if (fs.existsSync(to)) {
                    // Already under logs/commits/<sha>/snapshots/; drop working copy under snapshots/<branch>/.
                    await fs.promises.unlink(from);
                    continue;
                }
                await fs.promises.copyFile(from, to);
                await fs.promises.unlink(from);
            } catch {
                /* best-effort per file */
            }
        }
    }
}

/**
 * @deprecated Working snapshots are not restored into snapshots/&lt;branch&gt; after commit.
 * Archived blame lives under logs/commits/&lt;sha&gt;/snapshots/ only.
 */
export async function restoreCommitSnapshotsToBranchDir(
    repoRoot: string,
    branch: string | null | undefined,
    commitShaFull: string
): Promise<boolean> {
    const sha = commitShaFull?.trim();
    if (!sha) {
        return false;
    }
    const resolved = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    const srcDir = closedCommitSnapshotsDir(resolved, branch, sha);
    if (!srcDir || !fs.existsSync(srcDir)) {
        return false;
    }
    const destDir = userReposMirrorSnapshotsDir(resolved, branch);
    await fs.promises.mkdir(destDir, { recursive: true });
    let any = false;
    const names = await fs.promises.readdir(srcDir);
    for (const name of names) {
        if (!name.endsWith('.blame.json') || name.startsWith('.')) {
            continue;
        }
        const from = path.join(srcDir, name);
        try {
            const st = await fs.promises.stat(from);
            if (!st.isFile()) {
                continue;
            }
            await fs.promises.copyFile(from, path.join(destDir, name));
            any = true;
        } catch {
            /* best-effort per file */
        }
    }
    return any;
}

/** ~/.blamely/repos/<repo-name>/branches/<sanitized-branch>/ — trace/, report.yml, closed/<sha>/… */
export function canonicalBranchWorkDir(repoRoot: string, branch: string | null | undefined): string {
    return path.join(userRepoDataDir(repoRoot), 'branches', sanitizedBranchDirName(branch));
}

/**
 * Legacy no-op: the VS Code extension does not use `branches/<branch>/trace/` on disk (TraceStore is in-memory only).
 */
export async function archiveBranchTraceToClosed(
    _repoRoot: string,
    _branch: string | null | undefined,
    _headShaFull: string
): Promise<void> {
    return;
}

/** ~/.blamely/repos/<key>/snapshots/<sanitized-branch>/ — *.blame.json */
export function userReposMirrorSnapshotsDir(repoRoot: string, branch: string | null | undefined): string {
    return path.join(userRepoDataDir(repoRoot), 'snapshots', sanitizedBranchDirName(branch));
}

/** Alias: branch working dir (shared by CLI + editors). */
export function userReposMirrorBranchDir(repoRoot: string, branch: string | null | undefined): string {
    return canonicalBranchWorkDir(repoRoot, branch);
}

export async function privateBranchMetaDir(
    repoRoot: string,
    branch: string | null | undefined
): Promise<string | null> {
    return canonicalBranchWorkDir(repoRoot, branch);
}

export async function blameSnapshotsDir(
    repoRoot: string,
    branch: string | null | undefined
): Promise<string | null> {
    return userReposMirrorSnapshotsDir(repoRoot, branch);
}

export async function reportYamlPath(repoRoot: string, branch: string | null | undefined): Promise<string | null> {
    return path.join(canonicalBranchWorkDir(repoRoot, branch), 'report.yml');
}

/**
 * Legacy ~/.blamely/session store root. Used only to read old trace/snapshot paths during migration.
 */
export function getLegacySessionStoreRoot(): string {
    const override = process.env.BLAMELY_SESSION_HOME?.trim();
    if (override) {
        return path.normalize(override);
    }
    return path.join(os.homedir(), '.blamely', 'session');
}

function legacySessionRootDir(repoRoot: string, branch: string | null | undefined): string {
    const key = `${GitUtils.blamelyRepoStableId(repoRoot)}_${sanitizedBranchDirName(branch)}`;
    return path.join(getLegacySessionStoreRoot(), key);
}

/** Migration: former ~/.blamely/session/.../trace/session.json. */
export function legacyUserTraceSessionPath(repoRoot: string, branch: string | null | undefined): string {
    return path.join(legacySessionRootDir(repoRoot, branch), 'trace', 'session.json');
}

/** Migration: former snapshots dir under ~/.blamely/session. */
export function legacyUserBlameSnapshotsDir(repoRoot: string, branch: string | null | undefined): string {
    return path.join(legacySessionRootDir(repoRoot, branch), 'snapshots');
}

async function copyFileIfMissing(dest: string, source: string): Promise<void> {
    try {
        if (fs.existsSync(dest)) {
            return;
        }
        if (!fs.existsSync(source)) {
            return;
        }
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(source, dest);
    } catch {
        /* migration best-effort */
    }
}

async function copySnapshotFilesIfMissing(destDir: string, sourceDir: string): Promise<void> {
    if (!fs.existsSync(sourceDir)) {
        return;
    }
    try {
        await fs.promises.mkdir(destDir, { recursive: true });
        const names = await fs.promises.readdir(sourceDir);
        for (const name of names) {
            const sp = path.join(sourceDir, name);
            const dp = path.join(destDir, name);
            try {
                const st = await fs.promises.stat(sp);
                if (st.isFile() && !fs.existsSync(dp)) {
                    await fs.promises.copyFile(sp, dp);
                }
            } catch {
                /* ignore per-file errors */
            }
        }
    } catch {
        /* migration best-effort */
    }
}

async function copyDirContentsIfMissing(
    destDir: string,
    sourceDir: string,
    options?: { skipDirectoryNames?: Set<string> }
): Promise<void> {
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        return;
    }
    const skip = options?.skipDirectoryNames;
    try {
        await fs.promises.mkdir(destDir, { recursive: true });
        const names = await fs.promises.readdir(sourceDir, { withFileTypes: true });
        for (const ent of names) {
            if (skip?.has(ent.name)) {
                continue;
            }
            const sp = path.join(sourceDir, ent.name);
            const dp = path.join(destDir, ent.name);
            if (fs.existsSync(dp)) {
                continue;
            }
            if (ent.isDirectory()) {
                await copyDirContentsIfMissing(dp, sp, options);
            } else if (ent.isFile()) {
                await fs.promises.copyFile(sp, dp);
            }
        }
    } catch {
        /* best-effort */
    }
}

const SKIP_TRACE_DIR_MIGRATION = new Set(['trace']);

/** Legacy ~/.blamely/repos/<8-char>/<branch>/ (pre–full-key buckets). */
function legacy8CharBranchDir(repoRoot: string, branch: string | null | undefined): string {
    const canon = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    return path.join(GitUtils.userBlamelyReposRoot(), GitUtils.blamelyRepoStableId(canon), sanitizedBranchDirName(branch));
}

/** Flat branch dir under ~/.blamely/repos/<64-hex>/<branch>/ before `branches/` subfolder existed. */
function legacyFlat64BranchDir(repoRoot: string, branch: string | null | undefined): string {
    const canon = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    return path.join(
        GitUtils.userBlamelyReposRoot(),
        GitUtils.cliTraceRepoKey(canon),
        sanitizedBranchDirName(branch)
    );
}

/**
 * Copy legacy data into ~/.blamely/repos/<key>/branches/ and snapshots/ when the canonical dirs are empty.
 */
export async function migrateLegacyBranchDataIntoHomeLayout(
    repoRoot: string,
    branch: string | null | undefined
): Promise<void> {
    const destMeta = canonicalBranchWorkDir(repoRoot, branch);
    const destSnaps = userReposMirrorSnapshotsDir(repoRoot, branch);
    const sanit = sanitizedBranchDirName(branch);

    const gitDirRaw = await GitUtils.getGitDir(repoRoot);
    if (gitDirRaw) {
        const absGit = path.isAbsolute(gitDirRaw) ? path.normalize(gitDirRaw) : path.resolve(repoRoot, gitDirRaw);
        const gitBranch = path.join(absGit, 'blamely', sanit);
        await copyDirContentsIfMissing(destMeta, gitBranch, { skipDirectoryNames: SKIP_TRACE_DIR_MIGRATION });
        await copySnapshotFilesIfMissing(destSnaps, path.join(absGit, 'blamely', 'snapshots', sanit));
    }

    const old8 = legacy8CharBranchDir(repoRoot, branch);
    await copyDirContentsIfMissing(destMeta, old8, { skipDirectoryNames: SKIP_TRACE_DIR_MIGRATION });
    await copySnapshotFilesIfMissing(destSnaps, path.join(path.dirname(old8), 'snapshots', sanit));

    const flat64 = legacyFlat64BranchDir(repoRoot, branch);
    const branchesRoot = path.join(userRepoDataDir(repoRoot), 'branches');
    if (!fs.existsSync(branchesRoot) && fs.existsSync(flat64)) {
        const hasBranchShape =
            fs.existsSync(path.join(flat64, 'open')) ||
            fs.existsSync(path.join(flat64, 'trace')) ||
            fs.existsSync(path.join(flat64, 'report.yml'));
        if (hasBranchShape) {
            await copyDirContentsIfMissing(destMeta, flat64, { skipDirectoryNames: SKIP_TRACE_DIR_MIGRATION });
        }
    }

    await copyFileIfMissing(path.join(destMeta, 'report.yml'), path.join(old8, 'report.yml'));
}

/** @deprecated No longer copies into .git — use {@link migrateLegacyBranchDataIntoHomeLayout}. */
export async function migrateUserReposMirrorIntoRepoLocal(
    repoRoot: string,
    branch: string | null | undefined
): Promise<void> {
    await migrateLegacyBranchDataIntoHomeLayout(repoRoot, branch);
}

/** Ensure per-branch dirs under ~/.blamely/repos/<key>/branches/… and migrate legacy locations. */
export async function ensureBranchPersistenceDirs(repoRoot: string, branch: string | null | undefined): Promise<void> {
    const resolved = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    await GitUtils.ensureUserRepoBucketLayout(resolved);
    const br =
        (branch?.trim() && branch) || (await GitUtils.getBranch(resolved)) || 'HEAD';
    await migrateLegacyBranchDataIntoHomeLayout(resolved, br);

    const metaBase = canonicalBranchWorkDir(resolved, br);
    const snapshotsBase = userReposMirrorSnapshotsDir(resolved, br);
    await fs.promises.mkdir(snapshotsBase, { recursive: true });
}

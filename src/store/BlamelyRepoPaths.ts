import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as GitUtils from '../git/GitUtils';

/** Sanitized branch segment for directory names (matches Git snapshot layout). */
export function sanitizedBranchDirName(branch: string | null | undefined): string {
    const b = branch?.trim() || 'HEAD';
    return b.replace(/[/\\]/g, '-') || 'HEAD';
}

/** ~/.blamely/repos/<repoId>/<branch>/ — trace, report.yml (branch-scoped meta, not blame files). */
export async function privateBranchMetaDir(
    repoRoot: string,
    branch: string | null | undefined
): Promise<string | null> {
    const root = await GitUtils.getBlamelyDataDir(repoRoot);
    if (!root) {
        return null;
    }
    return path.join(root, sanitizedBranchDirName(branch));
}

/** ~/.blamely/repos/<repoId>/snapshots/<branch>/ — *.blame.json */
export async function blameSnapshotsDir(
    repoRoot: string,
    branch: string | null | undefined
): Promise<string | null> {
    const root = await GitUtils.getBlamelyDataDir(repoRoot);
    if (!root) {
        return null;
    }
    return path.join(root, 'snapshots', sanitizedBranchDirName(branch));
}

export async function reportYamlPath(repoRoot: string, branch: string | null | undefined): Promise<string | null> {
    const meta = await privateBranchMetaDir(repoRoot, branch);
    if (!meta) {
        return null;
    }
    return path.join(meta, 'report.yml');
}

/** Trace / suggestion persistence (historical filename `session.json`). */
export async function traceSessionFilePath(
    repoRoot: string,
    branch: string | null | undefined
): Promise<string | null> {
    const meta = await privateBranchMetaDir(repoRoot, branch);
    if (!meta) {
        return null;
    }
    return path.join(meta, 'trace', 'session.json');
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

/** Ensure per-branch dirs for blame snapshots and trace persistence. */
export async function ensureBranchPersistenceDirs(
    repoRoot: string,
    branch: string | null | undefined
): Promise<void> {
    const resolved = GitUtils.canonicalRepoDiskPath(path.normalize(repoRoot.trim()));
    const br =
        (branch?.trim() && branch) || (await GitUtils.getBranch(resolved)) || 'HEAD';
    const blamelyRoot = await GitUtils.getBlamelyDataDir(resolved);
    if (!blamelyRoot) {
        return;
    }
    const metaBase = path.join(blamelyRoot, sanitizedBranchDirName(br));
    const snapshotsBase = path.join(blamelyRoot, 'snapshots', sanitizedBranchDirName(br));
    await fs.promises.mkdir(path.join(metaBase, 'trace'), { recursive: true });
    await fs.promises.mkdir(snapshotsBase, { recursive: true });
}

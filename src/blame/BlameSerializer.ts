import * as fs from 'fs';
import * as path from 'path';
import { LineBlame } from './BlameMap';
import { encodeFilePath, decodeFilePath } from '../utils/Platform';
import * as Logger from '../utils/Logger';
import { getBranch, getRepoRoot } from '../git/GitUtils';
import { blameSnapshotsDir, legacyUserBlameSnapshotsDir, sanitizedBranchDirName } from '../store/BlamelyRepoPaths';

/**
 * Branch-scoped blame snapshots under ~/.blamely/repos/<repoId>/snapshots/<branch>/.
 */
export async function getBranchSnapshotDir(workspaceRoot: string, explicitBranch?: string | null): Promise<string | null> {
    const repo = await getRepoRoot(workspaceRoot);
    if (!repo) {
        return null;
    }
    const branch = explicitBranch !== undefined ? explicitBranch : await getBranch(workspaceRoot);
    return blameSnapshotsDir(repo, branch);
}

/** Read-only: former install location (migration). */
function legacyGitBlamelySnapshotDir(workspaceRoot: string, branch: string | null | undefined): string {
    return path.join(workspaceRoot, '.git', 'blamely', 'snapshots', sanitizedBranchDirName(branch));
}

async function getSnapshotsDir(workspaceRoot: string, explicitBranch?: string | null): Promise<string | null> {
    return getBranchSnapshotDir(workspaceRoot, explicitBranch);
}

async function readBlameJsonFile(targetPath: string): Promise<LineBlame[]> {
    const raw = await fs.promises.readFile(targetPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeLineBlame) : [];
}

export async function save(
    workspaceRoot: string,
    filePath: string,
    entries: LineBlame[]
): Promise<void> {
    try {
        const snapshotsDir = await getSnapshotsDir(workspaceRoot);
        if (!snapshotsDir) return;
        if (!fs.existsSync(snapshotsDir)) {
            await fs.promises.mkdir(snapshotsDir, { recursive: true });
        }

        const encodedFile = encodeFilePath(filePath) + '.blame.json';
        const targetPath = path.join(snapshotsDir, encodedFile);

        await fs.promises.writeFile(targetPath, JSON.stringify(entries, null, 2), 'utf-8');
        Logger.info(`Saved blame state to ${targetPath}`);
    } catch (err) {
        Logger.error(`Failed to save blame state for ${filePath}`, err);
    }
}

/** Drop persisted blame snapshot files for a file (Undo/Redo / SCM discard; avoid storing rolled-back attribution). */
export async function removeSnapshot(workspaceRoot: string, filePath: string): Promise<void> {
    const encodedBase = encodeFilePath(filePath);
    const encodedBlameFile = encodedBase + '.blame.json';
    const encodedPlainJson = encodedBase + '.json';
    const unlinkIfExists = async (fullPath: string): Promise<void> => {
        try {
            if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
            }
        } catch {
            /* ignore race */
        }
    };
    try {
        const snapshotsDir = await getSnapshotsDir(workspaceRoot);
        if (snapshotsDir) {
            await unlinkIfExists(path.join(snapshotsDir, encodedBlameFile));
            await unlinkIfExists(path.join(snapshotsDir, encodedPlainJson));
        }
        const branch = await getBranch(workspaceRoot);
        const repo = await getRepoRoot(workspaceRoot);
        if (repo) {
            await unlinkIfExists(path.join(legacyUserBlameSnapshotsDir(repo, branch), encodedBlameFile));
            await unlinkIfExists(path.join(legacyUserBlameSnapshotsDir(repo, branch), encodedPlainJson));
        }
        await unlinkIfExists(path.join(legacyGitBlamelySnapshotDir(workspaceRoot, branch), encodedBlameFile));
        await unlinkIfExists(path.join(legacyGitBlamelySnapshotDir(workspaceRoot, branch), encodedPlainJson));
        Logger.info(`Removed persisted blame snapshot(s) for ${filePath}`);
    } catch (err) {
        Logger.warn(`Could not remove blame snapshot for ${filePath}: ${err}`);
    }
}

export async function load(
    workspaceRoot: string,
    filePath: string
): Promise<LineBlame[]> {
    try {
        const encodedFile = encodeFilePath(filePath) + '.blame.json';
        const gitDir = await getSnapshotsDir(workspaceRoot);
        if (gitDir) {
            const gitPath = path.join(gitDir, encodedFile);
            if (fs.existsSync(gitPath)) {
                return readBlameJsonFile(gitPath);
            }
        }
        const branch = await getBranch(workspaceRoot);
        const repo = await getRepoRoot(workspaceRoot);
        if (repo) {
            const legacyHome = path.join(legacyUserBlameSnapshotsDir(repo, branch), encodedFile);
            if (fs.existsSync(legacyHome)) {
                return readBlameJsonFile(legacyHome);
            }
        }
        const legacyPath = path.join(legacyGitBlamelySnapshotDir(workspaceRoot, branch), encodedFile);
        if (fs.existsSync(legacyPath)) {
            return readBlameJsonFile(legacyPath);
        }
        return [];
    } catch (err) {
        Logger.warn(`Could not load blame state for ${filePath}: ${err}`);
        return [];
    }
}

/** Backward compatibility: reads both old snake_case and new camelCase keys from JSON. */
function normalizeLineBlame(obj: Record<string, unknown>): LineBlame {
    const authorRaw = obj.authorType ?? obj.author_type;
    const changeRaw = obj.changeType ?? obj.change_type;
    const newLn = obj.newLineNumber ?? obj.new_line_number;
    const oldLn = obj.oldLineNumber ?? obj.old_line_number;
    const codingRaw = obj.codingType ?? obj.coding_type;
    return {
        lineNumber: Number(obj.lineNumber ?? obj.line_number),
        authorType: (authorRaw === 'ai' || authorRaw === 'AI') ? 'AI' : 'HUMAN',
        provider: (obj.provider as string) ?? null,
        timestamp: String(obj.timestamp ?? ''),
        commitSha: (obj.commitSha as string ?? obj.commit_sha as string) ?? null,
        model: (obj.model as string) ?? null,
        prompt: (obj.prompt as string) ?? null,
        aiChars: Number(obj.aiChars ?? obj.ai_chars ?? 0),
        humanChars: Number(obj.humanChars ?? obj.human_chars ?? 0),
        interactionType: (obj.interactionType as string ?? obj.interaction_type as string) ?? null,
        changeType: changeRaw === 'DELETE' ? 'DELETE' : 'ADD',
        newLineNumber: newLn !== undefined && newLn !== null ? Number(newLn) : null,
        oldLineNumber: oldLn !== undefined && oldLn !== null ? Number(oldLn) : null,
        codingType: codingRaw === 'bulk_insert' || codingRaw === 'BULK_INSERT' ? 'BULK_INSERT' : 'TYPING',
    };
}

export async function loadAll(workspaceRoot: string): Promise<Map<string, LineBlame[]>> {
    const memory = new Map<string, LineBlame[]>();
    try {
        const gitDir = await getSnapshotsDir(workspaceRoot);
        const branch = await getBranch(workspaceRoot);
        const repo = await getRepoRoot(workspaceRoot);
        const legacyDir = legacyGitBlamelySnapshotDir(workspaceRoot, branch);
        const legacyHomeDir = repo ? legacyUserBlameSnapshotsDir(repo, branch) : null;

        let dir: string | null = null;
        if (gitDir && fs.existsSync(gitDir)) {
            const files = await fs.promises.readdir(gitDir);
            if (files.some(f => f.endsWith('.blame.json'))) {
                dir = gitDir;
            }
        }
        if (!dir && legacyHomeDir && fs.existsSync(legacyHomeDir)) {
            const files = await fs.promises.readdir(legacyHomeDir);
            if (files.some(f => f.endsWith('.blame.json'))) {
                dir = legacyHomeDir;
            }
        }
        if (!dir && fs.existsSync(legacyDir)) {
            const files = await fs.promises.readdir(legacyDir);
            if (files.some(f => f.endsWith('.blame.json'))) {
                dir = legacyDir;
            }
        }
        if (!dir) return memory;

        const files = await fs.promises.readdir(dir);
        for (const f of files) {
            if (f.endsWith('.blame.json')) {
                const targetPath = path.join(dir, f);
                const raw = await fs.promises.readFile(targetPath, 'utf-8');
                const parsed = JSON.parse(raw);
                const entries = Array.isArray(parsed) ? parsed.map(normalizeLineBlame) : [];
                const relativePath = decodeFilePath(f.replace('.blame.json', ''));
                memory.set(relativePath, entries);
            }
        }
    } catch (err) {
        Logger.error('Failed to load all blame states', err);
    }
    return memory;
}

/** Delete all persisted blame snapshots for the current branch. Call after commit. */
export async function clearCurrentBranchSnapshots(workspaceRoot: string): Promise<void> {
    try {
        const snapshotsDir = await getSnapshotsDir(workspaceRoot);
        if (!snapshotsDir || !fs.existsSync(snapshotsDir)) return;
        const files = await fs.promises.readdir(snapshotsDir);
        for (const f of files) {
            if (f.endsWith('.blame.json')) {
                await fs.promises.unlink(path.join(snapshotsDir, f));
            }
        }
    } catch (err) {
        Logger.warn(`Could not clear branch snapshots: ${err}`);
    }
}

/** Save all file blame for a specific branch (e.g. before switching branch). */
export async function saveAllToBranch(
    workspaceRoot: string,
    branch: string,
    data: Map<string, LineBlame[]>
): Promise<void> {
    try {
        const snapshotsDir = await getSnapshotsDir(workspaceRoot, branch);
        if (!snapshotsDir) return;
        if (!fs.existsSync(snapshotsDir)) {
            await fs.promises.mkdir(snapshotsDir, { recursive: true });
        }
        for (const [filePath, entries] of data) {
            const encodedFile = encodeFilePath(filePath) + '.blame.json';
            const targetPath = path.join(snapshotsDir, encodedFile);
            await fs.promises.writeFile(targetPath, JSON.stringify(entries, null, 2), 'utf-8');
        }
    } catch (err) {
        Logger.error('Failed to save all blame to branch', err);
    }
}

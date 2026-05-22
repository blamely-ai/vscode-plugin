import * as fs from 'fs';
import * as path from 'path';
import { LineBlame } from './BlameMap';
import { encodeFilePath, decodeFilePath } from '../utils/Platform';
import { currentIdeLabel } from '../utils/ideLabel';
import * as Logger from '../utils/Logger';
import { getBranch, getRepoRoot } from '../git/GitUtils';
import { blameSnapshotsDir, userReposMirrorSnapshotsDir, gitBlamelyBranchSnapshotsDir } from '../store/BlamelyRepoPaths';
import { normalizeBlamePersistenceKey } from '../utils/WorkspacePaths';
import { interactionTypeForBlameJson } from './blameJsonPersist';

/**
 * Branch-scoped working-tree blame sidecars under `~/.blamely/repos/<repo>/snapshots/<branch>/`.
 * These are ephemeral: they reflect the current uncommitted session only, not committed file history.
 * Cleared after commit, rollback, discard, or when the working tree is clean at IDE startup.
 */
export async function getBranchSnapshotDir(workspaceRoot: string, explicitBranch?: string | null): Promise<string | null> {
    const repo = await getRepoRoot(workspaceRoot);
    if (!repo) {
        return null;
    }
    const branch = explicitBranch !== undefined ? explicitBranch : await getBranch(workspaceRoot);
    return blameSnapshotsDir(repo, branch);
}

async function getSnapshotsDir(workspaceRoot: string, explicitBranch?: string | null): Promise<string | null> {
    return getBranchSnapshotDir(workspaceRoot, explicitBranch);
}

async function readBlameJsonFile(targetPath: string): Promise<LineBlame[]> {
    const raw = await fs.promises.readFile(targetPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeLineBlame) : [];
}

/** Load a single *.blame.json from an absolute path (e.g. archived under logs/commits/<sha>/snapshots/). */
export async function loadBlameFromSnapshotFile(absPath: string): Promise<LineBlame[]> {
    try {
        if (!fs.existsSync(absPath)) {
            return [];
        }
        return readBlameJsonFile(absPath);
    } catch {
        return [];
    }
}

/**
 * Resolve archived snapshot path: encodings may differ between repo-relative and workspace-relative keys.
 */
export function resolveArchivedBlameSnapshotPath(
    closedSnapshotsDir: string,
    repoRel: string,
    projectRel: string
): string | null {
    if (!closedSnapshotsDir) {
        return null;
    }
    const r = repoRel.replace(/\\/g, '/');
    const p = projectRel.replace(/\\/g, '/');
    const candidates = [
        path.join(closedSnapshotsDir, encodeFilePath(r) + '.blame.json'),
        path.join(closedSnapshotsDir, encodeFilePath(p) + '.blame.json'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return c;
        }
    }
    return null;
}

/**
 * Canonical disk shape: camelCase; stable key order matches blamely-cli blamejson —
 * lineNumber, authorType, changeType, model, codingType, interactionType, timestamp, commitSha,
 * prompt, ide, then optional extras. {@code interactionType} is JSON {@code null} for human rows;
 * for AI it is one of completion | chat | panel | cli (see {@link interactionTypeForBlameJson}).
 */
export function lineBlameToJsonRecord(e: LineBlame, defaultIde?: string | null): Record<string, unknown> {
    const o: Record<string, unknown> = {
        lineNumber: e.lineNumber,
        authorType: e.authorType,
        changeType: e.changeType ?? 'ADD',
    };
    if (e.model != null && e.model !== '') {
        o.model = e.model;
    }
    o.codingType = e.codingType ?? 'TYPING';
    o.interactionType = interactionTypeForBlameJson(e);
    if (e.timestamp !== '') {
        o.timestamp = e.timestamp;
    }
    if (e.commitSha != null && e.commitSha !== '') {
        o.commitSha = e.commitSha;
    }
    if (e.prompt != null && e.prompt !== '') {
        o.prompt = e.prompt;
    }
    const ideFin = (e.ide?.trim() || (defaultIde ?? '').trim()) || '';
    if (ideFin !== '') {
        o.ide = ideFin;
    }
    if (e.aiChars !== 0) {
        o.aiChars = e.aiChars;
    }
    if (e.humanChars !== 0) {
        o.humanChars = e.humanChars;
    }
    if (e.oldLineNumber != null) {
        o.oldLineNumber = e.oldLineNumber;
    }
    return o;
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

        const key = normalizeBlamePersistenceKey(filePath, workspaceRoot);
        const encodedFile = encodeFilePath(key) + '.blame.json';
        const targetPath = path.join(snapshotsDir, encodedFile);

        const defIde = currentIdeLabel();
        const disk = entries.map(e => lineBlameToJsonRecord(e, defIde));
        await fs.promises.writeFile(targetPath, JSON.stringify(disk, null, 2), 'utf-8');
        Logger.info(`Saved blame state to ${targetPath}`);
    } catch (err) {
        Logger.error(`Failed to save blame state for ${filePath}`, err);
    }
}

/** Drop persisted blame snapshot files for a file (Undo/Redo / SCM discard; avoid storing rolled-back attribution). */
export async function removeSnapshot(workspaceRoot: string, filePath: string): Promise<void> {
    const key = normalizeBlamePersistenceKey(filePath, workspaceRoot);
    const encodedBase = encodeFilePath(key);
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
        const key = normalizeBlamePersistenceKey(filePath, workspaceRoot);
        const encodedFile = encodeFilePath(key) + '.blame.json';
        const snapshotsDir = await getSnapshotsDir(workspaceRoot);
        if (!snapshotsDir) {
            return [];
        }
        const p = path.join(snapshotsDir, encodedFile);
        if (fs.existsSync(p)) {
            return readBlameJsonFile(p);
        }
        return [];
    } catch (err) {
        Logger.warn(`Could not load blame state for ${filePath}: ${err}`);
        return [];
    }
}

/** Backward compatibility: camelCase (canonical) and legacy snake_case keys. */
function normalizeLineBlame(obj: Record<string, unknown>): LineBlame {
    const authorRaw = obj.authorType ?? obj.author_type;
    const changeRaw = obj.changeType ?? obj.change_type;
    const newLn = obj.newLineNumber ?? obj.new_line_number;
    const oldLn = obj.oldLineNumber ?? obj.old_line_number;
    const codingRaw = obj.codingType ?? obj.coding_type;
    const authorType = (authorRaw === 'ai' || authorRaw === 'AI') ? 'AI' : 'HUMAN';
    let aiChars = Number(obj.aiChars ?? obj.ai_chars ?? 0);
    let humanChars = Number(obj.humanChars ?? obj.human_chars ?? 0);
    if (aiChars === 0 && humanChars === 0) {
        if (authorType === 'AI') {
            aiChars = 1;
        } else {
            humanChars = 1;
        }
    }
    const codingNorm =
        codingRaw === 'bulk_insert' || codingRaw === 'BULK_INSERT' ? 'BULK_INSERT' : 'TYPING';
    let ide: string | null = null;
    const ideRaw = obj.ide ?? obj.ide_label;
    if (ideRaw != null && String(ideRaw).trim() !== '') {
        ide = String(ideRaw).trim();
    }
    return {
        lineNumber: Number(obj.lineNumber ?? obj.line_number),
        authorType,
        provider: null,
        timestamp: String(obj.timestamp ?? ''),
        commitSha: (obj.commitSha as string ?? obj.commit_sha as string) ?? null,
        model: (obj.model as string) ?? null,
        prompt: (obj.prompt as string) ?? null,
        ide,
        aiChars,
        humanChars,
        interactionType: (obj.interactionType as string ?? obj.interaction_type as string) ?? null,
        changeType: changeRaw === 'DELETE' || changeRaw === 'delete' ? 'DELETE' : 'ADD',
        newLineNumber: newLn !== undefined && newLn !== null ? Number(newLn) : null,
        oldLineNumber: oldLn !== undefined && oldLn !== null ? Number(oldLn) : null,
        codingType: codingNorm,
    };
}

export async function loadAll(workspaceRoot: string): Promise<Map<string, LineBlame[]>> {
    const memory = new Map<string, LineBlame[]>();
    try {
        const branch = await getBranch(workspaceRoot);
        const repo = await getRepoRoot(workspaceRoot);
        if (!repo) {
            return memory;
        }
        const dir = userReposMirrorSnapshotsDir(repo, branch);
        if (!fs.existsSync(dir)) {
            return memory;
        }

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

/** Delete all *.blame.json in a directory (best-effort). */
async function unlinkAllBlameJsonInDir(dir: string | null | undefined): Promise<void> {
    if (!dir || !fs.existsSync(dir)) {
        return;
    }
    try {
        const files = await fs.promises.readdir(dir);
        for (const f of files) {
            if (!f.endsWith('.blame.json')) {
                continue;
            }
            try {
                await fs.promises.unlink(path.join(dir, f));
            } catch {
                /* race */
            }
        }
    } catch {
        /* ignore */
    }
}

/** Delete all *.blame.json under ~/.blamely/repos/<repo>/snapshots/<branch>/ and git-dir mirror. */
export async function clearBranchSnapshots(
    workspaceRoot: string,
    branch: string | null | undefined
): Promise<void> {
    try {
        const repo = await getRepoRoot(workspaceRoot);
        if (!repo) {
            return;
        }
        const dir = userReposMirrorSnapshotsDir(repo, branch);
        await unlinkAllBlameJsonInDir(dir);
        const gitDir = await gitBlamelyBranchSnapshotsDir(repo, branch);
        await unlinkAllBlameJsonInDir(gitDir);
    } catch (err) {
        Logger.warn(`Could not clear branch snapshots for ${branch ?? '?'}: ${err}`);
    }
}

/** Delete all *.blame.json under ~/.blamely/repos/<repo>/snapshots/<branch>/ and `<git-dir>/blamely/snapshots/<branch>/`. */
export async function clearCurrentBranchSnapshots(workspaceRoot: string): Promise<void> {
    try {
        const repo = await getRepoRoot(workspaceRoot);
        const branch = await getBranch(workspaceRoot);
        if (!repo) {
            return;
        }
        await clearBranchSnapshots(workspaceRoot, branch);
        Logger.info(`Cleared working branch blame snapshots: ${userReposMirrorSnapshotsDir(repo, branch)}`);
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
            const key = normalizeBlamePersistenceKey(filePath, workspaceRoot);
            const encodedFile = encodeFilePath(key) + '.blame.json';
            const targetPath = path.join(snapshotsDir, encodedFile);
            const defIde = currentIdeLabel();
            const disk = entries.map(e => lineBlameToJsonRecord(e, defIde));
            await fs.promises.writeFile(targetPath, JSON.stringify(disk, null, 2), 'utf-8');
        }
    } catch (err) {
        Logger.error('Failed to save all blame to branch', err);
    }
}

import * as fs from 'fs';
import * as path from 'path';
import { LineBlame } from './BlameMap';
import { encodeFilePath, decodeFilePath } from '../utils/Platform';
import * as Logger from '../utils/Logger';
import { getAiTraceDir, getBranch } from '../git/GitUtils';

function safeBranchName(branch: string | null): string {
    const b = branch?.trim() || 'HEAD';
    return b.replace(/[/\\]/g, '-') || 'HEAD';
}

async function getSnapshotsDir(workspaceRoot: string, explicitBranch?: string | null): Promise<string | null> {
    const outDir = await getAiTraceDir(workspaceRoot) || path.join(workspaceRoot, '.git', 'ai-trace');
    const branch = explicitBranch !== undefined ? explicitBranch : await getBranch(workspaceRoot);
    return path.join(outDir, 'snapshots', safeBranchName(branch));
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

export async function load(
    workspaceRoot: string,
    filePath: string
): Promise<LineBlame[]> {
    try {
        const snapshotsDir = await getSnapshotsDir(workspaceRoot);
        if (!snapshotsDir) return [];
        const encodedFile = encodeFilePath(filePath) + '.blame.json';
        const targetPath = path.join(snapshotsDir, encodedFile);

        if (!fs.existsSync(targetPath)) return [];

        const raw = await fs.promises.readFile(targetPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(normalizeLineBlame) : [];
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
        const snapshotsDir = await getSnapshotsDir(workspaceRoot);
        if (!snapshotsDir || !fs.existsSync(snapshotsDir)) return memory;

        const files = await fs.promises.readdir(snapshotsDir);
        for (const f of files) {
            if (f.endsWith('.blame.json')) {
                const targetPath = path.join(snapshotsDir, f);
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

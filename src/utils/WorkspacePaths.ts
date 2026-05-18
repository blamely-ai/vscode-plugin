import * as path from 'path';
import * as vscode from 'vscode';
import * as GitUtils from '../git/GitUtils';
import {
    blameKeyFromSnapshotSidecarPath,
    normalizeBlamePersistenceKey,
    normalizePath,
    workspacePathFromGitExtensionUriQuery,
} from './Platform';

export { blameKeyFromSnapshotSidecarPath, normalizeBlamePersistenceKey };

/** True when `folderFsPath` is the repo root or a folder inside it (workspace folder under a git repo). */
export function workspaceFolderInRepo(repoRoot: string, folderFsPath: string): boolean {
    const r = path.normalize(repoRoot);
    const f = path.normalize(folderFsPath);
    return f === r || f.startsWith(r + path.sep);
}

/** Workspace folders whose root is under the given git repo root. */
export function workspaceFoldersUnderRepo(repoRoot: string): vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.filter(f => workspaceFolderInRepo(repoRoot, f.uri.fsPath));
}

/** True when the window has more than one root folder (multi-root workspace). */
export function isMultiRootWorkspace(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

/**
 * Stable key for blame storage and UI. Single-folder workspaces use path relative to that folder
 * (backward compatible). Multi-root workspaces prefix with the workspace folder name so two projects
 * cannot collide on the same relative path (e.g. both have `src/index.ts`).
 */
export function blameFileKey(uri: vscode.Uri): string {
    if (uri.scheme !== 'file') {
        return normalizePath(uri.fsPath);
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        const fromAbs = blameKeyFromSnapshotSidecarPath(uri.fsPath);
        if (fromAbs !== null) {
            return fromAbs;
        }
        return normalizePath(uri.fsPath);
    }
    const relativeWithinFolder = normalizePath(path.relative(folder.uri.fsPath, uri.fsPath));
    const fromSnap = blameKeyFromSnapshotSidecarPath(relativeWithinFolder);
    if (fromSnap !== null) {
        if (!isMultiRootWorkspace()) {
            return fromSnap;
        }
        return normalizePath(`${folder.name}/${fromSnap}`);
    }
    if (!isMultiRootWorkspace()) {
        return relativeWithinFolder;
    }
    return normalizePath(`${folder.name}/${relativeWithinFolder}`);
}

/**
 * Workspace folder that owns persisted blame / reports for this key, or undefined if unknown.
 * Legacy keys without a `folderName/` prefix in multi-root are attributed to the first folder.
 */
export function workspaceFolderForBlameKey(blameKey: string): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    const slash = blameKey.indexOf('/');
    if (slash === -1) {
        return folders[0];
    }
    const name = blameKey.slice(0, slash);
    return folders.find(f => f.name === name) ?? folders[0];
}

/** Filesystem root used for BlameSerializer / TraceStore for this blame key. */
export function workspaceRootForBlameKey(blameKey: string): string | undefined {
    return workspaceFolderForBlameKey(blameKey)?.uri.fsPath;
}

/** Map Git SCM `git:` URIs or `file:` URIs to a workspace `file:///…` Uri (disk path). */
export function scmOrFileUriToWorkspaceFileUri(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme === 'file') {
        return uri;
    }
    if (uri.scheme === 'git') {
        const p = workspacePathFromGitExtensionUriQuery(uri.query);
        if (p) {
            return vscode.Uri.file(p);
        }
    }
    return undefined;
}

/** True for values produced as `vscode.Uri` (duck-typed for older typings without `Uri.isUri`). */
function isVscodeUri(value: unknown): value is vscode.Uri {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as { scheme?: unknown }).scheme === 'string' &&
        typeof (value as { fsPath?: unknown }).fsPath === 'string'
    );
}

/** Extract disk file URIs from `git.clean`-style command arguments (resource states with `resourceUri`). */
export function collectFileUrisFromGitCommandArgs(args: unknown[] | undefined): vscode.Uri[] {
    if (!args?.length) {
        return [];
    }
    const out: vscode.Uri[] = [];
    const seen = new Set<string>();
    const push = (candidate: vscode.Uri | undefined): void => {
        if (!candidate || candidate.scheme !== 'file') {
            return;
        }
        const s = candidate.fsPath;
        if (seen.has(s)) {
            return;
        }
        seen.add(s);
        out.push(candidate);
    };
    for (const arg of args) {
        if (isVscodeUri(arg)) {
            push(scmOrFileUriToWorkspaceFileUri(arg));
            continue;
        }
        if (arg && typeof arg === 'object' && 'resourceUri' in arg) {
            const ru = (arg as { resourceUri?: unknown }).resourceUri;
            if (isVscodeUri(ru)) {
                push(scmOrFileUriToWorkspaceFileUri(ru));
            }
        }
    }
    return out;
}

/**
 * When loading snapshot files from disk, namespace keys for multi-root if they were saved in the
 * old single-relative-path format.
 */
export function normalizeLoadedBlameKey(storedKey: string, folder: vscode.WorkspaceFolder): string {
    const normalized = normalizePath(storedKey);
    if (!isMultiRootWorkspace()) {
        return normalized;
    }
    const prefix = `${folder.name}/`;
    if (normalized.startsWith(prefix)) {
        return normalized;
    }
    const folders = vscode.workspace.workspaceFolders!;
    if (folders.some(f => f !== folder && normalized.startsWith(`${f.name}/`))) {
        return normalized;
    }
    return normalizePath(`${folder.name}/${normalized}`);
}

/** True if the blame key resolves to a file inside `repoRoot`. */
export function blameKeyBelongsToRepo(repoRoot: string, blameKey: string): boolean {
    const uri = uriFromBlameFileKey(blameKey);
    if (!uri) {
        return false;
    }
    const normRepo = path.normalize(repoRoot);
    const normFile = path.normalize(uri.fsPath);
    return normFile === normRepo || normFile.startsWith(normRepo + path.sep);
}

/** Repo-relative path for a blame key, or null if outside the repo. */
export function blameKeyToRepoRelativePath(repoRoot: string, blameKey: string): string | null {
    const uri = uriFromBlameFileKey(blameKey);
    if (!uri) {
        return null;
    }
    const normRepo = path.normalize(repoRoot);
    const normFile = path.normalize(uri.fsPath);
    if (normFile !== normRepo && !normFile.startsWith(normRepo + path.sep)) {
        return null;
    }
    let rel = path.relative(normRepo, normFile).replace(/\\/g, '/');
    if (rel === '') {
        rel = '.';
    }
    return rel;
}

/**
 * Blame keys for paths Git reports as changed vs HEAD (incl. untracked), aligned with the sidebar Changes list.
 * Returns null if no workspace folder is in a git repo — callers should not filter (show all in-memory blame).
 */
export async function getWorkingTreeDirtyBlameKeys(): Promise<Set<string> | null> {
    const keys = new Set<string>();
    const seenRepos = new Set<string>();
    let anyGit = false;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const repoRoot = await GitUtils.getRepoRoot(folder.uri.fsPath);
        if (!repoRoot) {
            continue;
        }
        anyGit = true;
        const normRoot = path.normalize(repoRoot);
        if (seenRepos.has(normRoot)) {
            continue;
        }
        seenRepos.add(normRoot);
        const dirty = await GitUtils.getWorkingTreeChangedFiles(repoRoot);
        for (const rel of dirty) {
            const absPath = path.normalize(path.join(repoRoot, rel));
            keys.add(blameFileKey(vscode.Uri.file(absPath)));
        }
    }
    return anyGit ? keys : null;
}

/** Resolve a blame key to a file URI for opening in the editor. */
export function uriFromBlameFileKey(blameKey: string): vscode.Uri | undefined {
    const folder = workspaceFolderForBlameKey(blameKey);
    if (!folder) {
        return undefined;
    }
    if (!isMultiRootWorkspace()) {
        return vscode.Uri.joinPath(folder.uri, blameKey);
    }
    const slash = blameKey.indexOf('/');
    const rel = slash === -1 ? blameKey : blameKey.slice(slash + 1);
    return vscode.Uri.joinPath(folder.uri, rel);
}

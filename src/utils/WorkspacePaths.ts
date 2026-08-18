import * as path from 'path';
import * as vscode from 'vscode';
import * as GitUtils from '../git/GitUtils';
import { normalizePath } from './Platform';

function isMultiRootWorkspace(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

export function blameFileKey(uri: vscode.Uri): string {
    if (uri.scheme !== 'file') {
        return normalizePath(uri.fsPath);
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return normalizePath(uri.fsPath);
    }
    const relativeWithinFolder = normalizePath(path.relative(folder.uri.fsPath, uri.fsPath));
    if (!isMultiRootWorkspace()) {
        return relativeWithinFolder;
    }
    return normalizePath(`${folder.name}/${relativeWithinFolder}`);
}

function workspaceFolderForBlameKey(blameKey: string): vscode.WorkspaceFolder | undefined {
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

export async function getWorkingTreeDirtyBlameKeys(): Promise<Set<string> | null> {
    const keys = new Set<string>();
    const seenRepos = new Set<string>();
    let anyGit = false;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        // Every repo the folder covers: itself, or — when the folder is opened
        // above sibling clones — each repo nested beneath it.
        for (const repoRoot of await GitUtils.discoverRepoRoots(folder.uri.fsPath)) {
            anyGit = true;
            const normRoot = path.normalize(repoRoot);
            if (seenRepos.has(normRoot)) {
                continue;
            }
            seenRepos.add(normRoot);
            const dirty = await GitUtils.getWorkingTreeChangedFiles(repoRoot);
            for (const rel of dirty) {
                keys.add(blameFileKey(vscode.Uri.file(path.join(repoRoot, rel))));
            }
        }
    }
    return anyGit ? keys : null;
}

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

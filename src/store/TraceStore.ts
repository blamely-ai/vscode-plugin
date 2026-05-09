import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as Logger from '../utils/Logger';
import { getBranch, getRepoRoot } from '../git/GitUtils';
import { workspaceFoldersUnderRepo } from '../utils/WorkspacePaths';
import { sanitizedBranchDirName, traceSessionFilePath, legacyUserTraceSessionPath } from './BlamelyRepoPaths';

export interface SuggestionRecord {
    suggestion_id: string;
    timestamp: string;
    file_path: string;
    line_start: number;
    line_end: number;
    char_start: number;
    char_end: number;
    suggested_text: string;
    provider_id: string;
    context_before: string;
    accepted: boolean;
    accepted_at: string | null;
    final_text: string | null;
    model_name: string | null;
    prompt: string | null;
}

export class TraceStore {
    private suggestions: SuggestionRecord[] = [];
    private pendingSuggestions: SuggestionRecord[] = [];

    addSuggestion(
        filePath: string,
        lineStart: number,
        lineEnd: number,
        charStart: number,
        charEnd: number,
        suggestedText: string,
        providerId: string,
        contextBefore: string,
        modelName: string | null = null,
        prompt: string | null = null
    ): SuggestionRecord {
        const record: SuggestionRecord = {
            suggestion_id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            file_path: filePath,
            line_start: lineStart,
            line_end: lineEnd,
            char_start: charStart,
            char_end: charEnd,
            suggested_text: suggestedText,
            provider_id: providerId,
            context_before: contextBefore,
            accepted: false,
            accepted_at: null,
            final_text: null,
            model_name: modelName,
            prompt: prompt,
        };
        this.suggestions.push(record);
        this.pendingSuggestions.push(record);
        return record;
    }

    markAccepted(suggestionId: string, finalText: string): void {
        const suggestion = this.suggestions.find(s => s.suggestion_id === suggestionId);
        if (suggestion) {
            suggestion.accepted = true;
            suggestion.accepted_at = new Date().toISOString();
            suggestion.final_text = finalText;
        }
        this.pendingSuggestions = this.pendingSuggestions.filter(
            s => s.suggestion_id !== suggestionId
        );
    }

    markRejected(suggestionId: string): void {
        this.pendingSuggestions = this.pendingSuggestions.filter(
            s => s.suggestion_id !== suggestionId
        );
    }

    expirePending(timeoutMs: number): void {
        const now = Date.now();
        const expired = this.pendingSuggestions.filter(s => {
            const age = now - new Date(s.timestamp).getTime();
            return age > timeoutMs;
        });
        for (const s of expired) {
            this.markRejected(s.suggestion_id);
        }
    }

    getPendingSuggestions(): SuggestionRecord[] {
        return [...this.pendingSuggestions];
    }

    getAllSuggestions(): SuggestionRecord[] {
        return [...this.suggestions];
    }

    getAcceptedSuggestions(): SuggestionRecord[] {
        return this.suggestions.filter(s => s.accepted);
    }

    getRejectedSuggestions(): SuggestionRecord[] {
        return this.suggestions.filter(s => !s.accepted && !this.pendingSuggestions.find(p => p.suggestion_id === s.suggestion_id));
    }

    private isMultiRoot(): boolean {
        return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    }

    private filterSuggestionsForFolder(suggestions: SuggestionRecord[], folder: vscode.WorkspaceFolder): SuggestionRecord[] {
        if (!this.isMultiRoot()) {
            return [...suggestions];
        }
        const prefix = `${folder.name}/`;
        return suggestions.filter(s => s.file_path.startsWith(prefix));
    }

    private async legacySessionPath(workspaceRoot: string): Promise<string> {
        return path.join(workspaceRoot, '.git', 'blamely', 'session.json');
    }

    private async readSessionJsonOrLegacy(workspaceRoot: string): Promise<string | null> {
        const branch = await getBranch(workspaceRoot);
        const repo = await getRepoRoot(workspaceRoot);
        if (repo) {
            const tracePath = await traceSessionFilePath(repo, branch);
            if (tracePath && fs.existsSync(tracePath)) {
                return fs.promises.readFile(tracePath, 'utf-8');
            }
            const legacyHome = legacyUserTraceSessionPath(repo, branch);
            if (fs.existsSync(legacyHome)) {
                return fs.promises.readFile(legacyHome, 'utf-8');
            }
        }
        const legacyBranchSession = path.join(
            workspaceRoot,
            '.git',
            'blamely',
            'snapshots',
            sanitizedBranchDirName(branch),
            'session.json'
        );
        const legacyPath = await this.legacySessionPath(workspaceRoot);

        if (fs.existsSync(legacyBranchSession)) {
            return fs.promises.readFile(legacyBranchSession, 'utf-8');
        }
        if (fs.existsSync(legacyPath)) {
            return fs.promises.readFile(legacyPath, 'utf-8');
        }
        return null;
    }

    /** Trace file under ~/.blamely/repos/<repoId>/<branch>/trace/session.json when in a Git repo. */
    private async traceSessionJsonPath(
        workspaceRoot: string,
        explicitBranch?: string | null
    ): Promise<string | null> {
        const branch = explicitBranch !== undefined ? explicitBranch : await getBranch(workspaceRoot);
        const repo = await getRepoRoot(workspaceRoot);
        if (repo) {
            return traceSessionFilePath(repo, branch);
        }
        return null;
    }

    async persist(workspaceRoot: string): Promise<void> {
        try {
            const folder = vscode.workspace.workspaceFolders?.find(
                f => path.normalize(f.uri.fsPath) === path.normalize(workspaceRoot)
            );
            if (!folder) {
                Logger.warn(`TraceStore.persist: no workspace folder for ${workspaceRoot}`);
                return;
            }
            const sessionPath = await this.traceSessionJsonPath(workspaceRoot);
            if (!sessionPath) {
                return;
            }
            await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true });
            const suggestions = this.filterSuggestionsForFolder(this.suggestions, folder);
            const pendingSuggestions = this.filterSuggestionsForFolder(this.pendingSuggestions, folder);
            const data = {
                suggestions,
                pendingSuggestions,
            };
            await fs.promises.writeFile(sessionPath, JSON.stringify(data, null, 2), 'utf-8');
            Logger.info(`Saved session state to ${sessionPath}`);
        } catch (err) {
            Logger.error('Failed to persist trace session', err);
        }
    }

    /** Write the same session state to each project root (multi-root). */
    async persistToAllWorkspaceRoots(workspaceRoots: string[]): Promise<void> {
        for (const root of workspaceRoots) {
            await this.persist(root);
        }
    }

    async load(workspaceRoot: string): Promise<void> {
        try {
            const raw = await this.readSessionJsonOrLegacy(workspaceRoot);
            if (!raw) {
                this.clear();
                return;
            }
            const data = JSON.parse(raw);
            this.suggestions = data.suggestions || [];
            this.pendingSuggestions = data.pendingSuggestions || [];
            Logger.info(`Loaded trace session for workspace`);
        } catch (err) {
            Logger.error('Failed to load trace session', err);
            this.clear();
        }
    }

    /**
     * Multi-root: merge session.json from each project folder so suggestion IDs from all roots load.
     * Later roots overwrite duplicate suggestion_id values.
     */
    async mergeLoadFromWorkspaceRoots(workspaceRoots: string[]): Promise<void> {
        this.clear();
        const byId = new Map<string, SuggestionRecord>();
        const pendingById = new Map<string, SuggestionRecord>();
        for (const root of workspaceRoots) {
            try {
                const raw = await this.readSessionJsonOrLegacy(root);
                if (!raw) {
                    continue;
                }
                const data = JSON.parse(raw);
                const suggestions: SuggestionRecord[] = data.suggestions || [];
                const pending: SuggestionRecord[] = data.pendingSuggestions || [];
                for (const s of suggestions) {
                    byId.set(s.suggestion_id, s);
                }
                for (const p of pending) {
                    pendingById.set(p.suggestion_id, p);
                }
                Logger.info(`Merged trace session from ${root}`);
            } catch (err) {
                Logger.error(`Failed to merge trace session for ${root}`, err);
            }
        }
        this.suggestions = [...byId.values()];
        this.pendingSuggestions = [...pendingById.values()];
    }

    /**
     * Persist trace for workspace folders under this repo to the **old** branch name, then drop those
     * suggestions from memory and load session files for the **new** branch. Keeps completion/chat
     * trace aligned with blame when switching branches.
     */
    async onGitBranchSwitch(repoRoot: string, oldBranch: string, newBranch: string): Promise<void> {
        const folders = workspaceFoldersUnderRepo(repoRoot);
        if (folders.length === 0) {
            return;
        }
        const ob = oldBranch.trim() || 'HEAD';
        const nb = newBranch.trim() || 'HEAD';

        const resolvedRepo = path.normalize(repoRoot);
        for (const folder of folders) {
            const sessionPath = await traceSessionFilePath(resolvedRepo, ob);
            if (!sessionPath) {
                continue;
            }
            await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true });
            const suggestions = this.filterSuggestionsForFolder(this.suggestions, folder);
            const pendingSuggestions = this.filterSuggestionsForFolder(this.pendingSuggestions, folder);
            await fs.promises.writeFile(
                sessionPath,
                JSON.stringify({ suggestions, pendingSuggestions }, null, 2),
                'utf-8'
            );
            Logger.info(`Saved session for branch ${ob} to ${sessionPath}`);
        }

        this.removeSuggestionsForWorkspaceFolders(folders);

        for (const folder of folders) {
            const sessionPath = await traceSessionFilePath(resolvedRepo, nb);
            if (!sessionPath || !fs.existsSync(sessionPath)) {
                continue;
            }
            const raw = await fs.promises.readFile(sessionPath, 'utf-8');
            const data = JSON.parse(raw);
            this.mergeInSessionData(data.suggestions || [], data.pendingSuggestions || []);
        }
        Logger.info(`Trace session rotated for branch switch: ${ob} -> ${nb}`);
    }

    private mergeInSessionData(suggestions: SuggestionRecord[], pending: SuggestionRecord[]): void {
        const byId = new Map(this.suggestions.map(s => [s.suggestion_id, s]));
        for (const s of suggestions) {
            byId.set(s.suggestion_id, s);
        }
        this.suggestions = [...byId.values()];
        const pendById = new Map(this.pendingSuggestions.map(p => [p.suggestion_id, p]));
        for (const p of pending) {
            pendById.set(p.suggestion_id, p);
        }
        this.pendingSuggestions = [...pendById.values()];
    }

    private removeSuggestionsForWorkspaceFolders(folders: vscode.WorkspaceFolder[]): void {
        if (folders.length === 0) {
            return;
        }
        if (!this.isMultiRoot()) {
            this.clear();
            return;
        }
        const prefixes = folders.map(f => `${f.name}/`);
        const shouldRemove = (fp: string) => prefixes.some(p => fp.startsWith(p));
        this.suggestions = this.suggestions.filter(s => !shouldRemove(s.file_path));
        this.pendingSuggestions = this.pendingSuggestions.filter(s => !shouldRemove(s.file_path));
    }

    clear(): void {
        this.suggestions = [];
        this.pendingSuggestions = [];
    }

    /** Drop suggestions tied to blame keys removed after commit (multi-root isolation). */
    removeSuggestionsForBlameKeys(blameKeys: Set<string>): void {
        if (blameKeys.size === 0) {
            return;
        }
        this.suggestions = this.suggestions.filter(s => !blameKeys.has(s.file_path));
        this.pendingSuggestions = this.pendingSuggestions.filter(s => !blameKeys.has(s.file_path));
    }
}

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { workspaceFoldersUnderRepo } from '../utils/WorkspacePaths';

/**
 * In-memory suggestion records for matching accepted inline/ghost text to AI attribution.
 *
 * **Disk persistence under `branches/<branch>/trace/` is disabled** — no trace directory is written or read.
 */
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
        return this.suggestions.filter(
            s => !s.accepted && !this.pendingSuggestions.find(p => p.suggestion_id === s.suggestion_id)
        );
    }

    async persist(_workspaceRoot: string): Promise<void> {
        /* trace/ disk disabled */
    }

    async persistToAllWorkspaceRoots(_workspaceRoots: string[]): Promise<void> {
        /* trace/ disk disabled */
    }

    async load(_workspaceRoot: string): Promise<void> {
        this.clear();
    }

    async mergeLoadFromWorkspaceRoots(_workspaceRoots: string[]): Promise<void> {
        void _workspaceRoots;
        this.clear();
    }

    /**
     * Drop in-memory suggestions for workspace folders in this repo. No trace files are read or written.
     */
    async onGitBranchSwitch(repoRoot: string, _oldBranch: string, _newBranch: string): Promise<void> {
        const folders = workspaceFoldersUnderRepo(repoRoot);
        if (folders.length === 0) {
            return;
        }
        this.removeSuggestionsForWorkspaceFolders(folders);
    }

    private removeSuggestionsForWorkspaceFolders(folders: vscode.WorkspaceFolder[]): void {
        if (folders.length === 0) {
            return;
        }
        if ((vscode.workspace.workspaceFolders?.length ?? 0) <= 1) {
            this.clear();
            return;
        }
        const prefixes = folders.map(f => `${f.name}/`);
        const shouldRemove = (fp: string) => prefixes.some(p => fp.startsWith(p));
        this.suggestions = this.suggestions.filter(s => !shouldRemove(s.file_path));
        this.pendingSuggestions = this.pendingSuggestions.filter(s => !shouldRemove(s.file_path));
    }

    async resetTraceAfterBlamelyNote(repoRoot: string): Promise<void> {
        const folders = workspaceFoldersUnderRepo(repoRoot);
        if (folders.length === 0) {
            return;
        }
        this.removeSuggestionsForWorkspaceFolders(folders);
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

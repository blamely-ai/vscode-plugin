import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as Logger from '../utils/Logger';
import { getAiTraceDir } from '../git/GitUtils';

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

    async persist(workspaceRoot: string): Promise<void> {
        try {
            const outDir = await getAiTraceDir(workspaceRoot) || path.join(workspaceRoot, '.git', 'ai-trace');
            if (!fs.existsSync(outDir)) {
                await fs.promises.mkdir(outDir, { recursive: true });
            }
            const sessionPath = path.join(outDir, 'session.json');
            const data = {
                suggestions: this.suggestions,
                pendingSuggestions: this.pendingSuggestions,
            };
            await fs.promises.writeFile(sessionPath, JSON.stringify(data, null, 2), 'utf-8');
            Logger.info(`Saved session state to ${sessionPath}`);
        } catch (err) {
            Logger.error('Failed to persist trace session', err);
        }
    }

    async load(workspaceRoot: string): Promise<void> {
        try {
            const outDir = await getAiTraceDir(workspaceRoot) || path.join(workspaceRoot, '.git', 'ai-trace');
            const sessionPath = path.join(outDir, 'session.json');

            if (!fs.existsSync(sessionPath)) {
                this.clear();
                return;
            }

            const raw = await fs.promises.readFile(sessionPath, 'utf-8');
            const data = JSON.parse(raw);
            this.suggestions = data.suggestions || [];
            this.pendingSuggestions = data.pendingSuggestions || [];
            Logger.info(`Loaded trace session from ${sessionPath}`);
        } catch (err) {
            Logger.error('Failed to load trace session', err);
            this.clear();
        }
    }

    clear(): void {
        this.suggestions = [];
        this.pendingSuggestions = [];
    }
}

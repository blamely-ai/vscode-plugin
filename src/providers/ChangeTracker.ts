import * as vscode from 'vscode';
import { TraceStore } from '../store/TraceStore';
import { BlameMap } from '../blame/BlameMap';
import { reindex } from '../blame/BlameIndex';
import { matchSuggestion } from '../utils/DiffMatcher';
import { normalizePath } from '../utils/Platform';
import * as Logger from '../utils/Logger';
import * as AiContextExtractor from '../utils/AiContextExtractor';

export class ChangeTracker implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private traceStore: TraceStore;
    private blameMap: BlameMap;
    private onBlameUpdated: () => void;
    private aiActiveUntil: number = 0;

    /** Default exclude patterns matching IntelliJ DocumentChangeTracker.EXCLUDE_PATTERNS */
    private static readonly DEFAULT_EXCLUDE_PATTERNS = [
        'node_modules', '.git', 'dist', 'build', 'out', 'target',
        'detector.ai', 'ai-trace-report.md', 'blamely-report.md',
        '.log', '/log/', '\\log\\', '/logs/', '\\logs\\',
        '.tmp', '.temp', '.cache', '.min.js', '.min.css',
        '.lock', '.lockb', '.idea/', '.vscode/',
    ];

    /** File extensions to exclude, matching IntelliJ EXCLUDE_EXTENSIONS */
    private static readonly EXCLUDE_EXTENSIONS = new Set(['log', 'lock', 'lockb', 'tmp', 'temp', 'cache', 'map']);
    private lastAiActionStartedAt: number = 0;
    private chatRequestSentAt: number = 0;
    private lastDetectedPrompt: string | null = null;
    private lastDetectedModel: string | null = null;
    private lastDetectedProvider: string | null = null;
    private lastDetectedInteractionType: string | null = null;
    private lastProcessedEventKey: string | null = null;
    private lastProcessedEventTime: number = 0;
    private static readonly DUPLICATE_EVENT_WINDOW_MS = 400;

    /** While set, document changes only reindex/decrement — no new attribution (matches IntelliJ notifyRollback). */
    private rollbackActiveUntil: number = 0;
    private static readonly ROLLBACK_WINDOW_MS = 3000;

    // Debounce queue for capturing rapid sequential events from Copilot Chat
    private eventQueue: {
        document: vscode.TextDocument;
        filePath: string;
        combinedInsert: string;
        blameObjects: import('../blame/BlameMap').LineBlame[];
        matchedAiSynchronously: boolean;
        providerId?: string;
        sessionId?: string;
        prompt?: string | null;
        model?: string | null;
        isLargeReplacement?: boolean;
        formatPreserved?: boolean;
    }[] = [];
    private debounceTimer: NodeJS.Timeout | null = null;

    constructor(traceStore: TraceStore, blameMap: BlameMap, onBlameUpdated: () => void) {
        this.traceStore = traceStore;
        this.blameMap = blameMap;
        this.onBlameUpdated = onBlameUpdated;
        this.register();
    }

    private register(): void {
        const disposable = vscode.workspace.onDidChangeTextDocument(
            (event) => this.handleChange(event)
        );
        this.disposables.push(disposable);
    }

    /**
     * Mark document changes within the given window as AI.
     * Called when an AI action is detected (completion, chat inline, chat panel apply, etc.).
     * Mirrors IntelliJ DocumentChangeTracker.markNextChangeAsAi.
     */
    public markNextChangeAsAi(
        durationMs: number = 500,
        prompt?: string | null,
        model?: string | null,
        provider?: string | null,
        interactionType?: string | null
    ): void {
        const now = Date.now();
        if (this.aiActiveUntil < now) {
            this.lastAiActionStartedAt = now;
            if (interactionType === 'chat_panel' && this.chatRequestSentAt > 0) {
                this.lastAiActionStartedAt = this.chatRequestSentAt;
                this.chatRequestSentAt = 0;
            }
        }
        const newDeadline = now + durationMs;
        if (newDeadline > this.aiActiveUntil) {
            this.aiActiveUntil = newDeadline;
        }
        if (prompt) this.lastDetectedPrompt = prompt;
        if (model) this.lastDetectedModel = model;
        if (provider) this.lastDetectedProvider = provider;
        if (interactionType) this.lastDetectedInteractionType = interactionType;
    }

    /** Record when user sends a chat message, so time_waiting_for_ai = (apply time - this). */
    public recordChatRequestSent(): void {
        this.chatRequestSentAt = Date.now();
    }

    private clearAiContext(): void {
        this.lastDetectedPrompt = null;
        this.lastDetectedModel = null;
        this.lastDetectedProvider = null;
        this.lastDetectedInteractionType = null;
    }

    /**
     * VCS rollback / revert detected. Sets a window during which document changes are only reindexed
     * (decrement + reindex), not attributed. Blame is updated per change; we do not clear the whole map
     * so a single-line undo only affects that line (matches IntelliJ notifyRollback).
     */
    public notifyRollback(): void {
        this.rollbackActiveUntil = Date.now() + ChangeTracker.ROLLBACK_WINDOW_MS;
        this.onBlameUpdated();
        Logger.info('Rollback window active: blame will update per change only');
    }

    private async handleChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (event.document.uri.scheme !== 'file') { return; }

        const config = vscode.workspace.getConfiguration('aiTrace');
        const excludePatterns: string[] = config.get('excludePatterns', ChangeTracker.DEFAULT_EXCLUDE_PATTERNS);

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(event.document.uri);
        const relativePath = workspaceFolder
            ? normalizePath(vscode.workspace.asRelativePath(event.document.uri, false))
            : normalizePath(event.document.uri.fsPath);

        for (const pattern of excludePatterns) {
            if (relativePath.includes(pattern)) return;
        }

        const pathLower = relativePath.toLowerCase();
        const ext = pathLower.includes('.') ? pathLower.split('.').pop()! : '';
        if (ChangeTracker.EXCLUDE_EXTENSIONS.has(ext) ||
            pathLower.endsWith('.min.js') || pathLower.endsWith('.min.css')) {
            return;
        }

        // Explicitly check for standard Undo (1) or Redo (2)
        // Cursor AI uses custom reason codes for its AI edits which previously triggered this as a false positive
        const isUndoOrRedo = event.reason === vscode.TextDocumentChangeReason.Undo ||
            event.reason === vscode.TextDocumentChangeReason.Redo;

        let combinedInsert = '';
        let matchedAiSynchronously = false;
        let aiProviderId = 'heuristic_ai';
        let aiSessionId = 'heuristic-' + Date.now();
        let aiPromptStr: string | null = null;
        let aiModelStr: string | null = null;
        const allModifiedBlames: import('../blame/BlameMap').LineBlame[] = [];
        let isLargeReplacement = false;
        let formatPreserved = false;

        for (const change of event.contentChanges) {
            if (change.rangeLength > 50) {
                isLargeReplacement = true;
            }
            combinedInsert += change.text;
            const result = await this.processChange(event.document, relativePath, change, isUndoOrRedo);
            if (result.blameObjects) {
                allModifiedBlames.push(...result.blameObjects);
            }
            if (result.matchedAi) {
                matchedAiSynchronously = true;
                if (result.providerId) aiProviderId = result.providerId;
                if (result.sessionId) aiSessionId = result.sessionId;
                if (result.prompt) aiPromptStr = result.prompt;
                if (result.model) aiModelStr = result.model;
            }
            if (result.formatPreserved) {
                formatPreserved = true;
            }
        }

        // Push the results of THIS synchronous batch into the queue
        this.eventQueue.push({
            document: event.document,
            filePath: relativePath,
            combinedInsert,
            blameObjects: allModifiedBlames,
            matchedAiSynchronously,
            providerId: aiProviderId,
            sessionId: aiSessionId,
            prompt: aiPromptStr,
            model: aiModelStr,
            isLargeReplacement,
            formatPreserved
        });

        // Trigger the debouncer to evaluate the entire chain of events after 75ms
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // If it's an undo/redo, don't trigger the heuristic fallback at all
        if (!isUndoOrRedo) {
            this.debounceTimer = setTimeout(() => this.processEventQueue(), 150); // Increased to 150ms to strictly catch Cursor streams that burst multiple 20ms chunks
        }

        this.onBlameUpdated();
    }

    private async processEventQueue() {
        if (this.eventQueue.length === 0) return;

        const batch = [...this.eventQueue];
        this.eventQueue = [];

        const anyMatchedAi = batch.some(q => q.matchedAiSynchronously);
        let activeProviderId = AiContextExtractor.resolveProviderName(this.lastDetectedProvider);
        let activeSessionId = 'heuristic-' + Date.now();
        let activePrompt: string | null = this.lastDetectedPrompt;
        let activeModel = this.lastDetectedModel ?? await this.getActiveAiModel();

        if (anyMatchedAi) {
            // Find the active credentials from the matched AI event
            const matchEvent = batch.find(q => q.matchedAiSynchronously);
            if (matchEvent) {
                if (matchEvent.providerId) activeProviderId = matchEvent.providerId;
                if (matchEvent.sessionId) activeSessionId = matchEvent.sessionId;
                if (matchEvent.prompt) activePrompt = matchEvent.prompt;
                if (matchEvent.model) activeModel = matchEvent.model;
            }

            for (const q of batch) {
                for (const b of q.blameObjects) {
                    // Because it was initially logged as human typing synchronously, 
                    // we must move those characters back over to the AI bucket.
                    if (b.authorType !== 'AI') {
                        b.aiChars = (b.aiChars || 0) + (b.humanChars || 0);
                        b.humanChars = 0;
                    }

                    b.authorType = 'AI';
                    b.provider = activeProviderId;
                    b.model = activeModel;
                    b.prompt = activePrompt;
                }
            }
            this.onBlameUpdated();
            return; // We successfully attributed everything to AI via synchronous match
        }

        // --- Heuristic Fallback ---
        // If no part of the sequence matched AI synchronously, combine all the text
        // and check if it's a large paste vs an AI generated block vs fast human typing.
        const totalInsertLength = batch.reduce((sum, q) => sum + q.combinedInsert.length, 0);

        const combinedString = batch.map(q => q.combinedInsert).join('');
        const hasMultiCharChunks = batch.some(q => q.combinedInsert.length > 2); // Not just 1-by-1 manual typing
        const containsNewline = combinedString.includes('\n');

        // Heuristic Rules for AI Gen / Paste:
        // 1. Must contain multi-char chunks (cannot be pure 1-by-1 manual typing, no matter how fast)
        // 2. AND must either contain multiple lines OR be a massive single-line generation
        // 3. AND it must NOT be a massive document replacement (e.g. formatter or git checkout)
        // 4. AND it must NOT be a format-only change where we preserved ownership
        const hasLargeReplacement = batch.some(q => (q as any).isLargeReplacement);
        const hasFormatPreserved = batch.some(q => (q as any).formatPreserved);

        if (!hasLargeReplacement && !hasFormatPreserved && hasMultiCharChunks && (containsNewline || totalInsertLength > 30)) {
            const allBlameObjects = batch.flatMap(q => q.blameObjects);

            const filePath = batch[0].filePath;
            const document = batch[0].document;

            await this.checkClipboardAndReattributeBatch(document, filePath, combinedString, allBlameObjects);
            this.onBlameUpdated();
        }
    }

    private async getActiveAiModel(): Promise<string> {
        const detected = await AiContextExtractor.detectModel();
        return detected ?? AiContextExtractor.detectProvider() ?? 'unknown-ai';
    }

    private extractPromptNear(document: vscode.TextDocument, startLineIndex: number): string | null {
        // Look back up to 3 lines for a comment block
        const limit = Math.max(0, startLineIndex - 3);
        const promptLines: string[] = [];
        let foundComment = false;

        for (let i = startLineIndex - 1; i >= limit; i--) {
            const lineText = document.lineAt(i).text.trim();
            if (lineText.startsWith('//') || lineText.startsWith('#') || lineText.startsWith('*')) {
                const cleaned = lineText.replace(/^(\/\/|#|\*)\s*/, '');

                // Skip decorative separators (lines that are mostly special chars like ──, ===, ---, ***)
                if (/^[─━═\-=*~_<>│|\s]{3,}$/.test(cleaned) || /^[─━═\-=*~_]+\s+.*\s+[─━═\-=*~_]+$/.test(cleaned)) {
                    continue;
                }

                promptLines.unshift(cleaned);
                foundComment = true;
            } else if (lineText === '' && !foundComment) {
                // Skip immediate blank lines, continue looking up
                continue;
            } else {
                break;
            }
        }
        return foundComment && promptLines.join(' ').trim().length > 0 ? promptLines.join(' ') : null;
    }

    private async checkClipboardAndReattributeBatch(
        document: vscode.TextDocument,
        filePath: string,
        combinedInsert: string,
        blameObjects: import('../blame/BlameMap').LineBlame[]
    ) {
        if (blameObjects.length === 0) return;

        try {
            const clip = await vscode.env.clipboard.readText();
            const normalizedClip = clip.replace(/\r\n/g, '\n').trim();
            const normalizedInsert = combinedInsert.replace(/\r\n/g, '\n').trim();

            // If the combined text matches clipboard closely, it's a paste (Human)
            if (normalizedClip && (normalizedClip.includes(normalizedInsert) || normalizedInsert.includes(normalizedClip))) {
                return;
            }

            const mockSessionId = 'heuristic-' + Date.now();
            let modelName = this.lastDetectedModel ?? await this.getActiveAiModel();
            let providerId = AiContextExtractor.resolveProviderName(this.lastDetectedProvider);

            // Find the earliest line changed to extract the prompt from above it
            const minLine = Math.min(...blameObjects.map(b => b.lineNumber));
            let prompt = this.extractPromptNear(document, minLine);

            // Group suggestions based on contiguous ranges to keep TraceStore clean
            blameObjects.sort((a, b) => a.lineNumber - b.lineNumber);
            if (blameObjects.length > 0) {
                this.traceStore.addSuggestion(filePath, blameObjects[0].lineNumber, blameObjects[blameObjects.length - 1].lineNumber, 0, 0, combinedInsert, providerId, '', modelName, prompt);
                this.traceStore.markAccepted(mockSessionId, combinedInsert);
            }

            // Mutate the object references directly! 
            // This safely bypasses any line_number shifts that happened asynchronously via BlameIndex.reindex
            for (const b of blameObjects) {
                if (b.authorType !== 'AI') {
                    b.authorType = 'AI';
                    b.aiChars = (b.aiChars || 0) + (b.humanChars || 0);
                    b.humanChars = 0;
                    b.provider = providerId;
                    b.model = modelName;
                    b.prompt = prompt;
                }
            }

            Logger.info(`Heuristically re-attributed ${blameObjects.length} lines to AI across ${filePath} despite diff splitting`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            Logger.warn(`Failed clipboard heuristic check: ${msg}`);
        }
    }

    /** Threshold: replacement of this many chars or more with similar line count is treated as format (preserve ownership). */
    private static readonly FORMAT_LIKE_RANGE_LENGTH = 30;
    /** Max line count difference to consider a replacement as format-like (e.g. formatter adds/removes blank lines). */
    private static readonly FORMAT_LIKE_LINE_DIFF = 3;

    private async processChange(
        document: vscode.TextDocument,
        filePath: string,
        change: vscode.TextDocumentContentChangeEvent,
        isUndoOrRedo: boolean = false
    ): Promise<{ blameObjects: import('../blame/BlameMap').LineBlame[], matchedAi: boolean, providerId?: string, sessionId?: string, prompt?: string | null, model?: string | null, formatPreserved?: boolean }> {
        const insertedText = change.text;
        const startLine = change.range.start.line + 1; // 1-indexed
        const deletedLineCount = change.range.end.line - change.range.start.line + 1;
        const insertedLines = insertedText.split('\n');
        const insertedLineCount = insertedLines.length;

        // Capture blame for the replaced range before any mutation so we can preserve ownership on format
        const isFormatLike = change.rangeLength >= ChangeTracker.FORMAT_LIKE_RANGE_LENGTH &&
            Math.abs(insertedLineCount - deletedLineCount) <= ChangeTracker.FORMAT_LIKE_LINE_DIFF;
        let preservedBlame: import('../blame/BlameMap').LineBlame[] = [];
        if (isFormatLike && deletedLineCount > 0) {
            const existing = this.blameMap.getBlame(filePath);
            const endLine = startLine + deletedLineCount - 1;
            for (const e of existing) {
                if (e.lineNumber >= startLine && e.lineNumber <= endLine) {
                    preservedBlame.push({
                        ...e,
                        lineNumber: e.lineNumber,
                    });
                }
            }
            preservedBlame.sort((a, b) => a.lineNumber - b.lineNumber);
        }

        // Decrement char counts for deleted content before reindex (so entries still exist when we reduce)
        if (change.rangeLength > 0) {
            const oldFragment =
                deletedLineCount <= 1
                    ? 'x'.repeat(Math.max(1, Math.min(change.rangeLength, 1000)))
                    : Array(deletedLineCount)
                          .fill('x')
                          .join('\n');
            this.blameMap.decrementCharsForDeletion(filePath, startLine, oldFragment);
            if (Date.now() < this.aiActiveUntil) {
                this.blameMap.recordAiDeletion(filePath, startLine, deletedLineCount);
            }
        }

        // Reindex existing blame entries after deletion handling
        const existing = this.blameMap.getBlame(filePath);
        const reindexed = reindex(existing, startLine, insertedLineCount, deletedLineCount);
        this.blameMap.setFileBlame(filePath, reindexed);

        if (insertedText.length === 0) {
            if (change.rangeLength > 0) {
                return { blameObjects: [], matchedAi: false };
            }
            return { blameObjects: [], matchedAi: false };
        }

        // Undo/redo or rollback window: only decrement + reindex were applied above; do not attribute restored text
        // so a single-line undo only removes that line's blame (matches IntelliJ).
        const now = Date.now();
        if (isUndoOrRedo || now < this.rollbackActiveUntil) {
            return { blameObjects: [], matchedAi: false };
        }

        // Empty-line detection: newline-only or blank-only inserts are always human (matches IntelliJ)
        const isNewlineOnly = insertedText.length > 0 && /^\n+$/.test(insertedText);
        const isEmptyLineInsert = isNewlineOnly || (insertedLines.every(l => l.trim() === '') && insertedText.includes('\n'));

        // Duplicate event suppression (same file/line/content within 400ms window)
        if (!isNewlineOnly) {
            const eventKey = `${filePath}:${startLine}:${insertedText.length}:${insertedText.slice(0, 200)}`;
            if (eventKey === this.lastProcessedEventKey && (now - this.lastProcessedEventTime) < ChangeTracker.DUPLICATE_EVENT_WINDOW_MS) {
                return { blameObjects: [], matchedAi: false };
            }
            this.lastProcessedEventKey = eventKey;
            this.lastProcessedEventTime = now;
        }

        // If empty line, always attribute as human with 1 char per newline
        if (isEmptyLineInsert) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            const numNewlines = (insertedText.match(/\n/g) || []).length;
            const blameLineEnd = startLine + numNewlines - 1;
            const charsPerLine = Array(numNewlines).fill(1);
            const affected = this.blameMap.setAttribute(
                filePath, startLine, blameLineEnd < startLine ? startLine : blameLineEnd,
                'HUMAN', null, null, null, null, undefined, numNewlines, charsPerLine
            );
            return { blameObjects: affected, matchedAi: false };
        }

        // Try to match against pending suggestions OR the intercept flag
        const pending = this.traceStore.getPendingSuggestions();
        const match = matchSuggestion(pending, insertedText, filePath, {
            line: change.range.start.line,
            character: change.range.start.character,
        });

        const isInterceptedAi = (now < this.aiActiveUntil) && insertedText.length > 0;

        // Compute per-line char counts for accurate attribution (matches IntelliJ charsPerLineOverride)
        const charsPerLine = insertedLines.map(seg => seg.trim() === '' ? 1 : seg.length);
        const totalBlameChars = charsPerLine.reduce((a, b) => a + b, 0);

        if (isInterceptedAi) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            const endLine = startLine + insertedLineCount - 1;
            const providerId = AiContextExtractor.resolveProviderName(this.lastDetectedProvider);
            const mockSessionId = 'inline-' + Date.now();
            const modelName = this.lastDetectedModel ?? await this.getActiveAiModel();
            const prompt = this.lastDetectedPrompt ?? this.extractPromptNear(document, change.range.start.line);
            const interactionType = this.lastDetectedInteractionType ?? 'completion';

            if (this.lastAiActionStartedAt > 0) {
                const waitMs = now - this.lastAiActionStartedAt;
                this.blameMap.addTimeWaitingForAi(waitMs);
                this.lastAiActionStartedAt = 0;
            }

            this.markNextChangeAsAi(3000);

            this.traceStore.addSuggestion(filePath, startLine, endLine, 0, 0, insertedText, providerId, '', modelName, prompt);
            this.traceStore.markAccepted(mockSessionId, insertedText);

            const affected = this.blameMap.setAttribute(filePath, startLine, endLine, 'AI', providerId, modelName, prompt, interactionType, undefined, totalBlameChars, charsPerLine);
            Logger.info(`AI detected (window): ${filePath}:${startLine}-${endLine} provider=${providerId} model=${modelName} type=${interactionType}`);
            return { blameObjects: affected, matchedAi: true, providerId, sessionId: mockSessionId, prompt, model: modelName };

        } else if (match) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            this.traceStore.markAccepted(match.suggestion.suggestion_id, insertedText);
            const endLine = startLine + insertedLineCount - 1;

            const affected = this.blameMap.setAttribute(
                filePath, startLine, endLine, 'AI',
                match.suggestion.provider_id, match.suggestion.model_name, match.suggestion.prompt,
                null, undefined, totalBlameChars, charsPerLine
            );

            Logger.info(
                `AI suggestion accepted: ${match.suggestion.suggestion_id.slice(0, 8)} ` +
                `(${match.suggestion.provider_id}) in ${filePath}:${startLine}-${endLine} ` +
                `(similarity: ${match.similarity.toFixed(2)})`
            );
            return { blameObjects: affected, matchedAi: true, providerId: match.suggestion.provider_id, sessionId: match.suggestion.suggestion_id, prompt: match.suggestion.prompt, model: match.suggestion.model_name };
        } else {
            let affected: import('../blame/BlameMap').LineBlame[];
            if (preservedBlame.length > 0) {
                // Format-like change: preserve existing ownership instead of attributing to HUMAN
                affected = this.blameMap.setAttributeFromPreserved(filePath, startLine, preservedBlame, insertedLineCount);
            } else {
                affected = this.blameMap.setAttribute(
                    filePath, startLine, startLine + insertedLineCount - 1, 'HUMAN',
                    null, null, null, null, undefined, totalBlameChars, charsPerLine
                );
            }

            if (this.aiActiveUntil < now) {
                this.clearAiContext();
            }

            return {
                blameObjects: affected,
                matchedAi: false,
                formatPreserved: preservedBlame.length > 0
            };
        }
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

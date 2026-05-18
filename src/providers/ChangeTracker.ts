import * as vscode from 'vscode';
import * as path from 'path';
import { TraceStore } from '../store/TraceStore';
import { type CliTraceSession } from '../store/CliTraceLoader';
import { BlameMap } from '../blame/BlameMap';
import { reindex } from '../blame/BlameIndex';
import { matchSuggestion } from '../utils/DiffMatcher';
import { BLAMELY_REPO_DETECTOR_FILENAME, normalizePath } from '../utils/Platform';
import { blameFileKey, blameKeyBelongsToRepo, workspaceRootForBlameKey } from '../utils/WorkspacePaths';
import * as AiContextExtractor from '../utils/AiContextExtractor';
import * as BlameSerializer from '../blame/BlameSerializer';
import { computeNextStreamingFlushSchedule } from './streamingFlushSchedule';
import {
    codingTypeForTextInsert,
    heuristicCandidateFromBatchSignals,
    heuristicChunkIsMultiCharacter,
    isClipboardExactPasteAfterNormalize,
    isEmptyLineInsertText,
    normalizeInsertPlainText,
} from './editAttributionHeuristics';
import { chatPanelSignal } from '../utils/chatPanelSignal';
import {
    anyChatLikeTabOpen,
    summarizeSubstantialInsert,
} from '../utils/substantialChatTabPoke';
import {
    CHAT_STREAM_BURST_GAP_MS,
    CHAT_STREAM_BURST_MIN_ACCUM_FOR_POKE,
    nextChatStreamBurstState,
    chatStreamBurstQualifiesForPoke,
    type ChatStreamBurstState,
} from '../utils/chatApplyStreamingBurst';
import {
    captureDocLines,
    linesTouchedInAfterDoc,
    linesTouchedInAfterDocSingleEditWindow,
    narrowIntervalsByTouch,
    trustChatApplyEditorSpan,
} from '../utils/snapshotLineTouch';
import { insertAttributedLineRange1Based } from '../utils/insertAttributedLineRange';

export class ChangeTracker implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private traceStore: TraceStore;
    private blameMap: BlameMap;
    private onBlameUpdated: () => void;
    private aiActiveUntil: number = 0;
    private cliTraceSessions: CliTraceSession[] = [];

    /** Default exclude patterns matching IntelliJ DocumentChangeTracker.EXCLUDE_PATTERNS */
    private static readonly DEFAULT_EXCLUDE_PATTERNS = [
        'node_modules', '.git', 'dist', 'build', 'out', 'target',
        BLAMELY_REPO_DETECTOR_FILENAME, 'blamely-report.md',
        '.log', '/log/', '\\log\\', '/logs/', '\\logs\\',
        '.tmp', '.temp', '.cache', '.min.js', '.min.css',
        '.lock', '.lockb', '.idea/', '.vscode/',
    ];

    /** File extensions to exclude, matching IntelliJ EXCLUDE_EXTENSIONS */
    private static readonly EXCLUDE_EXTENSIONS = new Set(['log', 'lock', 'lockb', 'tmp', 'temp', 'cache', 'map']);
    private lastAiActionStartedAt: number = 0;
    private chatRequestSentAt: number = 0;
    /**
     * Copy of {@link chatRequestSentAt} for metrics: not cleared when apply/poke consumes
     * {@link chatRequestSentAt}, so the first AI-attributed edit still measures send→edit latency.
     */
    private chatSendWaitAnchorMs: number = 0;
    private lastDetectedPrompt: string | null = null;
    private lastDetectedModel: string | null = null;
    private lastDetectedProvider: string | null = null;
    private lastDetectedInteractionType: string | null = null;
    private lastProcessedEventKey: string | null = null;
    private lastProcessedEventTime: number = 0;
    private static readonly DUPLICATE_EVENT_WINDOW_MS = 400;

    /**
     * After {@link recordChatRequestSent}, the model may wait on HTTP (Copilot `responses`, etc.)
     * before any apply command runs; short AI windows expire. Substantive inserts while this marker
     * is fresh open a chat_panel intercept window so streamed/ workspace applies still count as AI.
     */
    private static readonly CHAT_REPLY_ATTRIBUTION_MAX_MS = 240_000;

    /** Set when we observe a chat-style apply command (even if after document edits). Used to avoid mis-classifying chat output as human paste in {@link checkClipboardAndReattributeBatch}. */
    private lastTrackedChatApplyCommandAt: number = 0;
    private static readonly CHAT_APPLY_CLIPBOARD_GRACE_MS = 6000;

    /** After a tracked chat apply, allow format-like heuristic AI bias even when no extensions match. */
    private static readonly CHAT_APPLY_HEURISTIC_BIAS_MS = 120_000;

    /**
     * If {@link checkClipboardAndReattributeBatch} skipped AI because clipboard matched insert before we saw
     * the chat-apply command, we store args here so {@link recordChatApplyCommandObserved} can retry.
     */
    private lastHeuristicClipboardRetry:
        | {
              uriString: string;
              filePath: string;
              combinedInsert: string;
              blameObjects: import('../blame/BlameMap').LineBlame[];
              createdAt: number;
          }
        | null = null;

    /** While set, document changes only reindex/decrement — no new attribution (matches IntelliJ notifyRollback). */
    private rollbackActiveUntil: number = 0;
    private static readonly ROLLBACK_WINDOW_MS = 3000;

    /**
     * Short window after blame restore (e.g. extension activation) during which the
     * "clean document → external VCS" guard is suppressed. Prevents auto-formats / LSP
     * rewrites that arrive immediately after restore from clobbering loaded AI blame.
     */
    private postRestoreGraceUntil: number = 0;

    /** Delay before treating a synchronous "clean" document as an external disk/git update (vscode#27231). */
    private static readonly EXTERNAL_VCS_DIRTY_RECHECK_MS = 15;

    /** After a substantial chat-tab poke, ignore clean-doc probes — saves/reconciliation falsely arm external-VCS grace. */
    private static readonly POST_SUBSTANTIAL_CHAT_POKE_CLEAN_DOC_SUPPRESS_MS = 45_000;

    private lastSubstantialChatTabPokeAt: number = 0;

    /** Copilot/chat stream many micro-insert events per logical apply — accumulate before opening AI window. */
    private chatStreamBurstByUri = new Map<string, ChatStreamBurstState>();

    /**
     * Whole-document line snapshots per URI (after each handled edit). Compared to the next edit so we only
     * attribute lines that actually changed when hosts replace huge spans (chat panel full-buffer apply).
     */
    private docLinesSnapshotByUri = new Map<string, string[]>();

    /**
     * After stash apply / merge / checkout, large inserts are not clipboard-matched and the AI heuristic
     * would falsely mark them as AI. While active, rollback does not block human attribution and the
     * heuristic batch step is skipped.
     */
    private externalVcsApplyUntil: number = 0;

    /** After Undo/Redo, omit snapshot writes until a normal edit on that file; disk snapshot is removed. */
    private suppressedSnapshotsAfterUndo = new Set<string>();

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
        rangeLength: number;
        formatPreserved?: boolean;
        /** Lines in the post-edit document that differ from the pre-edit snapshot (1-based); optional per txn. */
        snapshotTouchedLines?: Set<number>;
        /**
         * When true, {@link snapshotTouchedLines} must not filter or narrow blame — the editor span is
         * authoritative (LCS touch under-counts duplicate-line completions).
         */
        trustEditorAttributedSpan?: boolean;
    }[] = [];
    private debounceTimer: NodeJS.Timeout | null = null;
    /** Coalesced flush after tracked apply/keep (see {@link flushDeferredClassificationAfterApplyCommand}). */
    private applyCommandFlushTimer: NodeJS.Timeout | null = null;

    /** Debounced *.blame.json writes so partial in-line deletes refresh disk without waiting for manual save. */
    private static readonly BLAME_DISK_DEBOUNCE_MS = 450;
    private blameDiskFlushTimers = new Map<string, NodeJS.Timeout>();

    /** Streaming-aware flush timing implemented in streamingFlushSchedule (unit-tested there). */
    private heuristicFlushLastChunkAt = 0;
    private heuristicFlushBurstStart = 0;

    private static readonly CLASSIFICATION_LOG_MAX = 50;
    private classificationLogLines: string[] = [];

    constructor(
        traceStore: TraceStore,
        blameMap: BlameMap,
        onBlameUpdated: () => void
    ) {
        this.traceStore = traceStore;
        this.blameMap = blameMap;
        this.onBlameUpdated = onBlameUpdated;
        this.register();
    }

    /** Seed {@link docLinesSnapshotByUri} so the next edit can diff minimal touched lines (call on open buffer). */
    public seedDocSnapshot(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file') {
            return;
        }
        this.docLinesSnapshotByUri.set(document.uri.toString(), captureDocLines(document));
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
            const inReplyWindow =
                this.chatRequestSentAt > 0 &&
                now - this.chatRequestSentAt <= ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS;
            if (
                this.chatRequestSentAt > 0 &&
                (interactionType === 'chat_panel' ||
                    interactionType === 'chat_inline' ||
                    (interactionType === null && inReplyWindow))
            ) {
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

    /**
     * Accumulates BlameMap "time waiting for AI": wall-clock from chat send (if observed) or last
     * apply/intercept arm ({@link lastAiActionStartedAt}) until this first AI-attributed edit.
     * Safe to call multiple times per burst; anchors are cleared after the first non-zero add.
     */
    private recordTimeWaitingForAiIfAnchored(now: number): void {
        let anchor = 0;
        if (this.chatSendWaitAnchorMs > 0) {
            const age = now - this.chatSendWaitAnchorMs;
            if (age > ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS * 2) {
                this.chatSendWaitAnchorMs = 0;
            } else {
                anchor = this.chatSendWaitAnchorMs;
            }
        }
        if (anchor === 0 && this.lastAiActionStartedAt > 0) {
            anchor = this.lastAiActionStartedAt;
        }
        if (anchor > 0) {
            const waitMs = now - anchor;
            if (waitMs > 0) {
                this.blameMap.addTimeWaitingForAi(waitMs);
            }
        }
        this.lastAiActionStartedAt = 0;
        this.chatSendWaitAnchorMs = 0;
    }

    /**
     * `onDidExecuteCommand` runs after apply/keep finishes; {@link handleChange} may still be finishing
     * async work. Cancel the debounced flush and schedule one shortly so {@link processEventQueue} sees
     * `aiActiveUntil` + interaction metadata for chat-apply batch fallback in `processEventQueue`.
     */
    public flushDeferredClassificationAfterApplyCommand(): void {
        if (this.applyCommandFlushTimer) {
            clearTimeout(this.applyCommandFlushTimer);
            this.applyCommandFlushTimer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.heuristicFlushBurstStart = 0;
        this.heuristicFlushLastChunkAt = 0;
        this.applyCommandFlushTimer = setTimeout(() => {
            this.applyCommandFlushTimer = null;
            void this.processEventQueue();
        }, 32);
    }

    /** Record when user sends a chat message, so time_waiting_for_ai = (apply time - this). */
    public recordChatRequestSent(): void {
        const at = Date.now();
        this.chatRequestSentAt = at;
        this.chatSendWaitAnchorMs = at;
        chatPanelSignal('tracker-record-chat-request-sent', { at });
    }

    /** Call from command listener when a tracked chat apply / keep-all / multi-diff accept runs. */
    public recordChatApplyCommandObserved(commandId: string): void {
        // Always stamp: {@link promoteAmbientChatSurfaceToCompletion} and blame attribution rely on this even
        // when {@link detectInteractionType} heuristics mis-classify a panel apply id as `completion`.
        this.lastTrackedChatApplyCommandAt = Date.now();
        const t = AiContextExtractor.detectInteractionType(commandId);
        chatPanelSignal('tracker-record-chat-apply-observed', { commandId, interactionType: t });
        if (t !== 'chat_panel' && t !== 'chat_inline') {
            return;
        }
        const snap = this.lastHeuristicClipboardRetry;
        if (!snap || Date.now() - snap.createdAt > 12_000) {
            this.lastHeuristicClipboardRetry = null;
            return;
        }
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === snap.uriString);
        if (!doc || doc.isClosed) {
            this.lastHeuristicClipboardRetry = null;
            return;
        }
        void this.checkClipboardAndReattributeBatch(doc, snap.filePath, snap.combinedInsert, snap.blameObjects).then(
            () => this.onBlameUpdated(),
            () => undefined
        );
        this.lastHeuristicClipboardRetry = null;
    }

    private clearStaleDetectedMetadata(): void {
        this.lastDetectedPrompt = null;
        this.lastDetectedModel = null;
        this.lastDetectedProvider = null;
        this.lastDetectedInteractionType = null;
    }

    /** Clear model/prompt hints after human edits; keep {@link lastDetectedInteractionType} for multi-chunk chat apply + batch fallback. */
    private clearHumanEditAiHints(): void {
        this.lastDetectedPrompt = null;
        this.lastDetectedModel = null;
        this.lastDetectedProvider = null;
    }

    /**
     * Clears the pending AI intercept window and all metadata (prompt/model/provider/type, timers).
     * Use when the user explicitly rejects/discards AI output or VCS rollback — not for ordinary
     * human typing (that path only clears stale metadata so {@link chatRequestSentAt} stays valid).
     */
    public resetAiInterceptState(): void {
        this.aiActiveUntil = 0;
        this.lastAiActionStartedAt = 0;
        this.chatRequestSentAt = 0;
        this.chatSendWaitAnchorMs = 0;
        this.lastTrackedChatApplyCommandAt = 0;
        this.lastHeuristicClipboardRetry = null;
        this.clearStaleDetectedMetadata();
    }

    /** Expires the AI-only edit window without clearing {@link chatRequestSentAt} (chat reply timing). */
    private endAiInterceptWindowOnly(): void {
        this.aiActiveUntil = 0;
        this.lastAiActionStartedAt = 0;
        this.clearStaleDetectedMetadata();
    }

    /**
     * Substantial-insert / stream-burst poke: always tag {@code chat_panel}. This path only runs when a
     * chat-like tab or AI host is open — not for ghost inline completion alone — so we must not leave a
     * stale {@code completion} label from an earlier Tab accept.
     */
    public armChatTrafficInterceptWindow(durationMs: number, provider: string | null): void {
        this.markNextChangeAsAi(durationMs, null, null, provider, 'chat_panel');
    }

    /**
     * When {@link lastDetectedInteractionType} is only {@code chat_panel}/{@code chat_inline} from ambient
     * editor/traffic poke — not a tracked Apply command nor an in-flight chat-send→reply window —
     * treat the attributed intercept edit as inline completion so manual Enter is not classified as a chat
     * stream newline chunk (see empty-line handling in {@link processChange}).
     */
    private promoteAmbientChatSurfaceToCompletion(nowMs: number): void {
        const t = this.lastDetectedInteractionType;
        if (t !== 'chat_panel' && t !== 'chat_inline') {
            return;
        }
        if (
            this.lastTrackedChatApplyCommandAt > 0 &&
            nowMs - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_HEURISTIC_BIAS_MS
        ) {
            return;
        }
        if (
            this.chatRequestSentAt > 0 &&
            nowMs - this.chatRequestSentAt <= ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS
        ) {
            return;
        }
        this.lastDetectedInteractionType = 'completion';
    }

    /**
     * Chat/agent applies stream many line replacements where rangeLen≈insertLen and charDelta≈0 — that
     * matches {@link FORMAT_LIKE_*}} heuristics and wrongly preserves Human blame for fresh AI text.
     */
    private shouldSuppressFormatLikePreservation(nowMs: number): boolean {
        if (nowMs < this.aiActiveUntil) {
            return true;
        }
        if (
            this.lastTrackedChatApplyCommandAt > 0 &&
            nowMs - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_HEURISTIC_BIAS_MS
        ) {
            return true;
        }
        if (
            this.chatRequestSentAt > 0 &&
            nowMs - this.chatRequestSentAt <= ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS
        ) {
            return true;
        }
        return false;
    }

    /**
     * After chat apply or during AI intercept, the buffer can become clean on save — not a git disk refresh.
     * Suppresses vscode#27231 clean-document external-VCS probe so heuristics still promote AI.
     */
    private shouldSuppressCleanDocExternalVcsProbe(nowMs: number): boolean {
        if (nowMs < this.aiActiveUntil) {
            return true;
        }
        if (this.chatRequestSentAt > 0) {
            return true;
        }
        if (
            this.lastTrackedChatApplyCommandAt > 0 &&
            nowMs - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_HEURISTIC_BIAS_MS
        ) {
            return true;
        }
        if (
            this.lastSubstantialChatTabPokeAt > 0 &&
            nowMs - this.lastSubstantialChatTabPokeAt < ChangeTracker.POST_SUBSTANTIAL_CHAT_POKE_CLEAN_DOC_SUPPRESS_MS
        ) {
            return true;
        }
        return false;
    }

    /**
     * VCS rollback / revert detected. Sets a window during which document changes are only reindexed
     * (decrement + reindex), not attributed. Blame is updated per change; we do not clear the whole map
     * so a single-line undo only affects that line (matches IntelliJ notifyRollback).
     */
    public notifyRollback(): void {
        this.rollbackActiveUntil = Date.now() + ChangeTracker.ROLLBACK_WINDOW_MS;
        this.docLinesSnapshotByUri.clear();
        this.resetAiInterceptState();
        console.log('Rollback window active: blame will update per change only');
        this.onBlameUpdated();
        /** Defer so status bar / decorations pick up blame after Git/SCM-applied edits land. */
        setTimeout(() => this.onBlameUpdated(), 0);
    }

    /** Clear persisted HEAD blame JSON and in-memory rows for every given repo root (SCM discard-all). */
    public async clearPersistedSnapshotsForRepoRoots(repoRoots: readonly string[]): Promise<void> {
        for (const root of repoRoots) {
            const norm = path.normalize(root);
            await BlameSerializer.clearCurrentBranchSnapshots(root);
            const toClear = this.blameMap.getTrackedFiles().filter(fp => blameKeyBelongsToRepo(norm, fp));
            for (const fp of toClear) {
                this.blameMap.removeFile(fp);
                this.suppressedSnapshotsAfterUndo.add(fp);
            }
        }
        this.onBlameUpdated();
        setTimeout(() => this.onBlameUpdated(), 0);
    }

    /** Remove on-disk snapshots for SCM discard / rollback for specific files (see `git.clean` listener). */
    public async removePersistedSnapshotsForFileUris(fileUris: readonly vscode.Uri[]): Promise<void> {
        if (fileUris.length === 0) {
            return;
        }
        for (const uri of fileUris) {
            if (uri.scheme !== 'file') {
                continue;
            }
            const key = blameFileKey(uri);
            const wsRoot =
                workspaceRootForBlameKey(key) ?? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
            if (!wsRoot) {
                console.log(`removePersistedSnapshotsForFileUris: no workspace root for ${uri.fsPath}`);
                continue;
            }
            this.blameMap.removeFile(key);
            await BlameSerializer.removeSnapshot(wsRoot, key);
            this.suppressedSnapshotsAfterUndo.add(key);
        }
        this.onBlameUpdated();
        setTimeout(() => this.onBlameUpdated(), 0);
    }

    /**
     * Omits periodic and on-save BlameSerializer writes while a VCS rollback window is active, or until
     * a substantive edit clears per-file Undo suppression. Checkout / deactivate still checkpoints explicitly.
     */
    public isSnapshotPersistSuppressed(blameKey: string): boolean {
        if (Date.now() < this.rollbackActiveUntil) {
            return true;
        }
        return this.suppressedSnapshotsAfterUndo.has(blameKey);
    }

    /**
     * Call when Git mutates the worktree (e.g. stash apply/pop, checkout paths) on the current branch.
     * Suppresses the “bulk insert = AI” heuristic and keeps human attribution for those edits.
     */
    public notifyExternalVcsApply(durationMs: number = 20_000): void {
        this.externalVcsApplyUntil = Date.now() + durationMs;
        this.resetAiInterceptState();
        console.log(
            `[Blamely] External VCS apply window active (${durationMs}ms): stash/checkout edits treated as human, AI heuristic off`
        );
    }

    /** True during stash/checkout apply grace — skip SCM discard snapshot removal (stock VS Code has no git command events). */
    public isGitDiscardSnapshotSkipActive(): boolean {
        return Date.now() < this.externalVcsApplyUntil;
    }

    /**
     * Open a short grace window during which the "clean document → external VCS" guard
     * in {@link handleChange} is suppressed. Call right after restoring blame on activation.
     */
    public setPostRestoreGrace(durationMs: number): void {
        this.postRestoreGraceUntil = Date.now() + durationMs;
    }

    public setCliTraces(sessions: CliTraceSession[]): void {
        this.cliTraceSessions = sessions;
    }

    public getCliTraceSessions(): CliTraceSession[] {
        return this.cliTraceSessions;
    }

    /** Last ~50 heuristic / AI gate decisions for `blamely.debug.dumpLastClassification`. */
    public getClassificationDebugLog(): string {
        return this.classificationLogLines.length > 0
            ? this.classificationLogLines.join('\n')
            : '(no classification events recorded yet — edit a file with Blamely active)';
    }

    private pushClassificationLine(message: string): void {
        const line = `[${new Date().toISOString()}] ${message}`;
        this.classificationLogLines.push(line);
        if (this.classificationLogLines.length > ChangeTracker.CLASSIFICATION_LOG_MAX) {
            this.classificationLogLines.splice(
                0,
                this.classificationLogLines.length - ChangeTracker.CLASSIFICATION_LOG_MAX
            );
        }
    }

    /** Debounced flush of {@link eventQueue}: extends while streaming chunks arrive within gap window. */
    private scheduleHeuristicFlush(): void {
        const now = Date.now();
        const scheduled = computeNextStreamingFlushSchedule(
            now,
            this.heuristicFlushBurstStart,
            this.heuristicFlushLastChunkAt
        );
        this.heuristicFlushBurstStart = scheduled.burstStartMs;
        this.heuristicFlushLastChunkAt = scheduled.lastChunkAtMs;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        const delay = scheduled.delayMs;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.heuristicFlushBurstStart = 0;
            this.heuristicFlushLastChunkAt = 0;
            void this.processEventQueue();
        }, delay);
    }

    private async handleChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (event.document.uri.scheme !== 'file') { return; }
        const config = vscode.workspace.getConfiguration('blamely');
        const basePatterns: string[] = config.get('excludePatterns', ChangeTracker.DEFAULT_EXCLUDE_PATTERNS);
        const additionalPatterns: string[] = config.get('additionalExcludePatterns', []);
        const excludePatterns: string[] = [...new Set([...basePatterns, ...additionalPatterns])];

        const relativePath = blameFileKey(event.document.uri);

        for (const pattern of excludePatterns) {
            if (relativePath.includes(pattern)) return;
        }

        const pathLower = relativePath.toLowerCase();
        const ext = pathLower.includes('.') ? pathLower.split('.').pop()! : '';
        if (ChangeTracker.EXCLUDE_EXTENSIONS.has(ext) ||
            pathLower.endsWith('.min.js') || pathLower.endsWith('.min.css')) {
            return;
        }

        const isUndoOrRedo = event.reason === vscode.TextDocumentChangeReason.Undo ||
            event.reason === vscode.TextDocumentChangeReason.Redo;
        if (!isUndoOrRedo) {
            this.suppressedSnapshotsAfterUndo.delete(relativePath);
        } else {
            this.suppressedSnapshotsAfterUndo.add(relativePath);
        }

        const uriStrSnap = event.document.uri.toString();
        const linesBeforeSnap = this.docLinesSnapshotByUri.get(uriStrSnap);
        const linesAfterSnap = captureDocLines(event.document);

        if (event.contentChanges.length === 0) {
            this.docLinesSnapshotByUri.set(uriStrSnap, linesAfterSnap);
            return;
        }

        let normalizedLineTouch: Set<number> | null =
            !isUndoOrRedo && linesBeforeSnap !== undefined
                ? linesTouchedInAfterDoc(linesBeforeSnap, linesAfterSnap)
                : null;
        if (
            normalizedLineTouch === null &&
            !isUndoOrRedo &&
            linesBeforeSnap !== undefined &&
            event.contentChanges.length === 1
        ) {
            const ch = event.contentChanges[0];
            const ins0 = ch.text.length === 0 ? 0 : ch.text.split('\n').length;
            normalizedLineTouch = linesTouchedInAfterDocSingleEditWindow(
                linesBeforeSnap,
                linesAfterSnap,
                ch.range.start.line,
                ch.range.end.line,
                ins0
            );
        }

        // Format-on-open, EOF newline, CRLF, or trailing-space touch-ups often produce real
        // TextDocumentChangeEvents whose lines match after {@link normalizeLineForSnapshotCompare}.
        // Running normal attribution creates spurious HUMAN/AI rows and persists *.blame.json for files
        // the user only opened.
        if (
            !isUndoOrRedo &&
            linesBeforeSnap !== undefined &&
            normalizedLineTouch !== null &&
            normalizedLineTouch.size === 0
        ) {
            this.docLinesSnapshotByUri.set(uriStrSnap, linesAfterSnap);
            return;
        }

        const insertSummary = summarizeSubstantialInsert(event.contentChanges);

        const uriBurstKey = event.document.uri.toString();
        const nowBurst = Date.now();
        const burstState = nextChatStreamBurstState(
            this.chatStreamBurstByUri.get(uriBurstKey),
            nowBurst,
            CHAT_STREAM_BURST_GAP_MS,
            {
                insertLen: insertSummary.insertLen,
                maxChunk: insertSummary.maxChunk,
                newlineRuns: insertSummary.newlineRuns,
            }
        );
        this.chatStreamBurstByUri.set(uriBurstKey, burstState);

        const viaChatTab = anyChatLikeTabOpen();
        const viaAiHost = AiContextExtractor.anyAiCodingAssistantHostDetected();
        const chatSurface = viaChatTab || viaAiHost;

        const substantialPoke = !isUndoOrRedo && chatSurface && insertSummary.substantial;
        const streamBurstPoke =
            !isUndoOrRedo &&
            chatSurface &&
            !insertSummary.substantial &&
            chatStreamBurstQualifiesForPoke(burstState, CHAT_STREAM_BURST_MIN_ACCUM_FOR_POKE);

        // Open AI window before processChange so classification sees aiActiveUntil (workspace listener order
        // cannot be relied on; extension-level poke ran after ChangeTracker and was always too late).
        // Cursor / Composer often omit chat-like tab labels — fall back to AI-host detection (Cursor app name,
        // vscode.lm, or installed assistant extensions) so native chat applies still get an intercept window.
        // Streaming: single-event "substantial" thresholds miss Copilot — accumulate burst across CHAT_STREAM_BURST_GAP_MS.
        if (substantialPoke || streamBurstPoke) {
            const provider = AiContextExtractor.detectProvider();
            this.armChatTrafficInterceptWindow(10_000, provider);
            this.lastSubstantialChatTabPokeAt = Date.now();
            this.chatStreamBurstByUri.delete(uriBurstKey);

            const pokeMode = streamBurstPoke ? 'stream-burst' : 'single-event-substantial';
            const signalKind = streamBurstPoke ? 'chat-panel-stream-burst-poke' : 'substantial-edit-with-chat-tab-poke';
            chatPanelSignal(signalKind, {
                insertLen: insertSummary.insertLen,
                maxChunk: insertSummary.maxChunk,
                newlineRuns: insertSummary.newlineRuns,
                burstAccumulated: burstState.accumulatedLen,
                uri: event.document.uri.fsPath,
                via: viaChatTab ? 'chat-tab' : 'ai-host-installed',
                pokeMode,
            });
            console.log('[Blamely][chat-traffic] chat-panel AI intercept window opened', {
                pokeMode,
                insertLenThisEvent: insertSummary.insertLen,
                burstAccumulated: burstState.accumulatedLen,
                via: viaChatTab ? 'chat-tab' : 'ai-host-installed',
                provider: provider ?? null,
            });
        }

        // Git/stash/checkout updates that arrive from disk often modify editors while the document
        // remains clean. Mark them as external VCS applies up-front so those inserts stay HUMAN.
        // Skip while an AI-intercept window is active (chat applies arrive before isDirty flips)
        // and during the post-restore grace (auto-formats/LSP rewrites right after activation
        // would otherwise clobber loaded AI blame).
        // Skip for substantial inserts in this transaction — vscode often reports isDirty=false on the first
        // edit (#27231); arming external-VCS grace here nukes chat-panel AI via resetAiInterceptState + demotion.
        const nowTs = Date.now();
        if (
            !event.document.isDirty &&
            nowTs >= this.postRestoreGraceUntil &&
            !insertSummary.substantial &&
            !this.shouldSuppressCleanDocExternalVcsProbe(nowTs)
        ) {
            const uriStr = event.document.uri.toString();
            setTimeout(() => {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
                if (!doc || doc.isClosed || doc.isDirty) {
                    return;
                }
                const t = Date.now();
                if (t < this.postRestoreGraceUntil || this.shouldSuppressCleanDocExternalVcsProbe(t)) {
                    return;
                }
                this.notifyExternalVcsApply(60_000);
            }, ChangeTracker.EXTERNAL_VCS_DIRTY_RECHECK_MS);
        }

        let snapshotTouchedLines: Set<number> | undefined;
        if (!isUndoOrRedo && normalizedLineTouch !== null && normalizedLineTouch.size > 0) {
            snapshotTouchedLines = normalizedLineTouch;
        }
        this.docLinesSnapshotByUri.set(uriStrSnap, linesAfterSnap);

        // One queue item per contentChange so debounced AI promotion only touches blame from AI-matched
        // chunks — not human newlines in the same document transaction (e.g. Enter then chat apply).
        for (const change of event.contentChanges) {
            const result = await this.processChange(
                event.document,
                relativePath,
                change,
                isUndoOrRedo,
                snapshotTouchedLines
            );
            this.eventQueue.push({
                document: event.document,
                filePath: relativePath,
                combinedInsert: change.text,
                blameObjects: result.blameObjects ?? [],
                matchedAiSynchronously: result.matchedAi,
                providerId: result.providerId,
                sessionId: result.sessionId,
                prompt: result.prompt,
                model: result.model,
                rangeLength: change.rangeLength,
                formatPreserved: result.formatPreserved ?? false,
                snapshotTouchedLines,
                trustEditorAttributedSpan: result.trustEditorAttributedSpan ?? false,
            });
        }

        if (isUndoOrRedo) {
            const ws =
                workspaceRootForBlameKey(relativePath) ??
                vscode.workspace.getWorkspaceFolder(event.document.uri)?.uri.fsPath;
            if (ws) {
                await BlameSerializer.removeSnapshot(ws, relativePath);
            }
        } else {
            this.scheduleBlameDiskFlush(relativePath, event.document);
        }

        // Immediate UI refresh so each line appears as a continuous stream
        this.onBlameUpdated();

        // If it's an undo/redo, don't trigger the heuristic fallback at all
        if (!isUndoOrRedo) {
            this.scheduleHeuristicFlush();
        }

        this.onBlameUpdated();
    }

    private async processEventQueue() {
        if (this.eventQueue.length === 0) return;

        const batch = [...this.eventQueue];
        this.eventQueue = [];
        this.pushClassificationLine(`Flush ${batch.length} chunk(s) ${batch[0]?.filePath ?? '?'}`);
        const nowFlush = Date.now();
        const totalInsertLen = batch.reduce((sum, q) => sum + q.combinedInsert.length, 0);
        const chatPanelLike =
            this.lastDetectedInteractionType === 'chat_panel' ||
            this.lastDetectedInteractionType === 'chat_inline' ||
            (this.chatRequestSentAt > 0 &&
                nowFlush - this.chatRequestSentAt <= ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS);
        /** Sync flags can all be false across chunks (metadata cleared mid-transaction, newline splits, race). */
        const chatApplyBatchFallback =
            !batch.some(q => q.matchedAiSynchronously) &&
            nowFlush < this.aiActiveUntil &&
            chatPanelLike &&
            totalInsertLen >= 4;
        const anyMatchedAi =
            batch.some(q => q.matchedAiSynchronously) || chatApplyBatchFallback;
        let activeProviderId = AiContextExtractor.resolveProviderName(this.lastDetectedProvider);
        let activeSessionId = 'heuristic-' + Date.now();
        let activePrompt: string | null = this.lastDetectedPrompt;
        let activeModel = this.lastDetectedModel ?? await this.getActiveAiModel();

        if (anyMatchedAi && Date.now() < this.externalVcsApplyUntil) {
            for (const q of batch) {
                if (!chatApplyBatchFallback && !q.matchedAiSynchronously) {
                    continue;
                }
                for (const b of q.blameObjects) {
                    if (
                        q.snapshotTouchedLines &&
                        q.snapshotTouchedLines.size > 0 &&
                        !q.trustEditorAttributedSpan &&
                        !q.snapshotTouchedLines.has(b.lineNumber)
                    ) {
                        continue;
                    }
                    if (b.authorType === 'AI' || (b.aiChars ?? 0) > 0) {
                        b.humanChars = (b.humanChars || 0) + (b.aiChars || 0);
                        b.aiChars = 0;
                        b.authorType = 'HUMAN';
                        b.provider = null;
                        b.model = null;
                        b.prompt = null;
                    }
                }
            }
            this.pushClassificationLine('sync AI demoted to HUMAN (external VCS apply window)');
            this.onBlameUpdated();
            return;
        }

        if (anyMatchedAi) {
            const batchCombined = batch.map(q => q.combinedInsert).join('');
            let skipAiPromotionForClipboardPaste = false;
            try {
                const clip = await vscode.env.clipboard.readText();
                if (
                    isClipboardExactPasteAfterNormalize(
                        normalizeInsertPlainText(clip),
                        normalizeInsertPlainText(batchCombined)
                    )
                ) {
                    const recentChatApply =
                        Date.now() - this.lastTrackedChatApplyCommandAt <
                        ChangeTracker.CHAT_APPLY_CLIPBOARD_GRACE_MS;
                    const substantial = normalizeInsertPlainText(batchCombined).length >= 64;
                    skipAiPromotionForClipboardPaste = !(recentChatApply && substantial);
                }
            } catch {
                /* clipboard unavailable */
            }

            if (skipAiPromotionForClipboardPaste) {
                const pasteCoding = codingTypeForTextInsert(
                    batchCombined,
                    isEmptyLineInsertText(batchCombined)
                );
                for (const q of batch) {
                    if (!chatApplyBatchFallback && !q.matchedAiSynchronously) {
                        continue;
                    }
                    for (const b of q.blameObjects) {
                        if (
                            q.snapshotTouchedLines &&
                            q.snapshotTouchedLines.size > 0 &&
                            !q.trustEditorAttributedSpan &&
                            !q.snapshotTouchedLines.has(b.lineNumber)
                        ) {
                            continue;
                        }
                        b.humanChars = (b.humanChars || 0) + (b.aiChars || 0);
                        b.aiChars = 0;
                        b.authorType = 'HUMAN';
                        b.provider = null;
                        b.model = null;
                        b.prompt = null;
                        b.interactionType = null;
                        b.codingType = pasteCoding;
                    }
                }
                this.pushClassificationLine(
                    `batch: clipboard paste → HUMAN ${pasteCoding} (skipped AI window / fallback promotion)`
                );
                this.onBlameUpdated();
                return;
            }

            this.recordTimeWaitingForAiIfAnchored(nowFlush);
            const fallbackModel = activeModel;
            const aiBulkCoding = codingTypeForTextInsert(
                batchCombined,
                isEmptyLineInsertText(batchCombined)
            );
            for (const q of batch) {
                if (!chatApplyBatchFallback && !q.matchedAiSynchronously) {
                    continue;
                }
                if (q.blameObjects.length === 0) {
                    continue;
                }
                const credProvider = q.providerId ?? activeProviderId;
                const credSession = q.sessionId ?? activeSessionId;
                const credPrompt = q.prompt ?? activePrompt;
                const credModel = q.model ?? fallbackModel;
                const resolvedProvider = AiContextExtractor.resolveProviderName(credProvider);

                for (const b of q.blameObjects) {
                    if (
                        q.snapshotTouchedLines &&
                        q.snapshotTouchedLines.size > 0 &&
                        !q.trustEditorAttributedSpan &&
                        !q.snapshotTouchedLines.has(b.lineNumber)
                    ) {
                        continue;
                    }
                    if (b.authorType !== 'AI') {
                        b.aiChars = (b.aiChars || 0) + (b.humanChars || 0);
                        b.humanChars = 0;
                    }
                    b.authorType = 'AI';
                    b.provider = resolvedProvider;
                    b.model = credModel;
                    b.prompt = credPrompt;
                    b.codingType = aiBulkCoding;
                }
            }
            this.pushClassificationLine(
                chatApplyBatchFallback
                    ? 'batch finalized as AI (chat apply batch fallback)'
                    : 'batch finalized as AI (intercept/suggestion)'
            );
            this.onBlameUpdated();
            return;
        }

        if (Date.now() < this.externalVcsApplyUntil) {
            console.log(`[Blamely] Heuristic skipped: external VCS apply window active (${batch[0]?.filePath ?? '?'})`);
            this.pushClassificationLine('heuristic skipped: external VCS grace');
            this.onBlameUpdated();
            return;
        }

        // Do not use per-event isDirty: it is often false on the first edit (vscode#27231).
        // After debounce, if the document is still clean, treat as external VCS (skip heuristics).
        if (batch.some(q => {
            const d = q.document;
            return !d.isClosed && !d.isDirty;
        })) {
            console.log(`[Blamely] Heuristic skipped: document is clean post-debounce (${batch[0]?.filePath ?? '?'})`);
            this.pushClassificationLine('heuristic skipped: document still clean (probable disk/git)');
            this.onBlameUpdated();
            return;
        }

        // --- Heuristic Fallback ---
        // If no part of the sequence matched AI synchronously, combine all the text
        // and check if it's a large paste vs an AI generated block vs fast human typing.
        const totalInsertLength = batch.reduce((sum, q) => sum + q.combinedInsert.length, 0);

        const combinedString = batch.map(q => q.combinedInsert).join('');
        const hasMultiCharChunks = batch.some(q => heuristicChunkIsMultiCharacter(q.combinedInsert));
        const containsNewline = combinedString.includes('\n');

        // Heuristic Rules for AI Gen / Paste (chat panel apply is the primary case in VS Code,
        // where the proposed onDidExecuteCommand API is unavailable and we cannot intercept the
        // apply command directly):
        // 1. Must contain multi-char chunks (cannot be pure 1-by-1 manual typing, no matter how fast)
        // 2. AND must either contain multiple lines OR be a massive single-line generation
        // 3. AND it must NOT be a format-only change where we preserved existing ownership
        // Note: a previous "isLargeReplacement = rangeLength > 50" gate was removed because it
        // caused chat-apply replacements (function bodies, etc.) to stay HUMAN. Real formatter /
        // checkout cases are now blocked earlier by externalVcsApplyUntil and processChange's
        // format-like preservedBlame path.
        const hasFormatPreserved = batch.some(q => q.formatPreserved);
        const filePathForLog = batch[0]?.filePath ?? '?';

        const isHeuristicAiCandidate = heuristicCandidateFromBatchSignals({
            hasFormatPreserved,
            hasMultiCharChunks,
            containsNewline,
            totalInsertLength,
        });

        const providers = AiContextExtractor.detectAllProviders();
        if (providers.length > 0) {
            console.log(`Heuristic context: installed AI extensions/providers: ${providers.join(', ')}`);
            this.pushClassificationLine(`installedProviders=[${providers.join(', ')}]`);
        }

        const allDocsStillDirty = batch.every(q => {
            const d = q.document;
            return !d.isClosed && d.isDirty;
        });

        const recentTrackedChatApply =
            this.lastTrackedChatApplyCommandAt > 0 &&
            nowFlush - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_HEURISTIC_BIAS_MS;
        const awaitingChatReplyForHeuristic =
            this.chatRequestSentAt > 0 &&
            nowFlush - this.chatRequestSentAt <= ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS;
        const chatSurfaceForHeuristic =
            (this.lastDetectedInteractionType === 'chat_panel' ||
                this.lastDetectedInteractionType === 'chat_inline') &&
            (nowFlush < this.aiActiveUntil ||
                recentTrackedChatApply ||
                awaitingChatReplyForHeuristic);

        /** Sidebar / LM hosts: small streamed chunks (Copilot, Claude, Cursor) vs conservative paste floor. */
        const providerBiasInsertFloor = AiContextExtractor.anyAiCodingAssistantHostDetected() ? 12 : 30;

        /**
         * Bypass strict format-preservation skip for large edits when we know chat/composer context
         * or any AI provider / built-in LM is present — chat panel applies often resemble formatter output.
         */
        const providerBiasHeuristic =
            (providers.length > 0 ||
                recentTrackedChatApply ||
                awaitingChatReplyForHeuristic ||
                chatSurfaceForHeuristic) &&
            allDocsStillDirty &&
            hasMultiCharChunks &&
            (containsNewline || totalInsertLength > providerBiasInsertFloor);

        if (isHeuristicAiCandidate || providerBiasHeuristic) {
            this.lastHeuristicClipboardRetry = null;
            console.log(
                `Heuristic AI candidate (${filePathForLog}): ` +
                    `chunks=${batch.length} totalInsertLen=${totalInsertLength} newline=${containsNewline}`
            );
            this.pushClassificationLine(
                `heuristic AI candidate (${filePathForLog}) chunks=${batch.length} insertLen=${totalInsertLength} nl=${containsNewline}` +
                    (providerBiasHeuristic && !isHeuristicAiCandidate ? ' providerBias=1' : '')
            );
            // Do not re-attribute blame from newline-only fragments (human blanks stay human).
            const allBlameObjects = batch.flatMap((q) => {
                const ins = q.combinedInsert.replace(/\r\n/g, '\n');
                if (/^\n+$/.test(ins)) {
                    return [];
                }
                const touch = q.snapshotTouchedLines;
                if (touch && touch.size > 0 && !q.trustEditorAttributedSpan) {
                    return q.blameObjects.filter((b) => touch.has(b.lineNumber));
                }
                return q.blameObjects;
            });

            const filePath = batch[0].filePath;
            const document = batch[0].document;

            await this.checkClipboardAndReattributeBatch(document, filePath, combinedString, allBlameObjects);
        } else {
            console.log(
                `Heuristic skipped (${filePathForLog}): ` +
                `formatPreserved=${hasFormatPreserved} multiCharChunks=${hasMultiCharChunks} ` +
                `newline=${containsNewline} totalInsertLen=${totalInsertLength}`
            );
            this.pushClassificationLine(
                `heuristic skipped (${filePathForLog}) format=${hasFormatPreserved} chunks=${hasMultiCharChunks} ` +
                    `newline=${containsNewline} insertLen=${totalInsertLength}`
            );
        }

        // Always refresh UI so human typing is reflected immediately after the debounce
        this.onBlameUpdated();
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
            const normalizedClip = normalizeInsertPlainText(clip);
            const normalizedInsert = normalizeInsertPlainText(combinedInsert);

            // Treat as paste (Human) only if clipboard EXACTLY equals the inserted text (after
            // CRLF/whitespace normalization). Substring matches are too loose: VS Code chat panels
            // sometimes copy apply text to the clipboard, so an `includes` check would mis-classify
            // chat-apply inserts as pasted-by-human and lose AI attribution.
            const clipboardExactPaste = isClipboardExactPasteAfterNormalize(normalizedClip, normalizedInsert);
            if (clipboardExactPaste) {
                const recentChatApply =
                    Date.now() - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_CLIPBOARD_GRACE_MS;
                const substantial = normalizedInsert.length >= 64;
                if (!(recentChatApply && substantial)) {
                    if (substantial) {
                        this.lastHeuristicClipboardRetry = {
                            uriString: document.uri.toString(),
                            filePath,
                            combinedInsert,
                            blameObjects: [...blameObjects],
                            createdAt: Date.now(),
                        };
                    }
                    const pasteCoding = codingTypeForTextInsert(
                        combinedInsert,
                        isEmptyLineInsertText(combinedInsert)
                    );
                    for (const b of blameObjects) {
                        b.humanChars = (b.humanChars || 0) + (b.aiChars || 0);
                        b.aiChars = 0;
                        b.authorType = 'HUMAN';
                        b.provider = null;
                        b.model = null;
                        b.prompt = null;
                        b.interactionType = null;
                        b.codingType = pasteCoding;
                    }
                    console.log(
                        `Heuristic skipped (${filePath}): exact clipboard paste detected, treated as HUMAN paste`
                    );
                    this.pushClassificationLine(
                        `heuristic: HUMAN paste ${pasteCoding} (clipboard exact match) ${filePath}`
                    );
                    return;
                }
            }

            const mockSessionId = 'heuristic-' + Date.now();
            const aiBulkCoding = codingTypeForTextInsert(
                combinedInsert,
                isEmptyLineInsertText(combinedInsert)
            );
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
                b.codingType = aiBulkCoding;
            }

            this.recordTimeWaitingForAiIfAnchored(Date.now());

            console.log(`Heuristically re-attributed ${blameObjects.length} lines to AI across ${filePath} despite diff splitting`);
            this.pushClassificationLine(`heuristic: AI ${blameObjects.length} line(s) ${filePath}`);
            this.lastHeuristicClipboardRetry = null;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`Failed clipboard heuristic check: ${msg}`);
        }
    }

    /** Threshold: replacement of this many chars or more with similar line count is treated as format (preserve ownership). */
    private static readonly FORMAT_LIKE_RANGE_LENGTH = 30;
    /** Max line count difference to consider a replacement as format-like.
     *  Real formatters (Prettier, ESLint --fix, Black) almost always keep line count or +/- 1 line.
     *  Chat-apply replacements that change > 2 lines are content edits, not formatting. */
    private static readonly FORMAT_LIKE_LINE_DIFF = 2;
    /** Real formatters keep char counts very close — they only adjust whitespace/indent and add
     *  the occasional semicolon or trailing comma. Chat-apply replacements typically grow or
     *  shrink content significantly. Require char delta within this ratio (10%) to qualify as
     *  format-like; otherwise treat as a content edit and let AI heuristics run. */
    private static readonly FORMAT_LIKE_CHAR_RATIO = 0.10;
    /** Even when the ratio is exceeded, very small absolute char deltas (e.g. adding semicolons
     *  to a short snippet) should still count as formatter so prior attribution is preserved. */
    private static readonly FORMAT_LIKE_CHAR_DELTA_FLOOR = 5;

    /**
     * Snapshot diff touch is for mis-reported huge ranges (chat apply). For local inserts, LCS can
     * under-count when new lines duplicate existing file lines — skip touch narrowing so completions
     * attribute every inserted line.
     *
     * Chat/composer localized applies additionally skip touch via {@link trustChatApplyEditorSpan}:
     * LCS alignment can swap which duplicate lines count as “touched”, producing blame on the wrong rows.
     */
    private static trustSnapshotTouchForNominalSpan(
        isPureInsertion: boolean,
        attrSpan: { start: number; end: number },
        insertedLineCount: number,
        deletedLineCount: number
    ): boolean {
        const w = attrSpan.end - attrSpan.start + 1;
        return (
            isPureInsertion ||
            (w <= 96 && insertedLineCount <= 96 && deletedLineCount <= 96)
        );
    }

    private async processChange(
        document: vscode.TextDocument,
        filePath: string,
        change: vscode.TextDocumentContentChangeEvent,
        isUndoOrRedo: boolean = false,
        snapshotTouchedAfter?: Set<number>
    ): Promise<{
        blameObjects: import('../blame/BlameMap').LineBlame[];
        matchedAi: boolean;
        providerId?: string;
        sessionId?: string;
        prompt?: string | null;
        model?: string | null;
        formatPreserved?: boolean;
        trustEditorAttributedSpan?: boolean;
    }> {
        const insertedText = change.text;
        const startLine = change.range.start.line + 1; // 1-indexed
        const deletedLineCount = change.range.end.line - change.range.start.line + 1;
        const insertedLines = insertedText.split('\n');
        // Empty inserts never add document lines. In particular `''.split('\n')` is `['']` (length 1);
        // using that for reindex makes Backspace (join line) look like insert+delete on one row
        // (linesInserted=linesDeleted=1 → net 0) so blame below the join is not shifted / removed.
        // Multi-line empty deletes already need linesInserted=0 — same rule covers them.
        const insertedLineCount = insertedText.length === 0 ? 0 : insertedLines.length;
        const now = Date.now();

        // Capture blame for the replaced range before any mutation so we can preserve ownership on format.
        // Format-like requires (a) a substantial replacement, (b) similar line count, AND
        // (c) char counts within FORMAT_LIKE_CHAR_RATIO (or below the absolute floor) — chat-apply
        // replacements that grow/shrink content significantly are NOT formatters and should fall
        // through to AI heuristics.
        const charDelta = Math.abs(insertedText.length - change.rangeLength);
        const charBase = Math.max(insertedText.length, change.rangeLength, 1);
        const isFormatLike =
            change.rangeLength >= ChangeTracker.FORMAT_LIKE_RANGE_LENGTH &&
            Math.abs(insertedLineCount - deletedLineCount) <= ChangeTracker.FORMAT_LIKE_LINE_DIFF &&
            (charDelta <= ChangeTracker.FORMAT_LIKE_CHAR_DELTA_FLOOR ||
                charDelta / charBase <= ChangeTracker.FORMAT_LIKE_CHAR_RATIO);
        let preservedBlame: import('../blame/BlameMap').LineBlame[] = [];
        const suppressFormatPreserve = this.shouldSuppressFormatLikePreservation(now);
        if (!suppressFormatPreserve && isFormatLike && deletedLineCount > 0) {
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
            if (preservedBlame.length > 0) {
                console.log(
                    `Format-like preservation (${filePath}:${startLine}): ` +
                        `rangeLen=${change.rangeLength} insertLen=${insertedText.length} ` +
                        `lineDiff=${Math.abs(insertedLineCount - deletedLineCount)} ` +
                        `charDelta=${charDelta} preservedLines=${preservedBlame.length}`
                );
            }
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
            if (now < this.aiActiveUntil) {
                this.blameMap.recordAiDeletion(filePath, startLine, deletedLineCount);
            }
        }

        // Reindex existing blame entries after deletion handling.
        // For pure insertions (rangeLength === 0, e.g. pressing Enter), nothing is deleted,
        // so we adjust reindex parameters: shift from the line BELOW the cursor to keep
        // the existing line's blame in place and open a gap for the new line.
        const isPureInsertion = change.rangeLength === 0;
        const numNewlines = (insertedText.match(/\n/g) || []).length;
        const attrSpan = insertAttributedLineRange1Based(
            change.range.start.character,
            startLine,
            insertedLines,
            insertedLineCount,
            numNewlines,
            isPureInsertion
        );
        const attrOff = Math.max(0, attrSpan.start - startLine);
        const attrN = attrSpan.end - attrSpan.start + 1;
        let attrSegs = insertedLines.slice(attrOff, attrOff + attrN);
        if (attrSegs.length !== attrN) {
            attrSegs = insertedLines.length > 0 ? insertedLines : Array(Math.max(1, attrN)).fill('');
        }
        const attrChars = attrSegs.map(seg => (seg.trim() === '' ? 1 : seg.length));
        const recentTrackedChatApplyForTouch =
            this.lastTrackedChatApplyCommandAt > 0 &&
            now - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_CLIPBOARD_GRACE_MS;
        const chatApplyTrustEditorSpanContext =
            this.lastDetectedInteractionType === 'chat_panel' ||
            this.lastDetectedInteractionType === 'chat_inline' ||
            recentTrackedChatApplyForTouch;
        const trustEditorAttributedSpan =
            ChangeTracker.trustSnapshotTouchForNominalSpan(
                isPureInsertion,
                attrSpan,
                insertedLineCount,
                deletedLineCount
            ) ||
            (chatApplyTrustEditorSpanContext &&
                trustChatApplyEditorSpan(attrSpan.end - attrSpan.start + 1, document.lineCount));
        /** Chat-panel replacements often cover unchanged lines; LCS touch trims AI/HUMAN to real edits. */
        const preferTouchNarrowForChatReplace =
            chatApplyTrustEditorSpanContext &&
            !isPureInsertion &&
            deletedLineCount > 0 &&
            snapshotTouchedAfter !== undefined &&
            snapshotTouchedAfter.size > 0;
        const lineTouchForNarrow =
            preferTouchNarrowForChatReplace ||
            (!trustEditorAttributedSpan &&
                snapshotTouchedAfter !== undefined &&
                snapshotTouchedAfter.size > 0)
                ? snapshotTouchedAfter
                : undefined;
        let reindexStartLine = startLine;
        let reindexInserted = insertedLineCount;
        let reindexDeleted = deletedLineCount;
        if (isPureInsertion && numNewlines > 0) {
            // Cursor in middle or end of line: content before cursor stays, new line(s) open below
            // Cursor at beginning of line (char 0): new empty line at startLine, old content shifts
            reindexStartLine = change.range.start.character > 0 ? startLine + 1 : startLine;
            reindexInserted = numNewlines;
            reindexDeleted = 0;
        } else if (
            change.range.start.line === change.range.end.line &&
            insertedText.length === 0 &&
            change.rangeLength > 0
        ) {
            // Single-line empty replace = delete characters on that row only. VS Code still uses
            // deletedLineCount=1 (one line in the range) but no document row is removed — join-line
            // deletes use a multi-line range. With reindexDeleted=1, blame rows were dropped or
            // shifted while only decrementCharsForDeletion should adjust char totals.
            reindexInserted = 0;
            reindexDeleted = 0;
        }
        const existing = this.blameMap.getBlame(filePath);
        const reindexed = reindex(existing, reindexStartLine, reindexInserted, reindexDeleted);
        if (reindexed.length === 0) {
            this.blameMap.removeFile(filePath);
            // No in-memory rows left — drop the sidecar on disk too. Otherwise autosave skips empty maps
            // (entries.length === 0) and *.blame.json keeps stale rows after the last blamed line is removed.
            if (!isUndoOrRedo) {
                const wsRoot =
                    workspaceRootForBlameKey(filePath) ??
                    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
                if (wsRoot && !this.isSnapshotPersistSuppressed(filePath)) {
                    await BlameSerializer.removeSnapshot(wsRoot, filePath);
                }
            }
        } else {
            this.blameMap.setFileBlame(filePath, reindexed);
        }

        if (insertedText.length === 0) {
            if (change.rangeLength > 0) {
                return { blameObjects: [], matchedAi: false, trustEditorAttributedSpan: false };
            }
            return { blameObjects: [], matchedAi: false, trustEditorAttributedSpan: false };
        }

        // Undo/redo or rollback window: only decrement + reindex were applied above; do not attribute restored text
        // so a single-line undo only removes that line's blame (matches IntelliJ).
        // External VCS (stash apply, etc.) still needs human attribution — bypass rollback during that grace window.
        const inExternalVcsGrace = now < this.externalVcsApplyUntil;
        if (isUndoOrRedo || (now < this.rollbackActiveUntil && !inExternalVcsGrace)) {
            return { blameObjects: [], matchedAi: false, trustEditorAttributedSpan: false };
        }

        // Empty-line detection: newline-only or blank-only inserts are always human (matches IntelliJ)
        const isEmptyLineInsert = isEmptyLineInsertText(insertedText);
        const insertCodingType = codingTypeForTextInsert(insertedText, isEmptyLineInsert);

        // Duplicate event suppression (same file/line/content within 400ms window).
        // Skip for empty-line inserts (newline + optional whitespace) — consecutive Enter
        // presses are distinct edits that happen to produce identical text.  When VS Code
        // batches rapid keystrokes into one event, all contentChanges share the same
        // pre-event range, so the eventKey would collide and suppress valid Enters.
        if (!isEmptyLineInsert) {
            const eventKey = `${filePath}:${startLine}:${insertedText.length}:${insertedText.slice(0, 200)}`;
            if (eventKey === this.lastProcessedEventKey && (now - this.lastProcessedEventTime) < ChangeTracker.DUPLICATE_EVENT_WINDOW_MS) {
                return { blameObjects: [], matchedAi: false, trustEditorAttributedSpan: false };
            }
            this.lastProcessedEventKey = eventKey;
            this.lastProcessedEventTime = now;
        }

        // Newline-only / blank-line inserts: human by default (IntelliJ parity), unless we are
        // inside an AI-apply window from chat or a recent tracked Apply — those often arrive as \n chunks.
        // After inline completion, a manual Enter must not inherit AI (clears the window).
        const inAiWindow = now < this.aiActiveUntil;
        const recentTrackedChatApply =
            this.lastTrackedChatApplyCommandAt > 0 &&
            now - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_CLIPBOARD_GRACE_MS;
        const chatApplyNewlineChunk =
            inAiWindow &&
            !inExternalVcsGrace &&
            (this.lastDetectedInteractionType === 'chat_panel' ||
                this.lastDetectedInteractionType === 'chat_inline' ||
                recentTrackedChatApply);

        if (isEmptyLineInsert && chatApplyNewlineChunk) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            const providerId = AiContextExtractor.resolveProviderName(this.lastDetectedProvider);
            const modelName = this.lastDetectedModel ?? await this.getActiveAiModel();
            const prompt = this.lastDetectedPrompt ?? this.extractPromptNear(document, change.range.start.line);
            const interactionType = this.lastDetectedInteractionType ?? 'chat_panel';
            const gapChars = Array(attrN).fill(1);
            const affected = this.attributeIntervalsAi(
                filePath,
                attrSpan.start,
                attrSpan.end,
                providerId,
                modelName,
                prompt,
                interactionType,
                gapChars,
                lineTouchForNarrow,
                document.lineCount,
                insertCodingType
            );
            return {
                blameObjects: affected,
                matchedAi: true,
                providerId,
                sessionId: 'gap-' + Date.now(),
                prompt,
                model: modelName,
                trustEditorAttributedSpan,
            };
        }

        if (isEmptyLineInsert && (!inAiWindow || inExternalVcsGrace)) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            const affected = this.attributeIntervalsHuman(
                filePath,
                attrSpan.start,
                attrSpan.end,
                attrChars,
                lineTouchForNarrow,
                document.lineCount,
                insertCodingType
            );
            return { blameObjects: affected, matchedAi: false, trustEditorAttributedSpan };
        }

        if (isEmptyLineInsert && inAiWindow && !chatApplyNewlineChunk) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            const affected = this.attributeIntervalsHuman(
                filePath,
                attrSpan.start,
                attrSpan.end,
                attrChars,
                lineTouchForNarrow,
                document.lineCount,
                insertCodingType
            );
            this.endAiInterceptWindowOnly();
            return { blameObjects: affected, matchedAi: false, trustEditorAttributedSpan };
        }

        // Stash apply / merge can deliver editor edits before Git's worktree listener runs, so
        // notifyExternalVcsApply may not have opened the grace window yet — but when it has,
        // treat all inserts as human and skip AI intercept, suggestion match, and later heuristic.
        if (inExternalVcsGrace) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            const totalCharsGrace = attrChars.reduce((a, b) => a + b, 0);
            const affected = this.blameMap.setAttribute(
                filePath,
                attrSpan.start,
                attrSpan.end,
                'HUMAN',
                null,
                null,
                null,
                null,
                undefined,
                totalCharsGrace,
                attrChars,
                insertCodingType
            );
            this.clearStaleDetectedMetadata();
            return { blameObjects: affected, matchedAi: false, trustEditorAttributedSpan };
        }

        // Expire abandoned chat-send markers (no reply applied within 2× the normal wait window).
        if (
            this.chatRequestSentAt > 0 &&
            now - this.chatRequestSentAt > ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS * 2
        ) {
            this.chatRequestSentAt = 0;
            this.chatSendWaitAnchorMs = 0;
        }

        const substantialForPendingChatReply =
            insertedText.length >= 2 ||
            numNewlines >= 1 ||
            insertedLineCount >= 2 ||
            change.rangeLength > 0;

        const awaitingChatPanelHttpReply =
            this.chatRequestSentAt > 0 &&
            now - this.chatRequestSentAt <= ChangeTracker.CHAT_REPLY_ATTRIBUTION_MAX_MS &&
            substantialForPendingChatReply;

        if (awaitingChatPanelHttpReply && now >= this.aiActiveUntil) {
            const ageMs = now - this.chatRequestSentAt;
            const provider = AiContextExtractor.detectProvider();
            console.log(
                `pending chat HTTP reply → markNextChangeAsAi (send→edit gap ${ageMs}ms) ` +
                    `len=${insertedText.length} provider=${provider ?? 'null'}`
            );
            chatPanelSignal('tracker-pending-chat-http-reply-mark-ai', {
                sendToEditGapMs: ageMs,
                insertLen: insertedText.length,
                provider: provider ?? null,
            });
            this.markNextChangeAsAi(
                AiContextExtractor.getAiWindowDuration('chat_panel'),
                null,
                this.lastDetectedModel,
                provider,
                'chat_panel'
            );
        }

        // Try to match against pending suggestions OR the intercept flag
        const pending = this.traceStore.getPendingSuggestions();
        const match = matchSuggestion(pending, insertedText, filePath, {
            line: change.range.start.line,
            character: change.range.start.character,
        });

        /**
         * If the inserted text exactly matches the system clipboard (after the same normalization as
         * heuristics), treat as explicit user paste → HUMAN, not AI intercept / not stale suggestion match.
         * Exception: right after a tracked chat Apply, large inserts often mirror clipboard — keep AI.
         */
        const hadAiInterceptBeforeClipboardCheck = now < this.aiActiveUntil;
        let clipboardPasteOverridesAiAttribution = false;
        if (insertedText.length > 0 && !isUndoOrRedo && (hadAiInterceptBeforeClipboardCheck || match)) {
            try {
                const clip = await vscode.env.clipboard.readText();
                const normalizedClip = normalizeInsertPlainText(clip);
                const normalizedInsert = normalizeInsertPlainText(insertedText);
                if (isClipboardExactPasteAfterNormalize(normalizedClip, normalizedInsert)) {
                    const recentChatApply =
                        Date.now() - this.lastTrackedChatApplyCommandAt <
                        ChangeTracker.CHAT_APPLY_CLIPBOARD_GRACE_MS;
                    const substantial = normalizedInsert.length >= 64;
                    if (!(recentChatApply && substantial)) {
                        clipboardPasteOverridesAiAttribution = true;
                    }
                }
            } catch {
                /* clipboard unavailable */
            }
        }

        const isInterceptedAi =
            hadAiInterceptBeforeClipboardCheck &&
            insertedText.length > 0 &&
            !clipboardPasteOverridesAiAttribution;

        const effectiveSuggestionMatch = clipboardPasteOverridesAiAttribution ? null : match;

        if (isInterceptedAi) {
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            const providerId = AiContextExtractor.resolveProviderName(this.lastDetectedProvider);
            const mockSessionId = 'inline-' + Date.now();
            const modelName = this.lastDetectedModel ?? await this.getActiveAiModel();
            const prompt = this.lastDetectedPrompt ?? this.extractPromptNear(document, change.range.start.line);

            this.recordTimeWaitingForAiIfAnchored(now);

            this.promoteAmbientChatSurfaceToCompletion(now);

            // Only extend the AI window for multi-character inserts (AI streaming chunks).
            // Single-character inserts are human typing and must NOT extend the window,
            // otherwise every keystroke after an AI edit perpetually re-extends the window
            // and all subsequent human typing gets attributed to AI.
            if (insertedText.length > 2) {
                this.markNextChangeAsAi(3000);
            }

            let interactionType = this.lastDetectedInteractionType ?? 'completion';
            if (
                interactionType === 'completion' &&
                this.lastTrackedChatApplyCommandAt > 0 &&
                now - this.lastTrackedChatApplyCommandAt < ChangeTracker.CHAT_APPLY_HEURISTIC_BIAS_MS
            ) {
                interactionType = 'chat_panel';
            }

            this.traceStore.addSuggestion(
                filePath,
                attrSpan.start,
                attrSpan.end,
                0,
                0,
                insertedText,
                providerId,
                '',
                modelName,
                prompt
            );
            this.traceStore.markAccepted(mockSessionId, insertedText);

            const affected = this.attributeIntervalsAi(
                filePath,
                attrSpan.start,
                attrSpan.end,
                providerId,
                modelName,
                prompt,
                interactionType,
                attrChars,
                lineTouchForNarrow,
                document.lineCount,
                insertCodingType
            );
            console.log(
                `AI detected (window): ${filePath}:${attrSpan.start}-${attrSpan.end} entries=${affected.length} ` +
                    `provider=${providerId} model=${modelName} type=${interactionType}`
            );
            return {
                blameObjects: affected,
                matchedAi: true,
                providerId,
                sessionId: mockSessionId,
                prompt,
                model: modelName,
                trustEditorAttributedSpan,
            };

        } else if (effectiveSuggestionMatch) {
            this.promoteAmbientChatSurfaceToCompletion(now);
            this.blameMap.recordFirstStartCodingTimeIfNeeded();
            this.traceStore.markAccepted(effectiveSuggestionMatch.suggestion.suggestion_id, insertedText);

            const affected = this.attributeIntervalsAi(
                filePath,
                attrSpan.start,
                attrSpan.end,
                effectiveSuggestionMatch.suggestion.provider_id,
                effectiveSuggestionMatch.suggestion.model_name,
                effectiveSuggestionMatch.suggestion.prompt,
                null,
                attrChars,
                lineTouchForNarrow,
                document.lineCount,
                insertCodingType
            );

            console.log(
                `AI suggestion accepted: ${effectiveSuggestionMatch.suggestion.suggestion_id.slice(0, 8)} ` +
                `(${effectiveSuggestionMatch.suggestion.provider_id}) in ${filePath}:${attrSpan.start}-${attrSpan.end} ` +
                `(similarity: ${effectiveSuggestionMatch.similarity.toFixed(2)})`
            );
            return {
                blameObjects: affected,
                matchedAi: true,
                providerId: effectiveSuggestionMatch.suggestion.provider_id,
                sessionId: effectiveSuggestionMatch.suggestion.suggestion_id,
                prompt: effectiveSuggestionMatch.suggestion.prompt,
                model: effectiveSuggestionMatch.suggestion.model_name,
                trustEditorAttributedSpan,
            };
        } else {
            let affected: import('../blame/BlameMap').LineBlame[];
            if (preservedBlame.length > 0) {
                // Format-like change: preserve existing ownership instead of attributing to HUMAN
                affected = this.blameMap.setAttributeFromPreserved(filePath, startLine, preservedBlame, insertedLineCount);
            } else {
                affected = this.attributeIntervalsHuman(
                    filePath,
                    attrSpan.start,
                    attrSpan.end,
                    attrChars,
                    lineTouchForNarrow,
                    document.lineCount,
                    insertCodingType
                );
            }

            const inAiWindow = now < this.aiActiveUntil;
            if (!inAiWindow) {
                this.clearHumanEditAiHints();
            }

            if (insertedText.length > 2) {
                console.log(
                    `[Blamely] classify HUMAN: ${filePath} L${startLine} insertLen=${insertedText.length} ` +
                        `inAiInterceptWindow=${inAiWindow} aiActiveUntil=${this.aiActiveUntil} now=${now} ` +
                        `deltaMs=${inAiWindow ? (this.aiActiveUntil - now) : (now - (this.aiActiveUntil || 0))} ` +
                        `rollback=${now < this.rollbackActiveUntil} extVcsGrace=${now < this.externalVcsApplyUntil} ` +
                        `formatPreserved=${preservedBlame.length > 0}` +
                        (clipboardPasteOverridesAiAttribution ? ' clipboardPaste=1' : '')
                );
            }

            if (clipboardPasteOverridesAiAttribution && hadAiInterceptBeforeClipboardCheck) {
                this.endAiInterceptWindowOnly();
                this.pushClassificationLine(
                    `sync: clipboard paste → HUMAN (cleared AI intercept window) ${filePath}`
                );
            }

            return {
                blameObjects: affected,
                matchedAi: false,
                formatPreserved: preservedBlame.length > 0,
                trustEditorAttributedSpan,
            };
        }
    }

    private attributeIntervalsHuman(
        filePath: string,
        startLine: number,
        endLine: number,
        charsPerLine: number[],
        touched: Set<number> | undefined,
        docLineCount: number,
        codingType: 'TYPING' | 'BULK_INSERT' = 'TYPING'
    ): import('../blame/BlameMap').LineBlame[] {
        const ranges = narrowIntervalsByTouch(startLine, endLine, touched, docLineCount);
        const merged: import('../blame/BlameMap').LineBlame[] = [];
        for (const r of ranges) {
            const off = r.start - startLine;
            const len = r.end - r.start + 1;
            const sub = charsPerLine.slice(off, off + len);
            const tot = sub.reduce((a, b) => a + b, 0);
            merged.push(
                ...this.blameMap.setAttribute(
                    filePath,
                    r.start,
                    r.end,
                    'HUMAN',
                    null,
                    null,
                    null,
                    null,
                    undefined,
                    tot,
                    sub,
                    codingType
                )
            );
        }
        return merged;
    }

    private attributeIntervalsAi(
        filePath: string,
        startLine: number,
        endLine: number,
        providerId: string,
        modelName: string | null,
        prompt: string | null,
        interactionType: string | null,
        charsPerLine: number[],
        touched: Set<number> | undefined,
        docLineCount: number,
        codingType: 'TYPING' | 'BULK_INSERT' = 'TYPING'
    ): import('../blame/BlameMap').LineBlame[] {
        const ranges = narrowIntervalsByTouch(startLine, endLine, touched, docLineCount);
        const merged: import('../blame/BlameMap').LineBlame[] = [];
        for (const r of ranges) {
            const off = r.start - startLine;
            const len = r.end - r.start + 1;
            const sub = charsPerLine.slice(off, off + len);
            const tot = sub.reduce((a, b) => a + b, 0);
            merged.push(
                ...this.blameMap.setAttribute(
                    filePath,
                    r.start,
                    r.end,
                    'AI',
                    providerId,
                    modelName,
                    prompt,
                    interactionType,
                    undefined,
                    tot,
                    sub,
                    codingType
                )
            );
        }
        return merged;
    }

    private scheduleBlameDiskFlush(blameKey: string, document: vscode.TextDocument): void {
        const prev = this.blameDiskFlushTimers.get(blameKey);
        if (prev !== undefined) {
            clearTimeout(prev);
        }
        const timer = setTimeout(() => {
            this.blameDiskFlushTimers.delete(blameKey);
            void this.flushBlameSnapshotToDisk(blameKey, document);
        }, ChangeTracker.BLAME_DISK_DEBOUNCE_MS);
        this.blameDiskFlushTimers.set(blameKey, timer);
    }

    private async flushBlameSnapshotToDisk(blameKey: string, document: vscode.TextDocument): Promise<void> {
        if (this.isSnapshotPersistSuppressed(blameKey)) {
            return;
        }
        const wsRoot =
            workspaceRootForBlameKey(blameKey) ??
            vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        if (!wsRoot) {
            return;
        }
        const entries = this.blameMap.getBlame(blameKey);
        try {
            if (entries.length === 0) {
                await BlameSerializer.removeSnapshot(wsRoot, blameKey);
            } else {
                await BlameSerializer.save(wsRoot, blameKey, entries);
            }
        } catch {
            /* non-critical */
        }
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.applyCommandFlushTimer) {
            clearTimeout(this.applyCommandFlushTimer);
            this.applyCommandFlushTimer = null;
        }
        for (const t of this.blameDiskFlushTimers.values()) {
            clearTimeout(t);
        }
        this.blameDiskFlushTimers.clear();
        this.chatStreamBurstByUri.clear();
        this.docLinesSnapshotByUri.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

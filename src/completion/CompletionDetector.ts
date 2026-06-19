import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { CliDataService } from '../cli/CliDataService';
import { getRepoId } from '../cli/repoId';
import { getRepoRoot, getBranchName, inProgressGitOp } from '../git/GitUtils';
import * as Logger from '../utils/Logger';
import { DaemonClient, EditPayload, EditRange, RemovedLineHash } from './DaemonClient';

// Minimum chars used only by the clipboard-paste heuristic below.
const MIN_COMPLETION_CHARS = 8;

// VS Code commands that fire exactly when an inline suggestion is committed.
// These are the ONLY events that trigger when a user accepts an inline
// completion from any provider (Copilot, Cursor Tab, JetBrains AI, etc.).
// They do NOT fire for snippet expansion, LSP code actions, or auto-import.
const INLINE_SUGGEST_COMMIT_CMDS = new Set([
    'editor.action.inlineSuggest.commit',           // Tab — accept full suggestion
    'editor.action.inlineSuggest.acceptNextWord',    // Cmd+Right — accept next word
    'editor.action.inlineSuggest.acceptNextLine',    // accept next line
]);

// Commands that fire when the user applies/inserts code FROM a chat panel
// ("Apply in Editor", "Insert at Cursor", agent edit-accept, inline-chat
// accept, Cursor Composer apply). The exact id varies by editor/version, so we
// match a curated set plus a permissive regex. Enable `blamely.debugDetection`
// to log every executed command id and discover the one your editor uses.
const CHAT_APPLY_CMDS = new Set([
    'github.copilot.chat.applyInEditor',
    'workbench.action.chat.applyInEditor',
    'workbench.action.chat.insertCodeBlock',
    'workbench.action.chat.insertIntoNewFile',
    'inlineChat.acceptChanges',
    'interactive.acceptChanges',
    'chatEditing.acceptAllFiles',
    'chatEditing.acceptFile',
    'aichat.insertselectionintoeditor', // Cursor
    'composer.applyDiff',               // Cursor Composer
]);

function isChatApplyCommand(id: string): boolean {
    if (CHAT_APPLY_CMDS.has(id)) return true;
    const l = id.toLowerCase();
    return (
        (/chat/.test(l) && /(apply|insert)/.test(l)) ||
        (/inlinechat/.test(l) && /accept/.test(l)) ||
        (/chatediting/.test(l) && /accept/.test(l)) ||
        (/composer/.test(l) && /(apply|accept)/.test(l))
    );
}

// CompletionDetector attributes AI edits using DETERMINISTIC command signals,
// observed via vscode.commands.onDidExecuteCommand:
//
//   - An inline-suggest commit command (Tab/word/line accept) → the next
//     document change is a `completion`.
//   - A chat-apply command ("Apply in Editor"/"Insert") → the next document
//     change is `chat`.
//   - Anything else (plain typing, snippets, LSP edits, paste) is NOT recorded
//     — it is the human author's work.
//
// This replaces the old size/shape heuristic, which mislabeled large non-AI
// inserts as completions and could not tell a chat apply from a Tab accept.
export class CompletionDetector implements vscode.Disposable {
    private subs: vscode.Disposable[] = [];
    private repoRootCache = new Map<string, string | null>();
    private clipboardCache = '';

    // Per-document text snapshot taken BEFORE the current change, keyed by
    // uri.toString(). Used to diff old↔new and record only the lines that
    // actually changed — so a chat "apply" that rewrites a 124-line file but
    // only alters 4 lines is attributed to those 4 lines, not the whole file.
    private docShadows = new Map<string, string>();

    // Pending-signal state: set when we observe the relevant command; consumed
    // (reset) on the next document-change event. Exactly one of these drives the
    // gen_type of the next recorded edit.
    private inlineSuggestPending = false;
    private inlineSuggestTimer: ReturnType<typeof setTimeout> | null = null;
    private chatApplyPending = false;
    private chatApplyTimer: ReturnType<typeof setTimeout> | null = null;

    // Wall-clock ms of the last chat-apply command. Used to attribute new files
    // created during a multi-file chat apply (VS Code creates them on disk
    // without firing onDidChangeTextDocument, so we handle them in onDidCreateFiles).
    private chatApplyCommandMs = 0;
    // How long after a chat-apply command we'll treat file creations as AI work.
    private static readonly CHAT_CREATE_WINDOW_MS = 10000;

    // Wall-clock ms of the last AI edit we recorded. A file deletion that lands
    // shortly after AI activity (or while a chat-apply is pending) is treated as
    // an AI deletion. See onWillDeleteFiles / onDidDeleteFiles below.
    private lastAiActivityMs = 0;
    // Window after recent AI activity within which a file deletion is credited
    // to the AI. Generous enough to cover an agent that edits then deletes.
    private static readonly AI_DELETE_WINDOW_MS = 20000;
    // Pre-delete content snapshots, keyed by uri.toString(), captured in
    // onWillDeleteFiles (the file is gone by onDidDeleteFiles).
    private pendingDeleteContent = new Map<string, string>();

    constructor(
        private daemon: DaemonClient,
        private cliData?: CliDataService,
    ) { }

    private debugEnabled(): boolean {
        return vscode.workspace.getConfiguration('blamely').get<boolean>('debugDetection', false);
    }

    /**
     * Called by the `blamely.signalInlineAccept` command, which is bound to Tab
     * via a keybinding (package.json) so it fires BEFORE `editor.action.inlineSuggest.commit`.
     * This is the primary signal for inline completion acceptance — it is exact,
     * zero-heuristic, and works regardless of whether `onDidExecuteCommand` fires
     * for keyboard-triggered commands (which it often does not in VS Code).
     */
    signalInlineAccept(): void {
        this.inlineSuggestPending = true;
        if (this.inlineSuggestTimer) clearTimeout(this.inlineSuggestTimer);
        this.inlineSuggestTimer = setTimeout(() => {
            this.inlineSuggestPending = false;
            this.inlineSuggestTimer = null;
        }, 500);
        if (this.debugEnabled()) Logger.info('signalInlineAccept: inlineSuggestPending=true');
    }

    register(): void {
        // Secondary path: onDidExecuteCommand catches command-palette invocations
        // and any editor that routes Tab through the VS Code command service.
        // Keyboard-shortcut-triggered commands (the common case) bypass this API
        // and are handled by the keybinding in package.json that calls
        // signalInlineAccept() directly before editor.action.inlineSuggest.commit.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onExecCmd: ((listener: (e: { command: string }) => void) => vscode.Disposable) | undefined =
            (vscode.commands as any).onDidExecuteCommand;
        if (typeof onExecCmd === 'function') {
            this.subs.push(
                onExecCmd((e) => {
                    if (this.debugEnabled()) Logger.info(`cmd: ${e.command}`);
                    if (INLINE_SUGGEST_COMMIT_CMDS.has(e.command)) {
                        this.signalInlineAccept();
                    } else if (isChatApplyCommand(e.command)) {
                        this.chatApplyPending = true;
                        this.chatApplyCommandMs = Date.now();
                        if (this.chatApplyTimer) clearTimeout(this.chatApplyTimer);
                        this.chatApplyTimer = setTimeout(() => {
                            this.chatApplyPending = false;
                            this.chatApplyTimer = null;
                        }, 1500);
                        if (this.debugEnabled()) Logger.info(`chat-apply command matched: ${e.command}`);
                    }
                })
            );
        } else if (this.debugEnabled()) {
            Logger.warn('onDidExecuteCommand unavailable — falling back to keybinding-only detection');
        }
        // Seed shadows for already-open documents so the very first edit can be
        // narrowed, and keep them in sync as documents open/close.
        for (const d of vscode.workspace.textDocuments) {
            if (d.uri.scheme === 'file') this.docShadows.set(d.uri.toString(), d.getText());
        }
        this.subs.push(
            vscode.workspace.onDidOpenTextDocument((d) => {
                if (d.uri.scheme === 'file') this.docShadows.set(d.uri.toString(), d.getText());
            }),
            vscode.workspace.onDidCloseTextDocument((d) => {
                this.docShadows.delete(d.uri.toString());
            })
        );
        this.subs.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                void this.onChange(e);
            })
        );
        // File deletions fire no document-change event, so the daemon never sees
        // an AI agent ("delete login.html") remove a file — the committed deletion
        // then attributes to Human. Snapshot content BEFORE deletion (it's gone by
        // onDidDeleteFiles), then record it as an AI deletion when AI context is
        // active.
        this.subs.push(
            vscode.workspace.onWillDeleteFiles((e) => {
                e.waitUntil(this.snapshotDeletingFiles(e.files));
            }),
            vscode.workspace.onDidDeleteFiles((e) => {
                void this.onFilesDeleted(e.files);
            }),
        );
        // File creations from the chat panel ("add a new file") write directly to
        // disk without triggering onDidChangeTextDocument, so pushImmediateBlame is
        // never called and the gutter waits for the chat watcher (600ms+). Handle
        // them here: if a chat-apply command fired recently, read the new file and
        // record all its lines as AI immediately.
        this.subs.push(
            vscode.workspace.onDidCreateFiles((e) => {
                void this.onFilesCreated(e.files);
            }),
        );
        Logger.info(
            `CompletionDetector: registered (host=${vscode.env.appName})`
        );
    }

    dispose(): void {
        if (this.inlineSuggestTimer) {
            clearTimeout(this.inlineSuggestTimer);
            this.inlineSuggestTimer = null;
        }
        if (this.chatApplyTimer) {
            clearTimeout(this.chatApplyTimer);
            this.chatApplyTimer = null;
        }
        for (const s of this.subs) s.dispose();
        this.subs.length = 0;
    }

    private async onChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
        if (
            e.reason === vscode.TextDocumentChangeReason.Undo ||
            e.reason === vscode.TextDocumentChangeReason.Redo
        ) {
            return;
        }
        const doc = e.document;
        if (doc.uri.scheme !== 'file') return;

        // Snapshot old↔new for range narrowing, and keep the shadow current for
        // the NEXT change regardless of whether we record this one (otherwise
        // the baseline drifts and later diffs over-attribute).
        const uriStr = doc.uri.toString();
        const newText = doc.getText();
        const prevText = this.docShadows.get(uriStr);
        this.docShadows.set(uriStr, newText);

        if (e.contentChanges.length === 0) return;

        // Consume the pending command flags. Do this before any early return so
        // a filtered-out event doesn't leave a flag set for a later change.
        const chatApply = this.chatApplyPending;
        if (chatApply) {
            this.chatApplyPending = false;
            if (this.chatApplyTimer) { clearTimeout(this.chatApplyTimer); this.chatApplyTimer = null; }
        }
        const inlineAccept = this.inlineSuggestPending;
        if (inlineAccept) {
            this.inlineSuggestPending = false;
            if (this.inlineSuggestTimer) { clearTimeout(this.inlineSuggestTimer); this.inlineSuggestTimer = null; }
        }

        // STRICT RULE: only a command signal makes an edit AI. Chat-apply wins
        // over inline (an apply can momentarily look like both). No signal →
        // this is the human author typing/pasting/refactoring → record nothing.
        let genType = chatApply ? 'chat' : inlineAccept ? 'completion' : '';
        // Exception: on a host whose ONLY assistant is built in and applies via
        // applyEdit with no command (Antigravity → Gemini), there is no command to
        // key off AND no human-vs-other-AI ambiguity — so a non-paste, multi-line
        // programmatic range-replace IS that assistant's apply. Treat it as a chat
        // apply so it gets the same robust path Copilot gets from its command
        // (instant AI paint + narrow, exact-position recording), instead of leaving
        // attribution to the daemon's whole-file record that drifts when the user
        // edits afterward. Gated to the single-AI host (below) so it can never
        // mislabel a human edit in VS Code or Cursor.
        const singleAiAgentApply = genType === '' && (await this.isSingleAiAgentApply(e.contentChanges));
        if (singleAiAgentApply) {
            genType = 'chat';
        }
        // Antigravity inline completion (Gemini): applied via applyEdit with no
        // command and as an insertion, so it isn't a multi-line agent apply above
        // nor an inline-suggest command — without this it falls through to Human.
        const singleAiInlineCompletion =
            genType === '' && (await this.isSingleAiInlineCompletion(e.contentChanges));
        if (singleAiInlineCompletion) {
            genType = 'completion';
        }
        if (genType === '') {
            // Copilot/Cursor AGENT mode applies region/full-file patches via
            // applyEdit with NO chat-apply command, so we don't record them here —
            // the daemon's chat watcher does. But to narrow a rewrite down to the
            // genuinely-new lines, the watcher needs the pre-apply file content;
            // without it, a line the human typed between two agent applies is
            // recorded as AI. Stash prevText as that baseline now (it's gone after
            // the next change). Baseline-only: this never attributes, so a false
            // positive is harmless (consume-once, overwritten by the next apply).
            // A clipboard paste is a human action with no AI command. Record it
            // explicitly (tool=copypaste) with the pasted line positions so commit
            // attribution can pin exactly those lines as Human — even when the
            // pasted text is identical to AI-generated content elsewhere, which
            // content-hash matching alone can't disambiguate. If it wasn't a paste,
            // fall through to the agent-apply baseline check.
            const wasPaste = await this.maybeRecordPaste(doc, prevText, e.contentChanges);
            if (!wasPaste) {
                await this.maybeStashAgentApplyBaseline(doc, prevText, e.contentChanges);
            }
            if (this.debugEnabled() && e.contentChanges.some((c) => c.text.trim().length >= MIN_COMPLETION_CHARS)) {
                Logger.info(`human (no AI command): ${path.basename(doc.uri.fsPath)} +${countChar(e.contentChanges.map(c => c.text).join(''), '\n')} lines`);
            }
            return;
        }

        const candidates = e.contentChanges.filter((c) => c.text.length > 0);
        if (candidates.length === 0) return;

        await this.refreshClipboardCache();
        const filtered = candidates.filter((c) => !this.isLikelyPaste(c.text));
        if (filtered.length === 0) return;

        const filePath = doc.uri.fsPath;
        const repoRoot = await this.resolveRepoRoot(filePath);
        if (!repoRoot) return;

        // Pause during cherry-pick/merge/revert/rebase: edits applied by replaying
        // history aren't fresh authorship. content_sha re-attributes them after.
        if (await inProgressGitOp(repoRoot)) return;

        const relPath = path
            .relative(repoRoot, filePath)
            .replace(/\\/g, '/');
        if (!relPath || relPath.startsWith('..')) return;

        const branch = await getBranchName(repoRoot);
        const repoId = (await getRepoId(repoRoot)) ?? repoRoot;

        const confidence = 'high'; // a command proved it; both chat and completion are high-confidence
        const tool = resolveTool();

        // Narrow to the lines that ACTUALLY changed vs the pre-change shadow.
        // This is what prevents a chat "apply" that rewrites a whole file (but
        // only alters a few lines) from marking every line as AI. When we have
        // no shadow yet (first edit in a freshly-opened doc), fall back to the
        // raw inserted span from the content changes.
        let bands: Array<{ start: number; end: number }>;
        if (prevText !== undefined) {
            bands = changedLineBands(prevText, newText);
        } else {
            bands = filtered.map((c) => {
                const start = c.range.start.line + 1;
                return { start, end: start + countChar(c.text, '\n') };
            });
        }
        if (bands.length === 0) return; // pure deletion / no added lines

        const totalChars = filtered.reduce((n, c) => n + c.text.length, 0);
        const lineRanges = buildLineRangesWithSha(doc, bands);
        let anySent = false;
        for (const band of bands) {
            const bandLines = lineRanges.filter(r => r.start >= band.start && r.end <= band.end);
            const payload: EditPayload = {
                tool,
                confidence,
                gen_type: genType,
                repo_path: repoId,
                file_path: relPath,
                suggested_lines: band.end - band.start + 1,
                lines: bandLines.length > 0
                    ? bandLines
                    : [{ start: band.start, end: Math.max(band.end, band.start) }],
                raw_meta: JSON.stringify({
                    source: 'vscode_plugin',
                    host: vscode.env.appName,
                    chars: totalChars,
                    gen_type_signal: chatApply
                        ? 'chat_apply_cmd'
                        : singleAiAgentApply
                            ? 'single_ai_agent_apply'
                            : singleAiInlineCompletion
                                ? 'single_ai_inline_completion'
                                : 'inline_suggest_cmd',
                }),
                branch: branch ?? undefined,
            };
            if (this.debugEnabled()) {
                Logger.info(`record: tool=${tool} gen_type=${genType} ${relPath} L${band.start}-${band.end} (${totalChars} chars)`);
            }
            this.cliData?.pushImmediateBlame(relPath, band.start, band.end, tool, genType);
            if (await this.daemon.send(payload)) {
                anySent = true;
            }
        }
        if (anySent) {
            // Mark recent AI authorship so a file deletion that follows (chat/agent
            // "delete this file") can be attributed to the AI rather than the human.
            this.lastAiActivityMs = Date.now();
            // For chat applies: store the pre-chat content in the daemon so the
            // chat watcher (which polls 600ms+ later) can use it as a diff baseline
            // when narrowing which textEditGroup lines are genuinely new. Without
            // this, auto-save or a subsequent completion can overwrite the snapshot
            // before the watcher polls, causing the watcher to claim unchanged
            // (human-typed) lines as AI-authored.
            if (chatApply && prevText !== undefined) {
                await this.daemon.putSnapshot(repoId, relPath, prevText);
            }
            await this.saveDocumentThenRefresh(doc);
        }
    }

    /** True when this change is an AI apply on a host whose ONLY assistant is built
     *  in and applies via applyEdit with no command (Antigravity → Gemini). There,
     *  a multi-line programmatic range-replace that is NOT a clipboard paste is
     *  unambiguously that assistant's apply — no command exists and there is no
     *  human-vs-other-AI ambiguity. Lets onChange record it as a chat apply (the
     *  robust instant-paint + narrow-recording path). Strictly gated to the
     *  single-AI host so it can never mislabel a human edit in VS Code or Cursor,
     *  and excludes pastes (handled as Human) and single-line typing. */
    private async isSingleAiAgentApply(
        changes: readonly vscode.TextDocumentContentChangeEvent[],
    ): Promise<boolean> {
        const app = (vscode.env.appName || '').toLowerCase();
        if (!app.includes('antigravity')) {
            return false;
        }
        if (!changes.some((c) => c.range.end.line > c.range.start.line)) {
            return false;
        }
        await this.refreshClipboardCache();
        return changes.some((c) => c.range.end.line > c.range.start.line && !this.isLikelyPaste(c.text));
    }

    /** True when this change is Antigravity's built-in Gemini accepting an inline
     *  ("implicit") completion. Antigravity applies the suggestion via applyEdit
     *  with NO command, as an insertion — so the inline-suggest command path never
     *  fires, and isSingleAiAgentApply (multi-line range-replace, agent mode)
     *  doesn't match either, leaving the lines to fall through to Human.
     *
     *  On this single-AI host there is no human-vs-other-AI ambiguity, so the
     *  shape disambiguates: an accepted suggestion lands the whole chunk in ONE
     *  document-change event, whereas human typing fires one event per character.
     *  We therefore treat a single non-paste insert of >= MIN_COMPLETION_CHARS as
     *  a Gemini completion. Sub-threshold inserts (typing, auto-closed brackets)
     *  and clipboard pastes (handled as Human) are excluded. Strictly gated to the
     *  Antigravity host so VS Code / Cursor are never affected. */
    private async isSingleAiInlineCompletion(
        changes: readonly vscode.TextDocumentContentChangeEvent[],
    ): Promise<boolean> {
        const app = (vscode.env.appName || '').toLowerCase();
        if (!app.includes('antigravity')) {
            return false;
        }
        if (changes.length !== 1) {
            return false;
        }
        const c = changes[0];
        if (c.text.trim().length < MIN_COMPLETION_CHARS) {
            return false;
        }
        await this.refreshClipboardCache();
        return !this.isLikelyPaste(c.text);
    }

    /** Stash the pre-apply file content so the daemon's chat watcher can narrow an
     *  AGENT-mode patch down to its genuinely-new lines. Agent mode (Copilot
     *  editsAgent / Cursor Composer) applies a region or whole-file rewrite via
     *  applyEdit with no chat-apply command, so onChange treats it as "human" and
     *  records nothing — but the watcher later records the textEditGroup. A
     *  range-REPLACING programmatic edit (end line > start line, not a paste) is
     *  the signature of such a rewrite: the new text re-includes existing lines,
     *  among them anything the human typed since the last apply. Stashing prevText
     *  lets the watcher diff against it and drop those unchanged lines. This feeds
     *  narrowing only — it never attributes — so a false positive is harmless:
     *  the snapshot is consume-once and overwritten by the next apply. A pure
     *  insertion (start == end) needs no baseline: the watcher already records
     *  just the inserted lines, so we skip it (and human typing) here. */
    private async maybeStashAgentApplyBaseline(
        doc: vscode.TextDocument,
        prevText: string | undefined,
        changes: readonly vscode.TextDocumentContentChangeEvent[],
    ): Promise<void> {
        if (prevText === undefined) return;
        if (!changes.some((c) => c.range.end.line > c.range.start.line)) return;
        await this.refreshClipboardCache();
        const isAgentPatch = changes.some(
            (c) => c.range.end.line > c.range.start.line && !this.isLikelyPaste(c.text),
        );
        if (!isAgentPatch) return;
        const fp = doc.uri.fsPath;
        const repoRoot = await this.resolveRepoRoot(fp);
        if (!repoRoot || (await inProgressGitOp(repoRoot))) return;
        const rel = path.relative(repoRoot, fp).replace(/\\/g, '/');
        if (!rel || rel.startsWith('..')) return;
        const repoId = (await getRepoId(repoRoot)) ?? repoRoot;
        await this.daemon.putSnapshot(repoId, rel, prevText);
        // Show the neutral "detecting" gutter icon on the changed lines while the
        // daemon's chat watcher resolves them — instead of defaulting to Human and
        // flipping to AI. Resolves to AI when recorded, or to Human on timeout.
        const bands = changedLineBands(prevText, doc.getText());
        for (const b of bands) this.cliData?.markDetecting(rel, b.start, b.end);
        if (this.debugEnabled()) Logger.info(`agent-apply baseline stashed + detecting: ${rel} (${prevText.length} chars)`);
    }

    /** Record a clipboard paste as an explicit human edit (tool=copypaste) with
     *  the pasted line positions. Commit attribution uses this to pin those exact
     *  lines as Human even when the pasted text duplicates AI-generated content
     *  elsewhere — a case content-hash matching alone gets wrong (it can't tell
     *  the paste from the AI original, so it scatters the Human label onto the
     *  wrong occurrence). Returns true if a paste was recorded. Cheap-gated on a
     *  substantial insert so plain typing never reads the clipboard. */
    private async maybeRecordPaste(
        doc: vscode.TextDocument,
        prevText: string | undefined,
        changes: readonly vscode.TextDocumentContentChangeEvent[],
    ): Promise<boolean> {
        if (prevText === undefined) return false;
        // Typing is one char per event; only a substantial single-event insert
        // can be a paste. This gate keeps the clipboard read off the typing path.
        if (!changes.some((c) => c.text.length >= MIN_COMPLETION_CHARS)) return false;
        await this.refreshClipboardCache();
        if (!changes.some((c) => c.text.length > 0 && this.isLikelyPaste(c.text))) return false;

        const bands = changedLineBands(prevText, doc.getText());
        if (bands.length === 0) return false;
        const lineRanges = buildLineRangesWithSha(doc, bands);
        if (lineRanges.length === 0) return false;

        const fp = doc.uri.fsPath;
        const repoRoot = await this.resolveRepoRoot(fp);
        if (!repoRoot || (await inProgressGitOp(repoRoot))) return false;
        const rel = path.relative(repoRoot, fp).replace(/\\/g, '/');
        if (!rel || rel.startsWith('..')) return false;
        const branch = await getBranchName(repoRoot);
        const repoId = (await getRepoId(repoRoot)) ?? repoRoot;

        const payload: EditPayload = {
            tool: 'copypaste',
            confidence: 'high',
            gen_type: 'human',
            repo_path: repoId,
            file_path: rel,
            lines: lineRanges,
            raw_meta: JSON.stringify({
                source: 'vscode_plugin',
                host: vscode.env.appName,
                signal: 'clipboard_paste',
            }),
            branch: branch ?? undefined,
        };
        if (this.debugEnabled()) {
            Logger.info(`record paste (human): ${rel} ${bands.map((b) => `L${b.start}-${b.end}`).join(',')}`);
        }
        await this.daemon.send(payload);
        return true;
    }

    /** onDidCreateFiles: when a chat-apply command created a new file directly on
     *  disk (no document-change event fires), record all its lines as AI so the
     *  gutter updates immediately rather than waiting for the watcher. */
    private async onFilesCreated(files: readonly vscode.Uri[]): Promise<void> {
        const inChatWindow =
            this.chatApplyPending ||
            (Date.now() - this.chatApplyCommandMs < CompletionDetector.CHAT_CREATE_WINDOW_MS);
        if (!inChatWindow) { return; }

        let recorded = false;
        for (const uri of files) {
            if (uri.scheme !== 'file') { continue; }
            const repoRoot = await this.resolveRepoRoot(uri.fsPath);
            if (!repoRoot) { continue; }
            if (await inProgressGitOp(repoRoot)) { continue; }
            const relPath = path.relative(repoRoot, uri.fsPath).replace(/\\/g, '/');
            if (!relPath || relPath.startsWith('..')) { continue; }

            let content: string;
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                content = Buffer.from(bytes).toString('utf8');
            } catch {
                continue;  // file not readable yet — the watcher will pick it up
            }
            if (!content.trim()) { continue; }

            const lines = content.split(/\r?\n/);
            const branch = await getBranchName(repoRoot);
            const repoId = (await getRepoId(repoRoot)) ?? repoRoot;
            const tool = resolveTool();
            const lineRanges: EditRange[] = [];
            const removed: RemovedLineHash[] = [];
            for (let i = 0; i < lines.length; i++) {
                const text = lines[i].replace(/\r$/, '');
                if (text.trim().length === 0) { continue; }
                lineRanges.push({ start: i + 1, end: i + 1, content_sha: lineSha(text), content_sha_norm: lineShaNorm(text) });
            }
            if (lineRanges.length === 0) { continue; }

            const payload: EditPayload = {
                tool,
                confidence: 'high',
                gen_type: 'chat',
                repo_path: repoId,
                file_path: relPath,
                suggested_lines: lines.length,
                lines: lineRanges,
                removed_lines: removed,
                raw_meta: JSON.stringify({
                    source: 'vscode_plugin',
                    host: vscode.env.appName,
                    signal: 'chat_create_file',
                }),
                branch: branch ?? undefined,
            };
            if (this.debugEnabled()) {
                Logger.info(`record create: tool=${tool} ${relPath} (${lineRanges.length} lines)`);
            }
            this.cliData?.pushImmediateBlame(relPath, 1, lines.length, tool, 'chat');
            if (await this.daemon.send(payload)) {
                recorded = true;
            }
        }
        if (recorded) {
            this.lastAiActivityMs = Date.now();
            await this.cliData?.refresh();
        }
    }

    /** onWillDeleteFiles: capture each file's content before it's removed. */
    private async snapshotDeletingFiles(files: readonly vscode.Uri[]): Promise<void> {
        for (const uri of files) {
            if (uri.scheme !== 'file') { continue; }
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                this.pendingDeleteContent.set(uri.toString(), Buffer.from(bytes).toString('utf8'));
            } catch {
                // a directory or unreadable entry — we only attribute file deletions
            }
        }
    }

    /** onDidDeleteFiles: when the deletion happened in an AI context, record the
     *  removed lines so commit-time attribution credits the AI tool instead of
     *  the human. A plain human delete (no recent AI activity) is left alone. */
    private async onFilesDeleted(files: readonly vscode.Uri[]): Promise<void> {
        const aiContext = this.chatApplyPending ||
            (Date.now() - this.lastAiActivityMs < CompletionDetector.AI_DELETE_WINDOW_MS);
        let recorded = false;
        for (const uri of files) {
            const key = uri.toString();
            const content = this.pendingDeleteContent.get(key);
            this.pendingDeleteContent.delete(key);
            if (content === undefined || uri.scheme !== 'file') { continue; }
            if (!aiContext) { continue; }
            if (await this.recordDeletedFile(uri.fsPath, content)) { recorded = true; }
        }
        if (recorded) {
            this.lastAiActivityMs = Date.now();
        }
        if (files.length > 0) {
            await this.cliData?.refresh();
        }
    }

    private async recordDeletedFile(filePath: string, content: string): Promise<boolean> {
        const repoRoot = await this.resolveRepoRoot(filePath);
        if (!repoRoot) { return false; }
        if (await inProgressGitOp(repoRoot)) { return false; }
        const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
        if (!relPath || relPath.startsWith('..')) { return false; }

        // Hash each non-blank line exactly as the daemon hashes a diff "-" line
        // (sha256 of the line sans trailing \r; blank lines never hashed).
        const removed: RemovedLineHash[] = [];
        for (const raw of content.split('\n')) {
            const text = raw.replace(/\r$/, '');
            if (text.trim().length === 0) { continue; }
            removed.push({ content_sha: lineSha(text), content_sha_norm: lineShaNorm(text) });
        }
        if (removed.length === 0) { return false; }

        const branch = await getBranchName(repoRoot);
        const repoId = (await getRepoId(repoRoot)) ?? repoRoot;
        const tool = resolveTool();
        const payload: EditPayload = {
            tool,
            confidence: 'high',
            gen_type: 'chat',
            repo_path: repoId,
            file_path: relPath,
            suggested_lines: removed.length,
            lines: [],
            removed_lines: removed,
            raw_meta: JSON.stringify({
                source: 'vscode_plugin',
                host: vscode.env.appName,
                signal: this.chatApplyPending ? 'chat_apply_delete' : 'ai_window_delete',
            }),
            branch: branch ?? undefined,
        };
        if (this.debugEnabled()) {
            Logger.info(`record delete: tool=${tool} ${relPath} (${removed.length} lines)`);
        }
        return this.daemon.send(payload);
    }

    private async saveDocumentThenRefresh(doc: vscode.TextDocument): Promise<void> {
        if (doc.isDirty) {
            try {
                await doc.save();
            } catch {
                // read-only — still refresh
            }
        }
        await this.cliData?.refresh();
    }

    private async resolveRepoRoot(file: string): Promise<string | null> {
        const dir = path.dirname(file);
        if (this.repoRootCache.has(dir)) {
            return this.repoRootCache.get(dir) ?? null;
        }
        const root = await getRepoRoot(file);
        this.repoRootCache.set(dir, root);
        return root;
    }

    private async refreshClipboardCache(): Promise<void> {
        // Always read fresh — this is only called when there is already a
        // completion-like candidate, so frequency is naturally low. Caching
        // with a TTL causes paste-after-copy to be mis-attributed as a
        // completion when the user copies and pastes within the TTL window.
        try {
            this.clipboardCache = await vscode.env.clipboard.readText();
        } catch {
            // clipboard read can fail when the host lacks focus
        }
    }

    private isLikelyPaste(text: string): boolean {
        const clip = this.clipboardCache;
        if (!clip) return false;
        // Exact match is the common case.
        if (clip === text) return true;
        // Allow trailing-whitespace differences: copy often captures a trailing
        // newline that the editor strips on paste (or vice versa).
        const t = text.trimEnd();
        const c = clip.trimEnd();
        if (t.length > 0 && t === c) return true;
        // Pasted text is a prefix of the clipboard (user pasted part of a copy).
        if (t.length >= MIN_COMPLETION_CHARS && c.startsWith(t)) return true;
        // Clipboard is a prefix of the pasted text (clipboard lacked trailing newline).
        if (c.length >= MIN_COMPLETION_CHARS && t.startsWith(c)) return true;
        // Pasted text appears anywhere inside the clipboard (e.g., user pasted a
        // middle section of a multi-line copy).
        if (t.length >= MIN_COMPLETION_CHARS && c.includes(t)) return true;
        return false;
    }
}

// changedLineBands returns the 1-based new-side line ranges that differ between
// oldText and newText, by stripping the common leading and trailing lines. For
// a single contiguous edit (the typical completion or chat apply) this yields
// exactly the changed/added lines; identical head and tail are excluded so an
// apply that rewrites a file but only alters a few lines attributes just those.
// Returns [] when nothing was added (e.g. a pure deletion).
function changedLineBands(
    oldText: string,
    newText: string
): Array<{ start: number; end: number }> {
    if (oldText === newText) return [];
    const o = oldText.split('\n');
    const n = newText.split('\n');
    let p = 0;
    while (p < o.length && p < n.length && o[p] === n[p]) p++;
    let s = 0;
    while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
    const startIdx = p; // 0-based, first changed new-side line
    const endIdx = n.length - 1 - s; // 0-based, last changed new-side line
    if (endIdx < startIdx) return []; // no added lines (pure deletion)
    return [{ start: startIdx + 1, end: endIdx + 1 }];
}

function lineSha(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Whitespace-normalized hash (collapse runs to single spaces), matching the
// daemon's content_sha_norm so a deleted line still matches after a reflow.
function lineShaNorm(text: string): string {
    const norm = text.trim().split(/\s+/).join(' ');
    return norm === '' ? '' : lineSha(norm);
}

/** Per-line content_sha so attribution survives line shifts after save/reopen. */
function buildLineRangesWithSha(
    doc: vscode.TextDocument,
    bands: Array<{ start: number; end: number }>,
): EditRange[] {
    const out: EditRange[] = [];
    for (const band of bands) {
        for (let ln = band.start; ln <= band.end; ln++) {
            const line = doc.lineAt(ln - 1);
            const text = line.text.replace(/\r$/, '');
            if (text.trim().length === 0) continue;
            // Record BOTH the exact hash and the whitespace-normalized hash, so an
            // AI line still attributes to AI after the editor reformats it (reindent
            // / reflow changes content_sha but not content_sha_norm).
            out.push({ start: ln, end: ln, content_sha: lineSha(text), content_sha_norm: lineShaNorm(text) });
        }
    }
    return out;
}

function countChar(s: string, ch: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ch) n++;
    }
    return n;
}

// resolveTool maps the host editor / installed AI extension onto the store's
// fixed Tool taxonomy. Copilot and Cursor are independent tools — neither
// depends on the other.
//
// The `blamely.aiTool` setting is authoritative: in editors that host BOTH a
// Copilot extension and a built-in assistant (notably GitHub Copilot running
// inside Cursor), the document-change event can't reveal which one produced an
// edit, so the user pins it. When the setting is "auto" we infer from the host:
// Cursor app → cursor; otherwise the GitHub Copilot extension → copilot.
function resolveTool(): string {
    const configured = vscode.workspace
        .getConfiguration('blamely')
        .get<string>('aiTool', 'auto');
    if (configured === 'copilot' || configured === 'cursor' || configured === 'gemini') {
        return configured;
    }
    // Auto-detect. The GitHub Copilot extension being *active* is the strongest
    // signal — if Copilot is running, the user is using Copilot, even inside the
    // Cursor app. This must be checked BEFORE the app-name heuristic, otherwise
    // Copilot-in-Cursor is always mislabelled as cursor.
    const copilotExt =
        vscode.extensions.getExtension('GitHub.copilot-chat') ??
        vscode.extensions.getExtension('GitHub.copilot');
    if (copilotExt?.isActive) return 'copilot';

    // No active Copilot: fall back to the host editor. Antigravity IDE's built-in
    // assistant is Gemini; the Cursor app → cursor; otherwise an installed Copilot
    // → copilot; else cursor.
    const appName = (vscode.env.appName || '').toLowerCase();
    if (appName.includes('antigravity')) return 'gemini';
    if (appName.includes('cursor')) return 'cursor';
    if (copilotExt) return 'copilot';
    return 'cursor';
}

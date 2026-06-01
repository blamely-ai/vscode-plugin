import * as path from 'path';
import * as vscode from 'vscode';
import { getRepoRoot } from '../git/GitUtils';
import * as Logger from '../utils/Logger';
import { DaemonClient, EditPayload } from './DaemonClient';

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

    constructor(private daemon: DaemonClient) { }

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
        const genType = chatApply ? 'chat' : inlineAccept ? 'completion' : '';
        if (genType === '') {
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
        const relPath = path
            .relative(repoRoot, filePath)
            .replace(/\\/g, '/');
        if (!relPath || relPath.startsWith('..')) return;

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
        for (const band of bands) {
            const payload: EditPayload = {
                tool,
                confidence,
                gen_type: genType,
                repo_path: repoRoot,
                file_path: relPath,
                suggested_lines: band.end - band.start + 1,
                lines: [{ start: band.start, end: Math.max(band.end, band.start) }],
                raw_meta: JSON.stringify({
                    source: 'vscode_plugin',
                    host: vscode.env.appName,
                    chars: totalChars,
                    gen_type_signal: chatApply ? 'chat_apply_cmd' : 'inline_suggest_cmd',
                }),
            };
            if (this.debugEnabled()) {
                Logger.info(`record: tool=${tool} gen_type=${genType} ${relPath} L${band.start}-${band.end} (${totalChars} chars)`);
            }
            await this.daemon.send(payload);
        }
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
    if (configured === 'copilot' || configured === 'cursor') {
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

    // No active Copilot: fall back to the host editor. Cursor app → cursor;
    // otherwise an installed-but-not-yet-active Copilot → copilot; else cursor.
    const appName = (vscode.env.appName || '').toLowerCase();
    if (appName.includes('cursor')) return 'cursor';
    if (copilotExt) return 'copilot';
    return 'cursor';
}

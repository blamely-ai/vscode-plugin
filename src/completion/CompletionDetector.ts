import * as path from 'path';
import * as vscode from 'vscode';
import { getRepoRoot } from '../git/GitUtils';
import * as Logger from '../utils/Logger';
import { DaemonClient, EditPayload } from './DaemonClient';

// Inserts shorter than this and without a newline are treated as plain
// keystrokes on the heuristic (medium-confidence) path only. The
// high-confidence path (inlineSuggest.commit command observed) accepts
// any non-empty insert regardless of length.
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

// CompletionDetector observes two complementary signals:
//
// HIGH-CONFIDENCE path (new):
//   Listen to vscode.commands.onDidExecuteCommand. The command
//   `editor.action.inlineSuggest.commit` fires the instant any inline
//   suggestion is accepted — Tab key, word-accept, or line-accept — for every
//   completion provider (Copilot, Cursor Tab, JetBrains AI, Codeium, etc.).
//   It does NOT fire for snippets, LSP refactors, or pastes. When this command
//   fires we set `inlineSuggestPending = true` and the very next
//   onDidChangeTextDocument event is treated as confidence='high'.
//
// MEDIUM-CONFIDENCE fallback (preserved):
//   For completions whose provider does not route through
//   editor.action.inlineSuggest.commit (rare; some experimental providers
//   apply text directly), we fall back to the heuristic: single content-
//   change with either a newline or ≥MIN_COMPLETION_CHARS characters, not
//   from undo/redo, not a clipboard paste. These get confidence='medium'.
export class CompletionDetector implements vscode.Disposable {
    private subs: vscode.Disposable[] = [];
    private repoRootCache = new Map<string, string | null>();
    private clipboardCache = '';

    // High-confidence state: set true when we observe an inlineSuggest commit
    // command; consumed (reset) on the next document-change event.
    private inlineSuggestPending = false;
    private inlineSuggestTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private daemon: DaemonClient) { }

    register(): void {
        // High-confidence path: intercept the exact VS Code command that fires
        // when any inline completion is accepted. This is zero-heuristic —
        // the command is the canonical accept signal for every provider.
        //
        // onDidExecuteCommand is absent from older @types/vscode and missing
        // in some VS Code forks (older Cursor builds, web variants). Access via
        // `as any` to compile, and guard at runtime so the extension activates
        // and falls back to medium-confidence mode instead of crashing.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onExecCmd: ((listener: (e: { command: string }) => void) => vscode.Disposable) | undefined =
            (vscode.commands as any).onDidExecuteCommand;
        if (typeof onExecCmd === 'function') {
            this.subs.push(
                onExecCmd((e) => {
                    if (INLINE_SUGGEST_COMMIT_CMDS.has(e.command)) {
                        this.inlineSuggestPending = true;
                        if (this.inlineSuggestTimer) clearTimeout(this.inlineSuggestTimer);
                        // Safety reset: if the document change doesn't arrive within
                        // 300 ms (e.g. the accepted suggestion was empty/whitespace),
                        // clear the flag so it doesn't accidentally upgrade a later
                        // unrelated change.
                        this.inlineSuggestTimer = setTimeout(() => {
                            this.inlineSuggestPending = false;
                            this.inlineSuggestTimer = null;
                        }, 300);
                    }
                })
            );
        }
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
        if (e.contentChanges.length === 0) return;

        // Consume the high-confidence flag. Do this before any early return so
        // a filtered-out event doesn't leave the flag set for a later change.
        const highConf = this.inlineSuggestPending;
        if (highConf) {
            this.inlineSuggestPending = false;
            if (this.inlineSuggestTimer) {
                clearTimeout(this.inlineSuggestTimer);
                this.inlineSuggestTimer = null;
            }
        }

        // High-confidence: accept any non-empty insert — the command already
        // proved this is a completion accept, not a snippet or LSP action.
        // Medium-confidence: apply the existing size/newline heuristic.
        const candidates = highConf
            ? e.contentChanges.filter((c) => c.text.length > 0)
            : e.contentChanges.filter((c) => looksLikeCompletion(c));

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

        const confidence = highConf ? 'high' : 'medium';
        const tool = resolveTool();
        for (const change of filtered) {
            const startLine = change.range.start.line + 1; // VS Code is 0-based
            const newlineCount = countChar(change.text, '\n');
            const endLine = startLine + newlineCount;
            // Distinguish a chat/agent-panel apply from an inline Tab accept:
            //   - The high-confidence path means editor.action.inlineSuggest.commit
            //     fired — i.e. the user accepted ghost text → it's a completion.
            //   - Otherwise a multi-line bulk insert (not a paste, not undo) is
            //     overwhelmingly a chat / Composer "apply in editor" action, which
            //     should be gen_type=chat, not completion. A single-line non-inline
            //     insert is ambiguous, so we leave it as completion.
            const genType = !highConf && newlineCount >= 1 ? 'chat' : 'completion';
            const payload: EditPayload = {
                tool,
                confidence,
                gen_type: genType,
                repo_path: repoRoot,
                file_path: relPath,
                suggested_lines: newlineCount + 1,
                lines: [{ start: startLine, end: Math.max(endLine, startLine) }],
                raw_meta: JSON.stringify({
                    source: 'vscode_plugin',
                    host: vscode.env.appName,
                    chars: change.text.length,
                    high_conf: highConf,
                }),
            };
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

function looksLikeCompletion(
    c: vscode.TextDocumentContentChangeEvent
): boolean {
    if (c.text.length === 0) return false;
    // Require substantial non-whitespace content. A bare newline (`\n`) or
    // auto-indent (`\n    `) is just the user pressing Enter — it must NOT be
    // treated as a completion. The previous check `c.text.includes('\n')`
    // caused every Enter keystroke to be mis-attributed as a Cursor Tab
    // completion on the medium-confidence path.
    const stripped = c.text.trim();
    return stripped.length >= MIN_COMPLETION_CHARS;
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
    const appName = (vscode.env.appName || '').toLowerCase();
    if (appName.includes('cursor')) return 'cursor';
    if (vscode.extensions.getExtension('GitHub.copilot')) return 'copilot';
    return 'cursor';
}

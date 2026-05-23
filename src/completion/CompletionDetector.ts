import * as path from 'path';
import * as vscode from 'vscode';
import { getRepoRoot } from '../git/GitUtils';
import * as Logger from '../utils/Logger';
import { DaemonClient, EditPayload } from './DaemonClient';

// Inserts shorter than this and without a newline are treated as plain
// keystrokes. Eight characters is large enough to skip the common cases
// (typing words, single-character inserts, small auto-import edits) without
// losing short one-line Tab completions (most function calls / signatures
// are longer than 8 chars).
const MIN_COMPLETION_CHARS = 8;

// Clipboard re-read cadence. VS Code's clipboard API is async and may
// require focus, so we cache and refresh lazily — once per second is enough
// to catch a paste-then-edit sequence.
const CLIPBOARD_REFRESH_MS = 1000;

// CompletionDetector observes onDidChangeTextDocument for inserts that
// look like inline-completion acceptances (single content change with
// either a newline or ≥MIN_COMPLETION_CHARS chars, not from undo/redo,
// not a clipboard paste) and posts them to the daemon as
// gen_type=completion events.
//
// The signal it uses (one large contentChange in a single tick) is the
// observable trace of any inline-completion accept — Cursor Tab, Copilot
// Tab, JetBrains AI Tab. fsnotify can't see this because the disk save
// happens later and is debounced; the document-change event fires the
// moment the editor commits the insertion to the buffer.
//
// Known limitations:
//   - Snippet expansion (typing `for<Tab>` triggering a for-loop snippet)
//     produces the same signal pattern and will be attributed to
//     completion. Confidence is set to "medium" to reflect this.
//   - LSP code actions / refactor-rename also insert multi-char text in
//     one tick; not currently filtered.
//   - Multi-cursor edits produce multiple contentChanges in one event;
//     each is evaluated independently.
export class CompletionDetector implements vscode.Disposable {
    private subs: vscode.Disposable[] = [];
    private repoRootCache = new Map<string, string | null>();
    private clipboardCache = '';
    private clipboardLastRead = 0;

    constructor(private daemon: DaemonClient) { }

    register(): void {
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
        if (doc.uri.scheme !== 'file') return; // skip Untitled, output panes, git: scheme
        if (e.contentChanges.length === 0) return;

        // Find any change that LOOKS like a completion before paying the cost
        // of a repo-root lookup or clipboard read.
        const candidates = e.contentChanges.filter((c) =>
            looksLikeCompletion(c)
        );
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

        const tool = resolveTool();
        for (const change of filtered) {
            const startLine = change.range.start.line + 1; // VS Code is 0-based
            const newlineCount = countChar(change.text, '\n');
            const endLine = startLine + newlineCount;
            const payload: EditPayload = {
                tool,
                confidence: 'medium',
                gen_type: 'completion',
                repo_path: repoRoot,
                file_path: relPath,
                suggested_lines: newlineCount + 1,
                lines: [{ start: startLine, end: Math.max(endLine, startLine) }],
                raw_meta: JSON.stringify({
                    source: 'vscode_plugin',
                    host: vscode.env.appName,
                    chars: change.text.length,
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
        const now = Date.now();
        if (now - this.clipboardLastRead < CLIPBOARD_REFRESH_MS) return;
        this.clipboardLastRead = now;
        try {
            this.clipboardCache = await vscode.env.clipboard.readText();
        } catch {
            // clipboard read can fail when the host lacks focus — leave the
            // cache as-is rather than blanking it.
        }
    }

    private isLikelyPaste(text: string): boolean {
        const clip = this.clipboardCache;
        if (!clip) return false;
        // Exact match catches the most common case (Ctrl+V of recent
        // clipboard). startsWith comparisons handle the less common case
        // where the editor inserts the clipboard text plus a trailing
        // newline / whitespace adjustment.
        if (clip === text) return true;
        if (text.length >= 16 && clip.startsWith(text)) return true;
        if (clip.length >= 16 && text.startsWith(clip)) return true;
        return false;
    }
}

function looksLikeCompletion(
    c: vscode.TextDocumentContentChangeEvent
): boolean {
    if (c.text.length === 0) return false; // pure deletion
    if (c.text.includes('\n')) return true;
    return c.text.length >= MIN_COMPLETION_CHARS;
}

function countChar(s: string, ch: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ch) n++;
    }
    return n;
}

// resolveTool picks the store.Tool name to attribute the event to. The
// store taxonomy is fixed (claude/cursor/codex/copilot/human/copypaste),
// so we map the host editor / installed AI extension onto the closest
// match.
function resolveTool(): string {
    const appName = (vscode.env.appName || '').toLowerCase();
    if (appName.includes('cursor')) return 'cursor';
    // Inside non-Cursor VS Code: Copilot is the dominant inline-completion
    // provider. If it's installed, attribute to copilot — even though
    // copilot's own log watcher may also see the event, the daemon stores
    // both records; downstream attribution prefers whichever has higher
    // confidence / a model attached.
    if (vscode.extensions.getExtension('GitHub.copilot')) return 'copilot';
    // Last-resort fallback: tag as cursor since the user's primary goal
    // for this detector is Cursor-style Tab attribution and the store
    // doesn't have a generic "ide_completion" tool.
    return 'cursor';
}

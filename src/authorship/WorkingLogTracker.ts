// VS Code editor live-tracker (docs/attribution-v2-design.md §9). CompletionDetector
// classifies every document change (human typing vs AI completion/apply) and hands
// it here via onEdit, along with the PRE-edit text (so the baseline is exact and no
// checkpoint is needed). We keep a per-document FileTracker in memory and flush the
// working log to disk (the store) debounced + on save/close.
//
// Flag-gated by the `blamely.attributionV2` setting (default off): until the Phase 3
// flip, this only writes working-log files; the note/gutter are unaffected.
//
// Known v1 limitation: cross-reopen continuity isn't loaded (a reopened file seeds
// from its current content); within a session attribution is exact. Loading the
// prior working log on seed is a follow-up.

import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import { getRepoRoot, getBranchName, runGitCommand } from '../git/GitUtils';
import { Author } from './attribute';
import { FileTracker } from './tracker';
import { save } from './store';
import { installedBinaryPath } from '../cli/paths';

export function attributionV2Enabled(): boolean {
    // On by default (matches the package.json default); users can opt out.
    return vscode.workspace.getConfiguration('blamely').get<boolean>('attributionV2', true);
}

interface Ctx {
    repoRoot: string;
    branch: string;
    baseSha: string;
    rel: string;
}

interface DocState {
    ft: FileTracker;
    fsPath: string;
    flushTimer?: ReturnType<typeof setTimeout>;
}

// Shorter than before so an edit is persisted promptly — a Tab-accept immediately
// followed by a commit must not lose the working log before the commit reads it.
const FLUSH_DEBOUNCE_MS = 400;

function lineCount(s: string): number {
    return s.length === 0 ? 0 : s.split('\n').length;
}

export class WorkingLogTracker implements vscode.Disposable {
    private subs: vscode.Disposable[] = [];
    private docs = new Map<string, DocState>();

    register(): void {
        this.subs.push(
            vscode.workspace.onDidSaveTextDocument((d) => void this.flush(d.uri.toString())),
            vscode.workspace.onDidCloseTextDocument((d) => {
                void this.flush(d.uri.toString());
                this.docs.delete(d.uri.toString());
            }),
            // Focus-loss flush (Decision B): the user leaving the IDE usually means a
            // commit/terminal action is next, so persist pending edits NOW — before a
            // commit reads the working log.
            vscode.window.onDidChangeWindowState((e) => {
                if (!e.focused) void this.flushAll();
            }),
        );
    }

    /** Flush every tracked document immediately (e.g. on focus loss, before a commit). */
    private async flushAll(): Promise<void> {
        for (const key of [...this.docs.keys()]) {
            await this.flush(key);
        }
    }

    /** Called when HEAD changes (a commit happened): the just-committed edits are now
     *  history, so drop the in-memory trackers — the next edit re-baselines against the
     *  new committed content rather than accumulating against a stale baseline. */
    onHeadChanged(): void {
        this.docs.clear();
    }

    /**
     * onEdit folds one classified change into the document's working log. prevText
     * is the content BEFORE this change (CompletionDetector's shadow) — used as the
     * baseline when the tracker first sees the document. Cheap (in-memory); the disk
     * write is debounced.
     */
    onEdit(doc: vscode.TextDocument, prevText: string, newText: string, author: Author): void {
        if (!attributionV2Enabled() || doc.uri.scheme !== 'file' || newText === prevText) {
            return;
        }
        const key = doc.uri.toString();
        let st = this.docs.get(key);
        if (!st) {
            st = { ft: new FileTracker(prevText, null), fsPath: doc.uri.fsPath };
            this.docs.set(key, st);
        }
        st.ft.applyEdit(newText, author);
        // An AI edit that REMOVED lines: the working log only describes surviving
        // content, so committed deletions would default to Human. Record the deleted
        // baseline lines (via the CLI, reusing the engine) so they attribute to the
        // tool. Gated to AI edits that shrink the file — a human delete stays the
        // default, and a pure AI add (more lines) never spawns the CLI.
        if (author.author === 'ai' && lineCount(newText) < lineCount(prevText)) {
            this.recordDeletion(doc.uri.fsPath, newText, author);
        }
        if (st.flushTimer) {
            clearTimeout(st.flushTimer);
        }
        st.flushTimer = setTimeout(() => void this.flush(key), FLUSH_DEBOUNCE_MS);
    }

    /** Record AI-deleted baseline lines via `blamely record-deletion` (current buffer
     *  content piped on stdin, since it may be unsaved). Best-effort, fire-and-forget. */
    private recordDeletion(fsPath: string, content: string, author: Author): void {
        const bin = installedBinaryPath();
        if (!bin || !fs.existsSync(bin)) return;
        const args = ['record-deletion', fsPath, '--gen-type', author.gen_type || 'completion'];
        if (author.tool) args.push('--tool', author.tool);
        if (author.model) args.push('--model', author.model);
        try {
            const child = execFile(bin, args, { env: { ...process.env, BLAMELY_ATTRIBUTION_V2: '1' } }, () => {});
            child.stdin?.end(content);
        } catch {
            // best-effort: deletion recording must never disrupt the editor
        }
    }

    private async resolveCtx(fsPath: string): Promise<Ctx | null> {
        const repoRoot = await getRepoRoot(fsPath);
        if (!repoRoot) {
            return null; // not in a work tree → nothing to key the working log on
        }
        const branch = (await getBranchName(repoRoot)) || 'DETACHED';
        const head = (await runGitCommand(repoRoot, 'rev-parse', 'HEAD'))?.trim() || 'INITIAL';
        const rel = path.relative(repoRoot, fsPath).split(path.sep).join('/');
        return { repoRoot, branch, baseSha: head, rel };
    }

    private async flush(key: string): Promise<void> {
        const st = this.docs.get(key);
        if (!st || !st.ft.isDirty()) {
            return;
        }
        if (st.flushTimer) {
            clearTimeout(st.flushTimer);
            st.flushTimer = undefined;
        }
        // Re-resolve against the CURRENT HEAD on every flush: if a commit moved HEAD
        // since the doc was first edited, the working log must be keyed to the new base
        // (the next commit's parent), not the stale base from first edit.
        const ctx = await this.resolveCtx(st.fsPath);
        const wl = st.ft.current();
        if (!ctx || !wl) {
            return;
        }
        try {
            await save(ctx.repoRoot, ctx.branch, ctx.baseSha, ctx.rel, wl, st.ft.content());
            st.ft.markFlushed();
        } catch {
            // best-effort: a working-log write must never disrupt the editor
        }
    }

    dispose(): void {
        for (const s of this.subs) {
            s.dispose();
        }
        this.subs = [];
        this.docs.clear();
    }
}

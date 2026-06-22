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
import { getRepoRoot, getBranchName, runGitCommand } from '../git/GitUtils';
import { Author } from './attribute';
import { FileTracker } from './tracker';
import { save } from './store';

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
    ctx: Promise<Ctx | null>;
    flushTimer?: ReturnType<typeof setTimeout>;
}

const FLUSH_DEBOUNCE_MS = 1200;

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
        );
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
            st = { ft: new FileTracker(prevText, null), ctx: this.resolveCtx(doc.uri.fsPath) };
            this.docs.set(key, st);
        }
        st.ft.applyEdit(newText, author);
        if (st.flushTimer) {
            clearTimeout(st.flushTimer);
        }
        st.flushTimer = setTimeout(() => void this.flush(key), FLUSH_DEBOUNCE_MS);
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
        const ctx = await st.ctx;
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

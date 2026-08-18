// VS Code editor live-tracker (docs/attribution-v2-design.md §9). CompletionDetector
// classifies every document change (human typing vs AI completion/apply) and hands
// it here via onEdit, along with the PRE-edit text (so the baseline is exact and no
// checkpoint is needed). We keep a per-document FileTracker in memory and flush the
// working log to disk (the store) debounced + on save/close.
//
// Flag-gated by the `blamely.attributionV2` setting (default off): until the Phase 3
// flip, this only writes working-log files; the note/gutter are unaffected.
//
// On first edit of a document the tracker seeds from the on-disk working log (see
// seed()), so attribution authored outside this editor session — an agent Write the
// keystroke tracker never observed — is preserved rather than defaulted to Human.
// Within a session attribution is exact.

import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import { getBranchName, runGitCommand, locateRepo, readHeadState } from '../git/GitUtils';
import { gitOpState } from '../git/GitOpState';
import { Author } from './attribute';
import { FileTracker } from './tracker';
import { save, loadWorkingLog, loadBaseline, baselinePath } from './store';
import { installedBinaryPath } from '../cli/paths';
import * as Logger from '../utils/Logger';

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
    // undefined until the on-disk working log has been loaded (the async seed).
    ft?: FileTracker;
    fsPath: string;
    // Edits observed before the seed completes, replayed onto the seeded tracker
    // in order. Empty once seeded.
    pending: Array<{ next: string; author: Author }>;
    seeding?: Promise<void>;
    flushTimer?: ReturnType<typeof setTimeout>;
}

// Shorter than before so an edit is persisted promptly — a Tab-accept immediately
// followed by a commit must not lose the working log before the commit reads it.
const FLUSH_DEBOUNCE_MS = 400;

// Ceilings for the fire-and-forget `blamely record-deletion` children (see
// recordDeletion) — nothing awaits them, so they need their own bounds.
const RECORD_DELETION_TIMEOUT_MS = 10_000;
const MAX_INFLIGHT_DELETIONS = 4;

function lineCount(s: string): number {
    return s.length === 0 ? 0 : s.split('\n').length;
}

export class WorkingLogTracker implements vscode.Disposable {
    private subs: vscode.Disposable[] = [];
    private docs = new Map<string, DocState>();
    private inFlightDeletions = 0;

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

    /** Flush every tracked document immediately (e.g. on focus loss, before a commit).
     *  With force=true, re-persist even non-dirty trackers — used on a same-SHA branch
     *  switch so each doc's working log exists under the NEW branch's dir. */
    private async flushAll(force = false): Promise<void> {
        for (const key of [...this.docs.keys()]) {
            await this.flush(key, force);
        }
    }

    /** Called when HEAD changes (a commit happened): the just-committed edits are now
     *  history, so drop the in-memory trackers — the next edit re-baselines against the
     *  new committed content rather than accumulating against a stale baseline. */
    onHeadChanged(): void {
        this.docs.clear();
    }

    /** Called on a same-SHA branch switch (`git checkout -b feature`): the in-memory
     *  edits are still uncommitted work, but their on-disk log currently lives only
     *  under the OLD branch's dir. flush() re-resolves ctx per call, so a forced flush
     *  re-writes each doc's log under the new branch/base before a commit there reads
     *  it. Keeps the trackers (unlike onHeadChanged) since nothing was committed. */
    onBranchChanged(): void {
        void this.flushAll(true);
    }

    /** Drop ONE document's in-memory tracker WITHOUT flushing — used when a
     *  replay (git op / stash pop / external reload) rewrote the buffer: the
     *  in-flight state may already be poisoned, so it is discarded and the next
     *  real edit re-seeds from the on-disk working log + baseline. A pending
     *  debounced flush for the doc is disarmed by the delete (flush() no-ops on
     *  a missing key). */
    resetDocument(key: string): void {
        const st = this.docs.get(key);
        if (st?.flushTimer) {
            clearTimeout(st.flushTimer);
        }
        this.docs.delete(key);
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
        // Replayed content is NOT fresh authorship — folding it would poison the
        // working log as Human typing. Two replay signals:
        //   • gitOpState.isActive(): a cherry-pick/rebase/merge/revert is in
        //     progress, or a stash was created/applied within the stash window.
        //   • !doc.isDirty right after a change: typing always leaves the buffer
        //     dirty; a clean buffer means the editor RELOADED it from disk (git
        //     rewrote the file underneath — checkout/stash pop/revert).
        // In both cases: skip the fold AND drop the doc's in-memory tracker, so
        // the next real edit re-seeds from the on-disk working log + baseline
        // (the pre-op truth). Un-flushed edits made during the op window are
        // discarded by design; the CLI's commit-time reconcile recovers anything
        // the editor got wrong here.
        if (gitOpState.isActive() || !doc.isDirty) {
            this.resetDocument(doc.uri.toString());
            return;
        }
        const key = doc.uri.toString();
        let st = this.docs.get(key);
        if (!st) {
            // Seed asynchronously from the on-disk working log so attribution authored
            // OUTSIDE this editor session (an agent Write the keystroke tracker never
            // saw — e.g. Claude Code creating the file) is preserved. Until the seed
            // resolves, queue edits; without this the first in-editor edit rebuilds
            // from null and defaults every untouched AI line to Human, clobbering it.
            st = { fsPath: doc.uri.fsPath, pending: [] };
            this.docs.set(key, st);
            st.seeding = this.seed(key, prevText);
        }
        if (!st.ft) {
            st.pending.push({ next: newText, author });
        } else {
            st.ft.applyEdit(newText, author);
        }
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

    /**
     * seed builds the document's FileTracker from the on-disk working log + baseline
     * (written by the CLI/daemon for edits this editor never saw, e.g. an agent Write),
     * then replays any edits queued while the load was in flight. firstPrev is the
     * editor's pre-edit content, used only when there is no stored baseline to align
     * the prior log against (a brand-new, never-recorded file). Best-effort: on any
     * failure the tracker still seeds from firstPrev so live tracking keeps working.
     */
    private async seed(key: string, firstPrev: string): Promise<void> {
        const st = this.docs.get(key);
        if (!st) {
            return;
        }
        let priorLog = null;
        let baseline = firstPrev;
        try {
            const ctx = await this.resolveCtx(st.fsPath);
            if (ctx) {
                const log = await loadWorkingLog(ctx.repoRoot, ctx.branch, ctx.baseSha, ctx.rel);
                const stored = await loadBaseline(baselinePath(ctx.repoRoot, ctx.branch, ctx.baseSha, ctx.rel));
                // The prior log's line numbers describe the STORED baseline content;
                // only adopt the log when that baseline is present, so the diff aligns.
                if (log && stored !== null) {
                    priorLog = log;
                    baseline = stored;
                }
            }
        } catch {
            // best-effort: fall back to a fresh seed from firstPrev
        }
        // The doc may have been dropped (close/HEAD change) while seeding.
        if (this.docs.get(key) !== st) {
            return;
        }
        st.ft = new FileTracker(baseline, priorLog);
        for (const e of st.pending) {
            st.ft.applyEdit(e.next, e.author);
        }
        st.pending = [];
    }

    /** Record AI-deleted baseline lines via `blamely record-deletion` (current buffer
     *  content piped on stdin, since it may be unsaved). Best-effort, fire-and-forget.
     *
     *  Bounded on both axes, because nothing here awaits the child: without a timeout
     *  one that blocks (SQLite lock, unreachable daemon) lives forever, and without a
     *  cap a burst of AI deletes can spawn unboundedly many at once. */
    private recordDeletion(fsPath: string, content: string, author: Author): void {
        const bin = installedBinaryPath();
        if (!bin || !fs.existsSync(bin)) return;
        if (this.inFlightDeletions >= MAX_INFLIGHT_DELETIONS) {
            Logger.warn('WorkingLogTracker: record-deletion saturated, dropping one deletion record');
            return;
        }
        const args = ['record-deletion', fsPath, '--gen-type', author.gen_type || 'completion'];
        if (author.tool) args.push('--tool', author.tool);
        if (author.model) args.push('--model', author.model);
        try {
            this.inFlightDeletions++;
            const child = execFile(
                bin,
                args,
                {
                    env: { ...process.env },
                    timeout: RECORD_DELETION_TIMEOUT_MS,
                    // SIGTERM leaves a child that's ignoring signals or stopped in the
                    // process table; SIGKILL is what actually reaps it.
                    killSignal: 'SIGKILL',
                },
                () => {
                    this.inFlightDeletions--;
                },
            );
            child.stdin?.end(content);
        } catch {
            this.inFlightDeletions--;
            // best-effort: deletion recording must never disrupt the editor
        }
    }

    /**
     * The working log's key (repo, branch, base commit, relative path).
     *
     * Called on every seed AND every debounced flush — i.e. every ~400ms while the
     * user types, per document. It used to spawn `git rev-parse --show-toplevel`,
     * `git symbolic-ref` and `git rev-parse HEAD`, each through a shell: six
     * processes per flush, purely to re-read values sitting in two small files.
     * Now repoRoot/gitDir come from a cache and branch/HEAD are read directly out
     * of the git dir; git is spawned only if HEAD itself is unreadable.
     */
    private async resolveCtx(fsPath: string): Promise<Ctx | null> {
        const loc = await locateRepo(fsPath);
        if (!loc) {
            return null; // not in a work tree → nothing to key the working log on
        }
        const rel = path.relative(loc.repoRoot, fsPath).split(path.sep).join('/');
        const head = readHeadState(loc.gitDir);
        if (head) {
            // Same defaults as the git path: detached HEAD → DETACHED, unborn → INITIAL.
            return {
                repoRoot: loc.repoRoot,
                branch: head.branch || 'DETACHED',
                baseSha: head.sha || 'INITIAL',
                rel,
            };
        }
        const branch = (await getBranchName(loc.repoRoot)) || 'DETACHED';
        const sha = (await runGitCommand(loc.repoRoot, 'rev-parse', 'HEAD'))?.trim() || 'INITIAL';
        return { repoRoot: loc.repoRoot, branch, baseSha: sha, rel };
    }

    private async flush(key: string, force = false): Promise<void> {
        const st = this.docs.get(key);
        if (!st) {
            return;
        }
        // A flush can fire (debounce/save/focus-loss) before the async seed resolves;
        // wait for it so we never read a half-built tracker or save over the prior log.
        if (st.seeding) {
            await st.seeding;
        }
        // force re-persists a clean tracker under a (possibly new) branch/base dir.
        if (!st.ft || (!force && !st.ft.isDirty())) {
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

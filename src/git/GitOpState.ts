// Cached in-progress git-op state, polled alongside the 3s HEAD poll.
//
// Purpose: the working-log tracker (WorkingLogTracker.onEdit) must not fold
// REPLAYED content — a cherry-pick/rebase/merge/revert rewriting open buffers,
// or a stash apply/pop — into the working log as fresh Human typing. The
// per-call `inProgressGitOp` check spawns git and is too costly per keystroke;
// this class caches the answer:
//   • the five marker files (same set as GitUtils.inProgressGitOp) checked with
//     fs.existsSync against a once-resolved git dir, and
//   • the stash reflog's mtime — a stash apply/pop leaves NO marker, but it
//     always touches .git/logs/refs/stash, so an mtime change opens a short
//     "stash window" during which buffer rewrites are treated as replays.
// isActive() is synchronous and allocation-free — safe on every document change.
import * as fs from 'fs';
import * as path from 'path';
import { runGitCommand } from './GitUtils';

const OP_MARKERS = ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

// How long after a stash-reflog change buffer rewrites still count as replays.
// Long enough to cover the editor reloading the popped files; short enough that
// real typing right after a pop isn't suppressed for long (and the CLI's
// commit-time reconcile recovers anything mis-folded either way).
const STASH_WINDOW_MS = 10_000;

export class GitOpState {
    private gitDir: string | null = null;
    private gitDirResolvedFor: string | null = null;
    private markerActive = false;
    private stashWindowUntilMs = 0;
    private lastStashMtimeMs: number | null = null;
    // True once the stash reflog has been observed at least once — the FIRST
    // poll only records the baseline (a pre-existing stash isn't activity).
    private stashObserved = false;

    /** Refresh the cached state for repoRoot. Called from the HEAD poll (3s)
     *  and on document save — never per keystroke. */
    async poll(repoRoot: string): Promise<void> {
        if (!this.gitDir || this.gitDirResolvedFor !== repoRoot) {
            const out = await runGitCommand(repoRoot, 'rev-parse', '--path-format=absolute', '--git-dir');
            this.gitDir = out?.trim() || null;
            this.gitDirResolvedFor = repoRoot;
            if (!this.gitDir) return;
        }
        const g = this.gitDir;
        this.markerActive = OP_MARKERS.some((m) => fs.existsSync(path.join(g, m)));

        let mtime: number | null = null;
        try {
            mtime = fs.statSync(path.join(g, 'logs', 'refs', 'stash')).mtimeMs;
        } catch {
            // no stash reflog — repo currently has no stash entries
        }
        // Any TRANSITION of the stash reflog is stash activity: touched (stash/
        // apply), created (first stash), or DELETED (popping the last stash
        // removes the reflog file entirely — mtime goes null, not newer).
        const changed = this.stashObserved && (
            (mtime !== null && this.lastStashMtimeMs !== null && mtime !== this.lastStashMtimeMs) ||
            (mtime !== null && this.lastStashMtimeMs === null) ||
            (mtime === null && this.lastStashMtimeMs !== null)
        );
        if (changed) {
            this.stashWindowUntilMs = Date.now() + STASH_WINDOW_MS;
        }
        this.lastStashMtimeMs = mtime;
        this.stashObserved = true;
    }

    /** True while a marker op is in progress or within the stash window. */
    isActive(): boolean {
        return this.markerActive || Date.now() < this.stashWindowUntilMs;
    }
}

/** Shared instance — the head poll feeds it; the tracker consults it. */
export const gitOpState = new GitOpState();

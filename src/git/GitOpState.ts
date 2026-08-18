// Cached in-progress git-op state, refreshed alongside the HEAD check.
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

/** Per-repository slice of the cached state. A workspace can hold several repos
 *  (a multi-root workspace, or one folder opened above sibling clones), and a
 *  rebase in ONE of them replays buffers just the same — so each is tracked
 *  separately instead of the previous single "current repo". */
interface RepoOpState {
    gitDir: string | null;
    markerActive: boolean;
    stashWindowUntilMs: number;
    lastStashMtimeMs: number | null;
    // True once the stash reflog has been observed at least once — the FIRST
    // poll only records the baseline (a pre-existing stash isn't activity).
    stashObserved: boolean;
}

export class GitOpState {
    private readonly repos = new Map<string, RepoOpState>();

    /** Refresh the cached state for repoRoot. Driven by GitDirWatcher (so a stash
     *  apply/pop opens the window as it happens rather than up to 3s later) and by
     *  document save — never per keystroke. Pass `knownGitDir` when the caller has
     *  already resolved it to skip the one-time `rev-parse` spawn. */
    async poll(repoRoot: string, knownGitDir?: string): Promise<void> {
        let st = this.repos.get(repoRoot);
        if (!st) {
            st = {
                gitDir: null, markerActive: false, stashWindowUntilMs: 0,
                lastStashMtimeMs: null, stashObserved: false,
            };
            this.repos.set(repoRoot, st);
        }
        if (!st.gitDir) {
            const out = knownGitDir ?? (await runGitCommand(repoRoot, 'rev-parse', '--path-format=absolute', '--git-dir'));
            st.gitDir = out?.trim() || null;
            if (!st.gitDir) return;
        }
        const g = st.gitDir;
        st.markerActive = OP_MARKERS.some((m) => fs.existsSync(path.join(g, m)));

        let mtime: number | null = null;
        try {
            mtime = fs.statSync(path.join(g, 'logs', 'refs', 'stash')).mtimeMs;
        } catch {
            // no stash reflog — repo currently has no stash entries
        }
        // Any TRANSITION of the stash reflog is stash activity: touched (stash/
        // apply), created (first stash), or DELETED (popping the last stash
        // removes the reflog file entirely — mtime goes null, not newer).
        const changed = st.stashObserved && (
            (mtime !== null && st.lastStashMtimeMs !== null && mtime !== st.lastStashMtimeMs) ||
            (mtime !== null && st.lastStashMtimeMs === null) ||
            (mtime === null && st.lastStashMtimeMs !== null)
        );
        if (changed) {
            st.stashWindowUntilMs = Date.now() + STASH_WINDOW_MS;
        }
        st.lastStashMtimeMs = mtime;
        st.stashObserved = true;
    }

    /** True while a marker op is in progress, or within the stash window, in ANY
     *  polled repo — the tracker suppresses per workspace, not per repo. */
    isActive(): boolean {
        const now = Date.now();
        for (const st of this.repos.values()) {
            if (st.markerActive || now < st.stashWindowUntilMs) return true;
        }
        return false;
    }
}

/** Shared instance — the head poll feeds it; the tracker consults it. */
export const gitOpState = new GitOpState();

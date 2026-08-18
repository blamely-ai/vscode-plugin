// Event-driven replacement for the 3s HEAD poll.
//
// Every git operation Blamely cares about writes into the git dir before it is
// observable anywhere else, so watching that directory is strictly more current
// than polling it — and costs nothing while the user isn't running git:
//
//   commit / checkout / reset / merge / pull → <git>/HEAD, <git>/logs/HEAD
//   stash push / apply / pop                 → <git>/logs/refs/stash
//   cherry-pick / rebase / revert            → marker files directly in <git>
//
// Watching three directories non-recursively covers all of it: fs.watch's
// recursive mode isn't available on Linux in the Node versions VS Code ships, and
// the reflog under <git>/logs makes a recursive refs/ watch unnecessary anyway —
// git appends to logs/HEAD on every HEAD move, whatever the ref name.
import * as fs from 'fs';
import * as path from 'path';

/** Watched relative to the git dir; '' is the git dir itself. */
const WATCH_DIRS = ['', 'logs', path.join('logs', 'refs')];

// A single commit touches several files in the git dir. Coalesce the burst into
// one callback, and let the LAST write win so we never read a half-written ref.
const DEBOUNCE_MS = 120;

// Filesystems where fs.watch silently never fires (network shares, some container
// bind mounts) would otherwise leave the extension permanently stale. This is a
// backstop, not the mechanism — 20x rarer than the 3s poll it replaces, and each
// tick is now a couple of small file reads instead of three shelled-out git runs.
const SAFETY_NET_MS = 60_000;

// Files git rewrites constantly without moving HEAD. `git status` alone (which
// VS Code's own git extension runs) rewrites the index whenever it refreshes stat
// info, so reacting to these would mean firing during ordinary editing.
const IGNORED = new Set(['index', 'COMMIT_EDITMSG', 'FETCH_HEAD']);

function isRelevant(filename: string | null): boolean {
    // Some platforms report no filename; assume relevant rather than miss an event.
    if (!filename) return true;
    const base = path.basename(filename);
    return !IGNORED.has(base) && !base.endsWith('.lock');
}

/**
 * Watches a repo's git dir and invokes `onChange` (debounced) whenever something
 * that can move HEAD, switch branches, or start/finish a git op is written.
 */
export class GitDirWatcher {
    private readonly watchers = new Map<string, fs.FSWatcher>();
    private gitDir: string | null = null;
    private debounce: NodeJS.Timeout | undefined;
    private safetyNet: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor(private readonly onChange: () => void) {}

    /** Begin watching `gitDir`. A no-op if already watching it. */
    start(gitDir: string): void {
        if (this.disposed || this.gitDir === gitDir) return;
        this.closeWatchers();
        this.gitDir = gitDir;
        this.arm();
        if (!this.safetyNet) {
            this.safetyNet = setInterval(() => this.onChange(), SAFETY_NET_MS);
        }
    }

    /**
     * Watch every target directory that exists and isn't watched yet. Re-run after
     * each event because git creates some of them lazily — `<git>/logs` only
     * appears with the first reflog entry, and the watch on the parent is what
     * tells us it just did.
     */
    private arm(): void {
        const g = this.gitDir;
        if (!g || this.disposed) return;
        for (const rel of WATCH_DIRS) {
            const dir = rel ? path.join(g, rel) : g;
            if (this.watchers.has(dir)) continue;
            try {
                const w = fs.watch(dir, (_event, filename) => {
                    if (isRelevant(filename)) this.schedule();
                });
                // A watched dir can be deleted (`git stash pop` removing the last
                // stash takes logs/refs with it on some layouts). Drop the dead
                // watcher; the next arm() re-adds it once git recreates the dir.
                w.on('error', () => {
                    w.close();
                    this.watchers.delete(dir);
                });
                this.watchers.set(dir, w);
            } catch {
                // Doesn't exist yet — the parent's watch will fire on creation.
            }
        }
    }

    private schedule(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
            this.debounce = undefined;
            this.arm();
            this.onChange();
        }, DEBOUNCE_MS);
    }

    private closeWatchers(): void {
        for (const w of this.watchers.values()) {
            try {
                w.close();
            } catch {
                // already closed
            }
        }
        this.watchers.clear();
    }

    dispose(): void {
        this.disposed = true;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = undefined;
        if (this.safetyNet) clearInterval(this.safetyNet);
        this.safetyNet = undefined;
        this.closeWatchers();
        this.gitDir = null;
    }
}

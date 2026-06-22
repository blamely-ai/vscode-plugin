// Editor live-tracker core (docs/attribution-v2-design.md §9). The editor sees
// every change; a FileTracker accumulates a file's working log IN MEMORY across
// those changes (human typing, completion accepts, chat/agent applies), so the
// baseline is always the file's last-known content and no pre-edit checkpoint is
// needed. The VS Code layer (next) creates one per open document, calls applyEdit
// on each change with the classified author, and flushes current() to the store
// on save/idle/focus-loss. This module is pure (no vscode/fs) so it is unit-tested
// directly and shares the single attribute() engine.

import { Author, WorkingLog, attribute } from './attribute';

export class FileTracker {
    private log: WorkingLog | null;
    private lastContent: string;
    private dirty = false;

    /**
     * @param baseline the file's content the prior log describes (its current
     *   on-disk/known content at tracker start).
     * @param priorLog the loaded working log for this file, or null.
     */
    constructor(baseline: string, priorLog: WorkingLog | null = null) {
        this.lastContent = baseline;
        this.log = priorLog;
    }

    /**
     * applyEdit folds one observed change into the in-memory log: it diffs the
     * last-known content against newContent and attributes the changed lines to
     * author (unchanged lines keep their prior author — so a human line an AI edit
     * re-emits stays Human). Order matters: feed changes in the order observed.
     */
    applyEdit(newContent: string, author: Author, nowMs = 0): void {
        if (newContent === this.lastContent) {
            return; // no-op change (e.g. a save with no edit)
        }
        this.log = attribute(this.log, this.lastContent, newContent, author, nowMs);
        this.lastContent = newContent;
        this.dirty = true;
    }

    /** The current working log (null if no edit has been applied yet). */
    current(): WorkingLog | null {
        return this.log;
    }

    /** Content the current log describes — the baseline for the next edit. */
    content(): string {
        return this.lastContent;
    }

    /** True if there are un-flushed edits; cleared by markFlushed(). */
    isDirty(): boolean {
        return this.dirty;
    }

    markFlushed(): void {
        this.dirty = false;
    }
}

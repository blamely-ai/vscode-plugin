/** Minimal read-only blame store populated from oobeya-cli SQLite. */
export interface LineBlame {
    lineNumber: number;
    authorType: 'HUMAN' | 'AI';
    timestamp: string;
    aiChars: number;
    humanChars: number;
    changeType: 'ADD' | 'DELETE';
    codingType: 'TYPING' | 'BULK_INSERT';
    // AI-specific (absent / null on human entries)
    provider?: string | null;
    model?: string | null;
    interactionType?: string | null;
    prompt?: string | null;
    ide?: string | null;
    commitSha?: string | null;
    newLineNumber?: number | null;
    oldLineNumber?: number | null;
    /** Tight AI range (completion/chat/cli hook), not a stale whole-file snapshot. */
    boundedAiRange?: boolean;
    /** AI matched by content_sha at current line (survives middle inserts shifting line numbers). */
    contentShaAttributed?: boolean;
}

export interface PendingAiLine {
    tool: string | null;
    model: string | null;
    genType: string | null;
    expiresAtMs: number;
    /** sha256 of the line text at accept time; null when not captured (e.g. blank lines) — keeps the legacy line-number bridge for those. */
    contentSha?: string | null;
}

export interface BlameSummary {
    aiChars: number;
    humanChars: number;
    aiLines: number;
    humanLines: number;
    totalLines: number;
}

function emptySummary(): BlameSummary {
    return { aiChars: 0, humanChars: 0, aiLines: 0, humanLines: 0, totalLines: 0 };
}

/** Fold one file's entries into `acc`: dedup by line (keep the row with the most
 *  chars, ties to the later row) then tally AI vs Human. Shared by getSummary and
 *  getSummaryForFile so the workspace total and the per-file count stay identical. */
function addEntriesToSummary(acc: BlameSummary, entries: LineBlame[]): void {
    const byLine = new Map<number, LineBlame>();
    for (const e of entries) {
        if (e.changeType === 'DELETE') continue;
        const existing = byLine.get(e.lineNumber);
        const eTotal = e.aiChars + e.humanChars;
        const curTotal = existing ? existing.aiChars + existing.humanChars : 0;
        if (!existing || eTotal >= curTotal) {
            byLine.set(e.lineNumber, e);
        }
    }
    for (const e of byLine.values()) {
        acc.aiChars += e.aiChars;
        acc.humanChars += e.humanChars;
        if (e.authorType === 'AI') acc.aiLines++;
        else acc.humanLines++;
    }
}

const PENDING_AI_TTL_MS = 12_000;

// How long a line stays in the neutral "detecting" state before it resolves to
// Human by default. An agent/chat apply is recorded only after the editor writes
// its chat-session log and the daemon's watcher reads it — which can lag the
// on-screen edit by tens of seconds. We keep the loading gutter for that whole
// window so a chat apply resolves to AI instead of flashing Human first; if no AI
// record arrives within it, the line falls back to Human. Each streamed chunk
// re-arms the TTL (markDetecting is called per agent-patch change), so the window
// effectively counts from the LAST streamed change, not the first.
//
// 8s: Copilot Chat is now recorded in real time by the daemon's transcript
// watcher (GitHub.copilot-chat/transcripts), and Cursor/Copilot-CLI via hooks —
// so the record lands within a few seconds. This window only has to bridge that
// short watcher latency (poll + processing), not the old lazy-flush lag.
// Unified with the IntelliJ plugin's BlameMapService.DETECTING_TTL_MS.
export const DETECTING_TTL_MS = 8_000;

export class BlameMap {
    private map = new Map<string, LineBlame[]>();
    /** Skip destructive refresh while an optimistic AI paint is fresher. */
    lastOptimisticPaintMs = 0;
    private pendingAi = new Map<string, Map<number, PendingAiLine>>();
    // Lines awaiting an AI-vs-Human decision (file -> line -> expiry ms). Set when
    // an AI-likely insert (agent apply) lands so the gutter shows a neutral
    // "detecting" icon instead of defaulting to Human and then flipping to AI.
    private detecting = new Map<string, Map<number, number>>();

    getBlame(filePath: string): LineBlame[] {
        const key = filePath.replace(/\\/g, '/');
        const direct = this.map.get(key);
        if (direct?.length) return direct;
        // Workspace folder opened above git root: try suffix match (repo-relative path).
        const slash = key.lastIndexOf('/');
        if (slash >= 0) {
            const suffix = key.slice(slash + 1);
            for (const [k, entries] of this.map) {
                if (k === suffix || k.endsWith('/' + suffix)) return entries;
            }
        }
        return [];
    }

    getTrackedFiles(): string[] {
        return [...this.map.keys()];
    }

    setFileBlame(filePath: string, entries: LineBlame[]): void {
        this.map.set(filePath.replace(/\\/g, '/'), [...entries]);
    }

    /** Atomic swap — no clear-then-repopulate flicker. */
    replaceAll(byFile: Map<string, LineBlame[]>): void {
        this.map.clear();
        for (const [file, entries] of byFile) {
            this.map.set(file.replace(/\\/g, '/'), [...entries]);
        }
    }

    markPendingAiLines(
        filePath: string,
        startLine: number,
        endLine: number,
        tool: string | null,
        model: string | null,
        genType: string | null,
        shas?: Map<number, string>,
    ): void {
        const key = filePath.replace(/\\/g, '/');
        const expiresAt = Date.now() + PENDING_AI_TTL_MS;
        let byLine = this.pendingAi.get(key);
        if (!byLine) {
            byLine = new Map();
            this.pendingAi.set(key, byLine);
        }
        for (let ln = startLine; ln <= endLine; ln++) {
            byLine.set(ln, { tool, model, genType, expiresAtMs: expiresAt, contentSha: shas?.get(ln) ?? null });
        }
    }

    pendingAiPaths(): string[] {
        this.pruneExpiredPending();
        return [...this.pendingAi.keys()];
    }

    pendingAiLinesFor(filePath: string): Map<number, PendingAiLine> {
        this.pruneExpiredPending();
        return new Map(this.pendingAi.get(filePath.replace(/\\/g, '/')) ?? []);
    }

    clearPendingAiLine(filePath: string, line: number): void {
        const key = filePath.replace(/\\/g, '/');
        const byLine = this.pendingAi.get(key);
        if (!byLine) return;
        byLine.delete(line);
        if (byLine.size === 0) this.pendingAi.delete(key);
    }

    /** Clear overlay state after commit when there is no uncommitted work left. */
    clearAllPendingAi(): void {
        this.pendingAi.clear();
        this.detecting.clear();
    }

    private pruneExpiredPending(): void {
        const now = Date.now();
        for (const [path, byLine] of this.pendingAi) {
            for (const [ln, p] of byLine) {
                if (p.expiresAtMs <= now) byLine.delete(ln);
            }
            if (byLine.size === 0) this.pendingAi.delete(path);
        }
    }

    /** Mark [startLine,endLine] as awaiting an AI-vs-Human decision. */
    markDetecting(filePath: string, startLine: number, endLine: number): void {
        const key = filePath.replace(/\\/g, '/');
        const expiresAt = Date.now() + DETECTING_TTL_MS;
        let byLine = this.detecting.get(key);
        if (!byLine) {
            byLine = new Map();
            this.detecting.set(key, byLine);
        }
        for (let ln = startLine; ln <= endLine; ln++) byLine.set(ln, expiresAt);
    }

    /** Non-expired detecting line numbers for a file. Mirrors getBlame's suffix
     *  fallback so a repo-relative mark resolves against a workspace-relative key. */
    detectingLinesFor(filePath: string): Set<number> {
        this.pruneExpiredDetecting();
        const key = filePath.replace(/\\/g, '/');
        const direct = this.detecting.get(key);
        if (direct?.size) return new Set(direct.keys());
        const slash = key.lastIndexOf('/');
        if (slash >= 0) {
            const suffix = key.slice(slash + 1);
            for (const [k, byLine] of this.detecting) {
                if ((k === suffix || k.endsWith('/' + suffix)) && byLine.size) return new Set(byLine.keys());
            }
        }
        return new Set();
    }

    /** Resolve one line out of detecting (e.g. it just resolved to AI). */
    clearDetectingLine(filePath: string, line: number): void {
        const key = filePath.replace(/\\/g, '/');
        const direct = this.detecting.get(key);
        if (direct) {
            direct.delete(line);
            if (!direct.size) this.detecting.delete(key);
            return;
        }
        const slash = key.lastIndexOf('/');
        if (slash >= 0) {
            const suffix = key.slice(slash + 1);
            for (const [k, byLine] of this.detecting) {
                if (k === suffix || k.endsWith('/' + suffix)) {
                    byLine.delete(line);
                    if (!byLine.size) this.detecting.delete(k);
                    return;
                }
            }
        }
    }

    private pruneExpiredDetecting(): void {
        const now = Date.now();
        for (const [path, byLine] of this.detecting) {
            for (const [ln, exp] of byLine) {
                if (exp <= now) byLine.delete(ln);
            }
            if (byLine.size === 0) this.detecting.delete(path);
        }
    }

    getSummary(restrictToBlameKeys?: Set<string>): BlameSummary {
        const acc = emptySummary();
        for (const [filePath, entries] of this.map) {
            if (restrictToBlameKeys && !restrictToBlameKeys.has(filePath)) {
                continue;
            }
            addEntriesToSummary(acc, entries);
        }
        acc.totalLines = acc.aiLines + acc.humanLines;
        return acc;
    }

    /**
     * AI/Human summary for a SINGLE file, matching what the gutter shows. Uses
     * getBlame's path resolution (direct, then repo-relative suffix) and the
     * same per-line dedup as getSummary; blank lines are already absent because
     * they're stripped at map-population time (CliDataService). The status bar
     * calls this so its count equals the icons visible in the active editor.
     */
    getSummaryForFile(filePath: string): BlameSummary {
        const acc = emptySummary();
        addEntriesToSummary(acc, this.getBlame(filePath));
        acc.totalLines = acc.aiLines + acc.humanLines;
        return acc;
    }

    clear(): void {
        this.map.clear();
    }
}

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
}

const PENDING_AI_TTL_MS = 12_000;

export class BlameMap {
    private map = new Map<string, LineBlame[]>();
    /** Skip destructive refresh while an optimistic AI paint is fresher. */
    lastOptimisticPaintMs = 0;
    private pendingAi = new Map<string, Map<number, PendingAiLine>>();

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
    ): void {
        const key = filePath.replace(/\\/g, '/');
        const expiresAt = Date.now() + PENDING_AI_TTL_MS;
        let byLine = this.pendingAi.get(key);
        if (!byLine) {
            byLine = new Map();
            this.pendingAi.set(key, byLine);
        }
        for (let ln = startLine; ln <= endLine; ln++) {
            byLine.set(ln, { tool, model, genType, expiresAtMs: expiresAt });
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

    getSummary(restrictToBlameKeys?: Set<string>): {
        aiChars: number;
        humanChars: number;
        aiLines: number;
        humanLines: number;
        totalLines: number;
    } {
        let aiChars = 0;
        let humanChars = 0;
        let aiLines = 0;
        let humanLines = 0;

        for (const [filePath, entries] of this.map) {
            if (restrictToBlameKeys && !restrictToBlameKeys.has(filePath)) {
                continue;
            }
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
                aiChars += e.aiChars;
                humanChars += e.humanChars;
                if (e.authorType === 'AI') aiLines++;
                else humanLines++;
            }
        }

        return {
            aiChars,
            humanChars,
            aiLines,
            humanLines,
            totalLines: aiLines + humanLines,
        };
    }

    clear(): void {
        this.map.clear();
    }
}

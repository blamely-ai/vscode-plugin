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
}

export class BlameMap {
    private map = new Map<string, LineBlame[]>();

    getBlame(filePath: string): LineBlame[] {
        return this.map.get(filePath.replace(/\\/g, '/')) ?? [];
    }

    getTrackedFiles(): string[] {
        return [...this.map.keys()];
    }

    setFileBlame(filePath: string, entries: LineBlame[]): void {
        this.map.set(filePath.replace(/\\/g, '/'), [...entries]);
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

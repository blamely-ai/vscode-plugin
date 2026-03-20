export interface LineBlame {
    lineNumber: number;
    authorType: 'HUMAN' | 'AI';
    provider: string | null;
    timestamp: string;
    commitSha: string | null;
    model: string | null;
    prompt: string | null;
    interactionType: string | null;
    aiChars: number;
    humanChars: number;
    changeType: 'ADD' | 'DELETE';
    newLineNumber: number | null;
    oldLineNumber: number | null;
    codingType: 'TYPING' | 'BULK_INSERT';
}

function normPath(path: string): string {
    return path.replace(/\\/g, '/');
}

export class BlameMap {
    private map: Map<string, LineBlame[]> = new Map();

    /** Tracks which old-file line numbers were deleted by AI (for commit snapshot attribution). */
    private aiDeletedLines: Map<string, Set<number>> = new Map();

    /** Total ms from user triggering AI until first AI edit (time waiting for AI). */
    private _totalTimeWaitingForAiMs: number = 0;

    /** Epoch ms when user first started coding (first attributed change) in this session. */
    private _firstStartCodingTimeMs: number = 0;

    get totalTimeWaitingForAiMs(): number {
        return this._totalTimeWaitingForAiMs;
    }

    get firstStartCodingTimeMs(): number {
        return this._firstStartCodingTimeMs;
    }

    recordFirstStartCodingTimeIfNeeded(): void {
        if (this._firstStartCodingTimeMs === 0) {
            this._firstStartCodingTimeMs = Date.now();
        }
    }

    addTimeWaitingForAi(deltaMs: number): void {
        if (deltaMs > 0) this._totalTimeWaitingForAiMs += deltaMs;
    }

    recordAiDeletion(filePath: string, startLineOldFile: number, deletedLineCount: number): void {
        const key = normPath(filePath);
        if (!this.aiDeletedLines.has(key)) {
            this.aiDeletedLines.set(key, new Set());
        }
        const set = this.aiDeletedLines.get(key)!;
        for (let line = startLineOldFile; line < startLineOldFile + deletedLineCount; line++) {
            set.add(line);
        }
    }

    wasLineDeletedByAi(filePath: string, oldLineNumber: number): boolean {
        const key = normPath(filePath);
        return this.aiDeletedLines.get(key)?.has(oldLineNumber) ?? false;
    }

    clearAiDeletionTracking(filePath: string): void {
        this.aiDeletedLines.delete(normPath(filePath));
    }

    decrementCharsForDeletion(filePath: string, startLine: number, oldFragment: string): void {
        const key = normPath(filePath);
        const list = this.map.get(key);
        if (!list) return;
        const lines = oldFragment.split('\n');
        const toRemoveFromList: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            const lineChars = lines[i].length;
            if (lineChars <= 0) continue;
            const lineNum = startLine + i;
            const entry = list.find(e => e.lineNumber === lineNum);
            if (!entry) continue;
            const aiChars = entry.aiChars;
            const humanChars = entry.humanChars;
            const total = aiChars + humanChars;
            if (total <= 0) continue;
            const toRemove = Math.min(lineChars, total);
            const humanReduce = Math.min(
                Math.floor((toRemove * humanChars) / total),
                humanChars
            );
            const aiReduce = Math.min(toRemove - humanReduce, aiChars);
            entry.humanChars = Math.max(0, humanChars - humanReduce);
            entry.aiChars = Math.max(0, aiChars - aiReduce);
            if (entry.aiChars === 0 && entry.humanChars === 0) {
                const idx = list.indexOf(entry);
                if (idx >= 0) toRemoveFromList.push(idx);
            }
        }
        for (let j = toRemoveFromList.length - 1; j >= 0; j--) {
            list.splice(toRemoveFromList[j], 1);
        }
        list.sort((a, b) => a.lineNumber - b.lineNumber);
    }

    setAttribute(
        filePath: string,
        lineStart: number,
        lineEnd: number,
        authorType: 'HUMAN' | 'AI',
        provider: string | null,
        model: string | null = null,
        prompt: string | null = null,
        interactionType: string | null = null,
        timestamp?: string,
        charsInserted: number = 0,
        charsPerLineOverride?: number[] | null,
        codingType: 'TYPING' | 'BULK_INSERT' = 'TYPING'
    ): LineBlame[] {
        const key = normPath(filePath);
        if (!this.map.has(key)) {
            this.map.set(key, []);
        }
        const entries = this.map.get(key)!;
        const ts = timestamp || new Date().toISOString();
        const affected: LineBlame[] = [];

        const lineCount = Math.max(lineEnd - lineStart + 1, 1);

        for (let index = 0; index <= lineEnd - lineStart; index++) {
            const line = lineStart + index;
            let charsThisLine: number;
            if (charsPerLineOverride && index < charsPerLineOverride.length) {
                charsThisLine = Math.max(charsPerLineOverride[index], 0);
            } else if (charsPerLineOverride) {
                charsThisLine = 0;
            } else {
                const base = Math.floor(charsInserted / lineCount);
                const remainder = charsInserted % lineCount;
                charsThisLine = base + (index < remainder ? 1 : 0);
            }

            const isNewLine = !entries.some(e => e.lineNumber === line);
            if (charsThisLine <= 0 && isNewLine) {
                charsThisLine = 1;
            } else if (charsThisLine <= 0) {
                continue;
            }

            const existingIdx = entries.findIndex(e => e.lineNumber === line);

            if (existingIdx >= 0) {
                const entry = entries[existingIdx];

                if (authorType === 'AI') {
                    entry.aiChars += charsThisLine;
                } else {
                    entry.humanChars += charsThisLine;
                }

                const totalChars = entry.aiChars + entry.humanChars;
                entry.authorType = (totalChars > 0 && entry.aiChars >= entry.humanChars) ? 'AI' : 'HUMAN';

                if (entry.authorType === 'AI') {
                    entry.provider = provider || entry.provider;
                    entry.model = model || entry.model;
                    entry.prompt = prompt || entry.prompt;
                    if (interactionType !== null) entry.interactionType = interactionType;
                }

                if (codingType !== 'TYPING') {
                    entry.codingType = codingType;
                }

                entry.timestamp = ts;
                if (entry.newLineNumber === null) entry.newLineNumber = line;
                affected.push(entry);
            } else {
                const blame: LineBlame = {
                    lineNumber: line,
                    authorType: authorType,
                    provider: provider,
                    timestamp: ts,
                    commitSha: null,
                    model: model,
                    prompt: prompt,
                    interactionType: authorType === 'AI' ? interactionType : null,
                    aiChars: authorType === 'AI' ? charsThisLine : 0,
                    humanChars: authorType === 'HUMAN' ? charsThisLine : 0,
                    changeType: 'ADD',
                    newLineNumber: line,
                    oldLineNumber: null,
                    codingType: codingType,
                };

                const totalChars = blame.aiChars + blame.humanChars;
                blame.authorType = (totalChars > 0 && blame.aiChars >= blame.humanChars) ? 'AI' : 'HUMAN';

                entries.push(blame);
                affected.push(blame);
            }
        }

        this.dedupeEntriesByLineNumber(entries);
        entries.sort((a, b) => a.lineNumber - b.lineNumber);
        return affected;
    }

    /**
     * Restore blame from preserved entries (e.g. after format-only changes).
     * Sets attribution for newStartLine..newStartLine+insertedLineCount-1 from preservedEntries
     * so that code ownership is kept when formatting.
     */
    setAttributeFromPreserved(
        filePath: string,
        newStartLine: number,
        preservedEntries: LineBlame[],
        insertedLineCount: number
    ): LineBlame[] {
        if (preservedEntries.length === 0 || insertedLineCount <= 0) return [];
        const key = normPath(filePath);
        if (!this.map.has(key)) {
            this.map.set(key, []);
        }
        const entries = this.map.get(key)!;
        const ts = new Date().toISOString();
        const affected: LineBlame[] = [];

        for (let i = 0; i < insertedLineCount; i++) {
            const line = newStartLine + i;
            const src = preservedEntries[Math.min(i, preservedEntries.length - 1)];
            const blame: LineBlame = {
                lineNumber: line,
                authorType: src.authorType,
                provider: src.provider,
                timestamp: ts,
                commitSha: null,
                model: src.model,
                prompt: src.prompt,
                interactionType: src.interactionType,
                aiChars: src.aiChars,
                humanChars: src.humanChars,
                changeType: 'ADD',
                newLineNumber: line,
                oldLineNumber: null,
                codingType: src.codingType,
            };
            entries.push(blame);
            affected.push(blame);
        }

        this.dedupeEntriesByLineNumber(entries);
        entries.sort((a, b) => a.lineNumber - b.lineNumber);
        return affected;
    }

    /** Remove duplicate line numbers, keeping the entry with the highest aiChars+humanChars per line. */
    private dedupeEntriesByLineNumber(list: LineBlame[]): void {
        const byLine = new Map<number, LineBlame>();
        for (const entry of list) {
            const existing = byLine.get(entry.lineNumber);
            if (!existing || (entry.aiChars + entry.humanChars) > (existing.aiChars + existing.humanChars)) {
                byLine.set(entry.lineNumber, entry);
            }
        }
        list.length = 0;
        for (const entry of byLine.values()) {
            list.push(entry);
        }
    }

    /** Mutate given entries to AI attribution (batch re-attribution when any in sequence matched AI). */
    reattributeToAi(entries: LineBlame[], provider: string | null, model: string | null): void {
        for (const b of entries) {
            if (b.authorType !== 'AI') {
                b.aiChars += b.humanChars;
                b.humanChars = 0;
            }
            b.authorType = 'AI';
            if (provider) b.provider = provider;
            if (model) b.model = model;
        }
    }

    getBlame(filePath: string): LineBlame[] {
        const key = normPath(filePath);
        return this.map.get(key) || this.map.get(filePath) || [];
    }

    getTrackedFiles(): string[] {
        return Array.from(this.map.keys());
    }

    getRawMap(): Map<string, LineBlame[]> {
        return this.map;
    }

    setCommitSha(commitSha: string): void {
        for (const entries of this.map.values()) {
            for (const entry of entries) {
                if (!entry.commitSha) {
                    entry.commitSha = commitSha;
                }
            }
        }
    }

    setCommitShaForFiles(commitSha: string, filePaths: Set<string>): void {
        if (filePaths.size === 0) return;
        const normalized = new Set([...filePaths].map(p => p.replace(/\\/g, '/')));
        for (const [path, entries] of this.map) {
            const norm = path.replace(/\\/g, '/');
            if (normalized.has(norm)) {
                for (const entry of entries) {
                    if (!entry.commitSha) entry.commitSha = commitSha;
                }
            }
        }
    }

    setCommitShaForLines(commitSha: string, filePath: string, lineNumbers: Set<number>): void {
        if (lineNumbers.size === 0) return;
        const entries = this.map.get(normPath(filePath));
        if (!entries) return;
        for (const entry of entries) {
            if (lineNumbers.has(entry.lineNumber) && !entry.commitSha) {
                entry.commitSha = commitSha;
            }
        }
    }

    setFileBlame(filePath: string, entries: LineBlame[]): void {
        this.map.set(normPath(filePath), [...entries]);
    }

    removeFile(filePath: string): void {
        const key = normPath(filePath);
        this.map.delete(key);
        this.aiDeletedLines.delete(key);
    }

    moveFile(oldPath: string, newPath: string): void {
        const oldKey = normPath(oldPath);
        const newKey = normPath(newPath);
        const entries = this.map.get(oldKey);
        if (!entries) return;
        this.map.delete(oldKey);
        for (const e of entries) {
            e.codingType = 'TYPING';
        }
        this.map.set(newKey, entries);
        const deletedLines = this.aiDeletedLines.get(oldKey);
        if (deletedLines) {
            this.aiDeletedLines.delete(oldKey);
            this.aiDeletedLines.set(newKey, deletedLines);
        }
    }

    /**
     * Summary counts only uncommitted (commitSha == null) entries.
     * Merges by normalized path and by line so duplicates are not double-counted.
     * Matches IntelliJ BlameMap.getSummary().
     */
    getSummary(): {
        totalLines: number;
        aiLines: number;
        humanLines: number;
        aiChars: number;
        humanChars: number;
        providerCounts: Map<string, number>;
    } {
        let totalLines = 0;
        let aiLines = 0;
        let humanLines = 0;
        let aiChars = 0;
        let humanChars = 0;
        const providerCounts = new Map<string, number>();

        const byNormPath = new Map<string, LineBlame[]>();
        for (const [key, entries] of this.map) {
            const norm = normPath(key);
            const existing = byNormPath.get(norm) ?? [];
            byNormPath.set(norm, existing.concat(entries));
        }

        for (const entries of byNormPath.values()) {
            const byLine = new Map<number, LineBlame>();
            for (const entry of entries) {
                if (entry.commitSha !== null && entry.commitSha !== undefined) continue;
                const line = entry.lineNumber;
                const total = entry.aiChars + entry.humanChars;
                const current = byLine.get(line);
                const currentTotal = current ? current.aiChars + current.humanChars : 0;
                if (total >= currentTotal) byLine.set(line, entry);
            }
            for (const entry of byLine.values()) {
                totalLines++;
                aiChars += entry.aiChars;
                humanChars += entry.humanChars;
                if (entry.authorType === 'AI') {
                    aiLines++;
                    if (entry.provider) {
                        providerCounts.set(
                            entry.provider,
                            (providerCounts.get(entry.provider) || 0) + 1
                        );
                    }
                } else {
                    humanLines++;
                }
            }
        }

        return { totalLines, aiLines, humanLines, aiChars, humanChars, providerCounts };
    }

    clear(): void {
        this.map.clear();
        this.aiDeletedLines.clear();
        this._totalTimeWaitingForAiMs = 0;
        this._firstStartCodingTimeMs = 0;
    }
}

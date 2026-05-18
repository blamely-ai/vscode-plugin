import { expect } from 'chai';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { reindex } from '../blame/BlameIndex';

function makeEntry(overrides: Partial<LineBlame> & { lineNumber: number }): LineBlame {
    return {
        authorType: 'HUMAN',
        provider: null,
        timestamp: '',
        commitSha: null,
        model: null,
        prompt: null,
        interactionType: null,
        ide: null,
        aiChars: 0,
        humanChars: 0,
        changeType: 'ADD',
        newLineNumber: overrides.lineNumber,
        oldLineNumber: null,
        codingType: 'TYPING',
        ...overrides,
    };
}

describe('BlameMap', () => {
    let blameMap: BlameMap;

    beforeEach(() => {
        blameMap = new BlameMap();
    });

    describe('setAttribute', () => {
        it('should add blame entries for a line range', () => {
            blameMap.setAttribute('test.ts', 1, 5, 'AI', 'copilot');
            const entries = blameMap.getBlame('test.ts');
            expect(entries).to.have.length(5);
            expect(entries[0].lineNumber).to.equal(1);
            expect(entries[0].authorType).to.equal('AI');
            expect(entries[0].provider).to.equal('copilot');
            expect(entries[0].codingType).to.equal('TYPING');
            expect(entries[4].lineNumber).to.equal(5);
        });

        it('should use 50% rule: aiChars >= humanChars -> AI', () => {
            blameMap.setAttribute('test.ts', 3, 3, 'AI', 'copilot', null, null, null, undefined, 10);
            blameMap.setAttribute('test.ts', 3, 3, 'HUMAN', null, null, null, null, undefined, 10);
            const entries = blameMap.getBlame('test.ts');
            expect(entries).to.have.length(1);
            // 10 AI + 10 Human -> aiChars >= humanChars -> AI
            expect(entries[0].authorType).to.equal('AI');
        });

        it('should attribute as HUMAN when humanChars > aiChars', () => {
            blameMap.setAttribute('test.ts', 3, 3, 'AI', 'copilot', null, null, null, undefined, 10);
            blameMap.setAttribute('test.ts', 3, 3, 'HUMAN', null, null, null, null, undefined, 100);
            const entries = blameMap.getBlame('test.ts');
            expect(entries).to.have.length(1);
            expect(entries[0].authorType).to.equal('HUMAN');
        });

        it('should keep entries sorted by line number', () => {
            blameMap.setAttribute('test.ts', 10, 12, 'AI', 'copilot');
            blameMap.setAttribute('test.ts', 1, 3, 'HUMAN', null);
            const entries = blameMap.getBlame('test.ts');
            expect(entries[0].lineNumber).to.equal(1);
            expect(entries[entries.length - 1].lineNumber).to.equal(12);
        });

        it('should accept charsPerLineOverride for accurate per-line counts', () => {
            blameMap.setAttribute('test.ts', 1, 3, 'AI', 'copilot', null, null, null, undefined, 30, [5, 15, 10]);
            const entries = blameMap.getBlame('test.ts');
            expect(entries[0].aiChars).to.equal(5);
            expect(entries[1].aiChars).to.equal(15);
            expect(entries[2].aiChars).to.equal(10);
        });

        it('should count new lines with 0 chars as 1 char', () => {
            blameMap.setAttribute('test.ts', 1, 3, 'HUMAN', null, null, null, null, undefined, 0);
            const entries = blameMap.getBlame('test.ts');
            expect(entries).to.have.length(3);
            for (const e of entries) {
                expect(e.humanChars).to.equal(1);
            }
        });

        it('should set codingType parameter', () => {
            blameMap.setAttribute('test.ts', 1, 1, 'HUMAN', null, null, null, null, undefined, 5, undefined, 'BULK_INSERT');
            const entries = blameMap.getBlame('test.ts');
            expect(entries[0].codingType).to.equal('BULK_INSERT');
        });

        it('sets BULK_INSERT when appending multi-line HUMAN paste onto an existing line', () => {
            blameMap.setAttribute('paste.ts', 2, 2, 'HUMAN', null, null, null, null, undefined, 3);
            blameMap.setAttribute(
                'paste.ts',
                2,
                3,
                'HUMAN',
                null,
                null,
                null,
                null,
                undefined,
                20,
                undefined,
                'BULK_INSERT'
            );
            const rows = blameMap.getBlame('paste.ts');
            expect(rows.find(e => e.lineNumber === 2)?.codingType).to.equal('BULK_INSERT');
            expect(rows.find(e => e.lineNumber === 3)?.codingType).to.equal('BULK_INSERT');
        });
    });

    describe('getBlame', () => {
        it('should return empty array for untracked file', () => {
            const entries = blameMap.getBlame('unknown.ts');
            expect(entries).to.have.length(0);
        });
    });

    describe('getSummary', () => {
        it('counts ADD lines in map, including after setCommitSha and CLI-style commitSha on disk', () => {
            blameMap.setAttribute('a.ts', 1, 10, 'AI', 'copilot');
            blameMap.setAttribute('a.ts', 11, 20, 'HUMAN', null);
            blameMap.setAttribute('b.ts', 1, 5, 'AI', 'cursor');

            const summary = blameMap.getSummary();
            expect(summary.totalLines).to.equal(25);
            expect(summary.aiLines).to.equal(15);
            expect(summary.humanLines).to.equal(10);
            expect(summary.providerCounts.get('copilot')).to.equal(10);
            expect(summary.providerCounts.get('cursor')).to.equal(5);

            blameMap.setCommitSha('abc12345');
            const after = blameMap.getSummary();
            expect(after.totalLines).to.equal(25);
            expect(after.aiLines).to.equal(15);
            expect(after.humanLines).to.equal(10);
        });

        it('includes snapshot rows with commitSha from setFileBlame', () => {
            const snapshot: LineBlame[] = [
                {
                    lineNumber: 1,
                    authorType: 'AI',
                    provider: null,
                    timestamp: '2026-01-01T00:00:00Z',
                    commitSha: 'deadbeef',
                    model: 'm',
                    prompt: null,
                    ide: null,
                    aiChars: 1,
                    humanChars: 0,
                    interactionType: 'blamely-cli-trace',
                    changeType: 'ADD',
                    newLineNumber: null,
                    oldLineNumber: null,
                    codingType: 'BULK_INSERT',
                },
                {
                    lineNumber: 2,
                    authorType: 'HUMAN',
                    provider: null,
                    timestamp: '2026-01-01T00:00:00Z',
                    commitSha: 'deadbeef',
                    model: null,
                    prompt: null,
                    ide: null,
                    aiChars: 0,
                    humanChars: 1,
                    interactionType: null,
                    changeType: 'ADD',
                    newLineNumber: null,
                    oldLineNumber: null,
                    codingType: 'TYPING',
                },
            ];
            blameMap.setFileBlame('snap.ts', snapshot);
            const s = blameMap.getSummary();
            expect(s.totalLines).to.equal(2);
            expect(s.aiLines).to.equal(1);
            expect(s.humanLines).to.equal(1);
        });

        it('should return zero counts for empty map', () => {
            const summary = blameMap.getSummary();
            expect(summary.totalLines).to.equal(0);
            expect(summary.aiLines).to.equal(0);
            expect(summary.humanLines).to.equal(0);
        });

        it('should only include files in restrictToBlameKeys when provided', () => {
            blameMap.setAttribute('a.ts', 1, 2, 'AI', 'copilot');
            blameMap.setAttribute('b.ts', 1, 2, 'HUMAN', null);
            const onlyA = blameMap.getSummary(new Set(['a.ts']));
            expect(onlyA.totalLines).to.equal(2);
            expect(onlyA.aiLines).to.equal(2);
            const none = blameMap.getSummary(new Set());
            expect(none.totalLines).to.equal(0);
        });
    });

    describe('setCommitSha', () => {
        it('should set commit SHA on all entries without one', () => {
            blameMap.setAttribute('a.ts', 1, 3, 'AI', 'copilot');
            blameMap.setCommitSha('abc12345');
            const entries = blameMap.getBlame('a.ts');
            expect(entries[0].commitSha).to.equal('abc12345');
        });
    });

    describe('setCommitShaForFiles', () => {
        it('should only set commitSha for specified files', () => {
            blameMap.setAttribute('a.ts', 1, 2, 'AI', 'copilot');
            blameMap.setAttribute('b.ts', 1, 2, 'HUMAN', null);
            blameMap.setCommitShaForFiles('sha1', new Set(['a.ts']));
            expect(blameMap.getBlame('a.ts')[0].commitSha).to.equal('sha1');
            expect(blameMap.getBlame('b.ts')[0].commitSha).to.equal(null);
        });
    });

    describe('setCommitShaForLines', () => {
        it('should only set commitSha for specified lines', () => {
            blameMap.setAttribute('a.ts', 1, 3, 'AI', 'copilot');
            blameMap.setCommitShaForLines('sha1', 'a.ts', new Set([1, 3]));
            const entries = blameMap.getBlame('a.ts');
            expect(entries[0].commitSha).to.equal('sha1');
            expect(entries[1].commitSha).to.equal(null);
            expect(entries[2].commitSha).to.equal('sha1');
        });
    });

    describe('removeFile', () => {
        it('should remove blame and AI deletion tracking for a file', () => {
            blameMap.setAttribute('a.ts', 1, 3, 'AI', 'copilot');
            blameMap.recordAiDeletion('a.ts', 1, 1);
            blameMap.removeFile('a.ts');
            expect(blameMap.getBlame('a.ts')).to.have.length(0);
            expect(blameMap.wasLineDeletedByAi('a.ts', 1)).to.equal(false);
        });
    });

    describe('moveFile', () => {
        it('should transfer blame from old to new path and reset codingType', () => {
            blameMap.setAttribute('a.ts', 1, 2, 'AI', 'copilot', null, null, null, undefined, 10, undefined, 'BULK_INSERT');
            blameMap.moveFile('a.ts', 'b.ts');
            expect(blameMap.getBlame('a.ts')).to.have.length(0);
            const entries = blameMap.getBlame('b.ts');
            expect(entries).to.have.length(2);
            expect(entries[0].codingType).to.equal('TYPING');
        });
    });

    describe('reattributeToAi', () => {
        it('should move humanChars to aiChars and set authorType to AI', () => {
            blameMap.setAttribute('a.ts', 1, 2, 'HUMAN', null, null, null, null, undefined, 20);
            const entries = blameMap.getBlame('a.ts');
            blameMap.reattributeToAi(entries, 'copilot', 'gpt-4');
            expect(entries[0].authorType).to.equal('AI');
            expect(entries[0].aiChars).to.be.greaterThan(0);
            expect(entries[0].humanChars).to.equal(0);
            expect(entries[0].provider).to.equal('copilot');
            expect(entries[0].model).to.equal('gpt-4');
        });
    });

    describe('AI deletion tracking', () => {
        it('should record and query AI-deleted lines', () => {
            expect(blameMap.wasLineDeletedByAi('f.ts', 2)).to.equal(false);
            blameMap.recordAiDeletion('f.ts', 2, 3);
            expect(blameMap.wasLineDeletedByAi('f.ts', 2)).to.equal(true);
            expect(blameMap.wasLineDeletedByAi('f.ts', 3)).to.equal(true);
            expect(blameMap.wasLineDeletedByAi('f.ts', 4)).to.equal(true);
            expect(blameMap.wasLineDeletedByAi('f.ts', 5)).to.equal(false);
            blameMap.clearAiDeletionTracking('f.ts');
            expect(blameMap.wasLineDeletedByAi('f.ts', 2)).to.equal(false);
        });
    });

    describe('decrementCharsForDeletion', () => {
        it('should reduce char counts and remove entries when both reach zero', () => {
            blameMap.setAttribute('f.ts', 1, 3, 'AI', 'copilot', null, null, null, undefined, 30);
            const before = blameMap.getBlame('f.ts');
            expect(before).to.have.length(3);
            blameMap.decrementCharsForDeletion('f.ts', 1, 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc');
            const after = blameMap.getBlame('f.ts');
            expect(after.length).to.be.lessThanOrEqual(3);
            const entry2 = after.find(e => e.lineNumber === 2);
            if (entry2) {
                expect(entry2.aiChars + entry2.humanChars).to.be.lessThanOrEqual(10);
            }
        });
    });

    describe('session metrics', () => {
        it('should record first start coding time once and accumulate waiting time', () => {
            expect(blameMap.firstStartCodingTimeMs).to.equal(0);
            expect(blameMap.totalTimeWaitingForAiMs).to.equal(0);
            blameMap.recordFirstStartCodingTimeIfNeeded();
            expect(blameMap.firstStartCodingTimeMs).to.be.greaterThan(0);
            const first = blameMap.firstStartCodingTimeMs;
            blameMap.recordFirstStartCodingTimeIfNeeded();
            expect(blameMap.firstStartCodingTimeMs).to.equal(first);
            blameMap.addTimeWaitingForAi(100);
            blameMap.addTimeWaitingForAi(50);
            expect(blameMap.totalTimeWaitingForAiMs).to.equal(150);
        });
    });

    describe('clear', () => {
        it('should reset blame map, AI deletion tracking, and session metrics', () => {
            blameMap.setAttribute('a.ts', 1, 2, 'AI', 'copilot');
            blameMap.recordAiDeletion('a.ts', 1, 1);
            blameMap.recordFirstStartCodingTimeIfNeeded();
            blameMap.addTimeWaitingForAi(100);
            blameMap.clear();
            expect(blameMap.getBlame('a.ts')).to.have.length(0);
            expect(blameMap.wasLineDeletedByAi('a.ts', 1)).to.equal(false);
            expect(blameMap.firstStartCodingTimeMs).to.equal(0);
            expect(blameMap.totalTimeWaitingForAiMs).to.equal(0);
        });
    });
});

describe('BlameIndex.reindex', () => {
    it('should shift lines down on insertion', () => {
        const entries: LineBlame[] = [
            makeEntry({ lineNumber: 1 }),
            makeEntry({ lineNumber: 5, authorType: 'AI', provider: 'copilot', model: 'copilot' }),
            makeEntry({ lineNumber: 10 }),
        ];
        const result = reindex(entries, 3, 2, 0);
        expect(result[0].lineNumber).to.equal(1);
        expect(result[1].lineNumber).to.equal(7);
        expect(result[2].lineNumber).to.equal(12);
    });

    it('should remove deleted lines and shift remaining', () => {
        const entries: LineBlame[] = [
            makeEntry({ lineNumber: 1 }),
            makeEntry({ lineNumber: 3, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 4, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 8 }),
        ];
        const result = reindex(entries, 3, 0, 2);
        expect(result).to.have.length(2);
        expect(result[0].lineNumber).to.equal(1);
        expect(result[1].lineNumber).to.equal(6);
    });

    it('should remove every line of a multi-line empty delete — not treat first line as surviving', () => {
        const entries: LineBlame[] = [
            makeEntry({ lineNumber: 1 }),
            makeEntry({ lineNumber: 3, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 4, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 5, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 10 }),
        ];
        // Multi-line range + insertedText "" must pass linesInserted=0 (not 1 from ''.split)
        const result = reindex(entries, 3, 0, 3);
        expect(result).to.have.length(2);
        expect(result[0].lineNumber).to.equal(1);
        expect(result[1].lineNumber).to.equal(7);
    });

    it('should handle replacement (delete + insert) — surviving line preserved', () => {
        const entries: LineBlame[] = [
            makeEntry({ lineNumber: 1 }),
            makeEntry({ lineNumber: 3, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 10 }),
        ];
        // Replace 1 line at position 3 with 5 lines → line 3 survives (modified), none truly deleted
        const result = reindex(entries, 3, 5, 1);
        expect(result).to.have.length(3);
        expect(result[0].lineNumber).to.equal(1);
        expect(result[1].lineNumber).to.equal(3);  // surviving line
        expect(result[2].lineNumber).to.equal(14);
    });

    it('should truly delete excess lines when deleting more than inserting', () => {
        const entries: LineBlame[] = [
            makeEntry({ lineNumber: 1 }),
            makeEntry({ lineNumber: 3, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 4 }),
            makeEntry({ lineNumber: 5 }),
            makeEntry({ lineNumber: 10 }),
        ];
        // Replace 3 lines (3-5) with 1 line → line 3 survives, lines 4-5 deleted
        const result = reindex(entries, 3, 1, 3);
        expect(result).to.have.length(3);
        expect(result[0].lineNumber).to.equal(1);
        expect(result[1].lineNumber).to.equal(3);  // surviving line
        expect(result[2].lineNumber).to.equal(8);  // was 10, shifted by -2
    });

    it('in-line Backspace (same-line empty replace) keeps blame row — use reindexInserted=0 reindexDeleted=0', () => {
        const entries: LineBlame[] = [makeEntry({ lineNumber: 5, humanChars: 5 })];
        const keepRow = reindex(entries, 5, 0, 0);
        expect(keepRow).to.have.length(1);
        expect(keepRow[0].lineNumber).to.equal(5);
        const dropRow = reindex(entries, 5, 0, 1);
        expect(dropRow).to.have.length(0);
    });

    it('should treat empty-delete single-line range as net −1 line (Backspace join), not split length 1', () => {
        const entries: LineBlame[] = [
            makeEntry({ lineNumber: 1 }),
            makeEntry({ lineNumber: 3, authorType: 'AI', provider: 'copilot' }),
            makeEntry({ lineNumber: 4 }),
        ];
        // processChange maps insert "" with start.line===end.line to insertedLineCount=0 (not 1 from ['']).
        // One document line removed at row 2 — blame on line 3 shifts up and stays AI.
        const result = reindex(entries, 2, 0, 1);
        expect(result).to.have.length(3);
        expect(result[0].lineNumber).to.equal(1);
        expect(result[1].lineNumber).to.equal(2);
        expect(result[1].authorType).to.equal('AI');
        expect(result[2].lineNumber).to.equal(3);
        const wrong = reindex(entries, 2, 1, 1);
        expect(wrong.find(e => e.lineNumber === 3)?.authorType).to.equal('AI');
        expect(wrong).to.have.length(3);
    });

    it('should preserve same-line edits (typing on existing line)', () => {
        const entries: LineBlame[] = [
            makeEntry({ lineNumber: 5, humanChars: 20 }),
            makeEntry({ lineNumber: 6 }),
        ];
        // Single char typed on line 5: linesInserted=1, linesDeleted=1 → line survives
        const result = reindex(entries, 5, 1, 1);
        expect(result).to.have.length(2);
        expect(result[0].lineNumber).to.equal(5);
        expect(result[0].humanChars).to.equal(20);  // preserved, not reset
        expect(result[1].lineNumber).to.equal(6);
    });
});

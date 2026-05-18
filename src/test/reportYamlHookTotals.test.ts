import { expect } from 'chai';
import * as ReportYaml from '../report/hookTotals';
import type { LineBlame } from '../blame/BlameMap';

function line(partial: Partial<LineBlame> & Pick<LineBlame, 'authorType' | 'changeType' | 'lineNumber'>): LineBlame {
    return {
        provider: null,
        timestamp: 't',
        commitSha: 's',
        model: null,
        prompt: null,
        interactionType: null,
        ide: null,
        aiChars: partial.authorType === 'AI' ? 1 : 0,
        humanChars: partial.authorType === 'HUMAN' ? 1 : 0,
        newLineNumber: partial.changeType === 'ADD' ? partial.lineNumber : null,
        oldLineNumber: partial.changeType === 'DELETE' ? partial.lineNumber : null,
        codingType: 'TYPING',
        ...partial,
    };
}

describe('ReportYaml hook totals / AI vs Human deletes', () => {
    it('computeHookTotalsFromBlameSnapshot splits DELETE by author', () => {
        const snap: Record<string, LineBlame[]> = {
            'x.ts': [
                line({ lineNumber: 1, authorType: 'AI', changeType: 'ADD' }),
                line({ lineNumber: 2, authorType: 'AI', changeType: 'ADD' }),
                line({ lineNumber: 10, authorType: 'HUMAN', changeType: 'DELETE' }),
                line({ lineNumber: 11, authorType: 'AI', changeType: 'DELETE' }),
            ],
        };
        const t = ReportYaml.computeHookTotalsFromBlameSnapshot(snap);
        expect(t.aiLinesAdded).to.equal(2);
        expect(t.humanLinesAdded).to.equal(0);
        expect(t.aiLinesDeleted).to.equal(1);
        expect(t.humanLinesDeleted).to.equal(1);
    });

    it('detectorHookPreamble includes v2 lines', () => {
        const p = ReportYaml.detectorHookPreamble({
            aiLinesAdded: 5,
            aiLinesDeleted: 2,
            humanLinesAdded: 10,
            humanLinesDeleted: 1,
        });
        expect(p).to.include('# ai_lines_added: 5');
        expect(p).to.include('# ai_lines_deleted: 2');
        expect(p).to.include('# human_lines_added: 10');
        expect(p).to.include('# human_lines_deleted: 1');
    });
});

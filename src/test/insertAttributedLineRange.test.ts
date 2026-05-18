import { expect } from 'chai';
import { insertAttributedLineRange1Based } from '../utils/insertAttributedLineRange';

describe('insertAttributedLineRange1Based', () => {
    it('places blank-line gap below caret line when char > 0', () => {
        const lines = ['', ''];
        const r = insertAttributedLineRange1Based(/* char */ 5, 2, lines, lines.length, 1, true);
        expect(r).to.deep.equal({ start: 3, end: 3 });
    });

    it('places gap at line when caret at column 0', () => {
        const lines = ['', ''];
        const r = insertAttributedLineRange1Based(0, 3, lines, lines.length, 1, true);
        expect(r).to.deep.equal({ start: 3, end: 3 });
    });

    it('spans caret line and new line for foo\\nbar style insert', () => {
        const lines = ['foo', 'bar'];
        const r = insertAttributedLineRange1Based(3, 2, lines, lines.length, 1, true);
        expect(r).to.deep.equal({ start: 2, end: 3 });
    });

    it('uses full insertedLineCount for non-gap insert', () => {
        const lines = ['a', 'b', 'c'];
        const r = insertAttributedLineRange1Based(0, 1, lines, lines.length, 2, false);
        expect(r).to.deep.equal({ start: 1, end: 3 });
    });
});

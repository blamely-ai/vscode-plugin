import { strict as assert } from 'assert';
import { isBlankLine } from '../utils/BlankLines';

describe('BlankLines', () => {
    it('isBlankLine treats empty and whitespace as blank', () => {
        assert.equal(isBlankLine(''), true);
        assert.equal(isBlankLine('   '), true);
        assert.equal(isBlankLine('\t\r'), true);
        assert.equal(isBlankLine('code'), false);
    });
});

import { expect } from 'chai';
import { matchSuggestion, similarity } from '../utils/DiffMatcher';
import { SuggestionRecord } from '../store/TraceStore';

function makeSuggestion(overrides: Partial<SuggestionRecord> = {}): SuggestionRecord {
    return {
        suggestion_id: 'test-id',
        timestamp: new Date().toISOString(),
        file_path: 'test.ts',
        line_start: 1,
        line_end: 1,
        char_start: 0,
        char_end: 10,
        suggested_text: 'console.log("hello")',
        provider_id: 'copilot',
        context_before: '',
        accepted: false,
        accepted_at: null,
        final_text: null,
        model_name: null,
        prompt: null,
        ...overrides,
    };
}

describe('DiffMatcher', () => {
    describe('matchSuggestion', () => {
        it('should match exact text', () => {
            const suggestions = [makeSuggestion({ suggested_text: 'const x = 1;' })];
            const result = matchSuggestion(suggestions, 'const x = 1;', 'test.ts', { line: 0, character: 0 });
            expect(result).to.not.be.null;
            expect(result!.similarity).to.equal(1.0);
            expect(result!.suggestion.suggestion_id).to.equal('test-id');
        });

        it('should match with normalized whitespace', () => {
            const suggestions = [makeSuggestion({ suggested_text: 'const  x =  1;' })];
            const result = matchSuggestion(suggestions, 'const x = 1;', 'test.ts', { line: 0, character: 0 });
            expect(result).to.not.be.null;
            expect(result!.similarity).to.equal(0.95);
        });

        it('should match fuzzy with high similarity', () => {
            const suggestions = [makeSuggestion({ suggested_text: 'console.log("hello world")' })];
            const result = matchSuggestion(suggestions, 'console.log("hello world!")', 'test.ts', { line: 0, character: 0 });
            expect(result).to.not.be.null;
            expect(result!.similarity).to.be.greaterThanOrEqual(0.8);
        });

        it('should not match completely different text', () => {
            const suggestions = [makeSuggestion({ suggested_text: 'const x = 1;' })];
            const result = matchSuggestion(suggestions, 'function foo() { return bar; }', 'test.ts', { line: 0, character: 0 });
            expect(result).to.be.null;
        });

        it('should not match empty inserted text', () => {
            const suggestions = [makeSuggestion()];
            const result = matchSuggestion(suggestions, '', 'test.ts', { line: 0, character: 0 });
            expect(result).to.be.null;
        });

        it('should not match suggestions from different files', () => {
            const suggestions = [makeSuggestion({ file_path: 'other.ts', suggested_text: 'const x = 1;' })];
            const result = matchSuggestion(suggestions, 'const x = 1;', 'test.ts', { line: 0, character: 0 });
            expect(result).to.be.null;
        });
    });

    describe('similarity', () => {
        it('should return 1.0 for identical strings', () => {
            expect(similarity('hello', 'hello')).to.equal(1.0);
        });

        it('should return 0.0 for completely different strings of same length', () => {
            const sim = similarity('abcde', 'fghij');
            expect(sim).to.be.lessThan(0.5);
        });

        it('should return 1.0 for two empty strings', () => {
            expect(similarity('', '')).to.equal(1.0);
        });

        it('should handle one empty string', () => {
            expect(similarity('hello', '')).to.equal(0.0);
        });
    });
});

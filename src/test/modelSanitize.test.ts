import { expect } from 'chai';
import { sanitizeModelForReport } from '../utils/modelSanitize';

describe('modelSanitize', () => {
    it('dedupes repeated slash segments from LM API ids', () => {
        expect(
            sanitizeModelForReport('copilot/gemini-3.1-pro-preview/gemini-3.1-pro-preview')
        ).to.equal('copilot/gemini-3.1-pro-preview');
    });

    it('preserves distinct segments', () => {
        expect(sanitizeModelForReport('openai/gpt-4o-mini')).to.equal('openai/gpt-4o-mini');
    });
});

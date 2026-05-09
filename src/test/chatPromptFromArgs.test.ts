import { expect } from 'chai';
import { extractPossibleChatPrompt } from '../utils/chatPromptFromArgs';

describe('extractPossibleChatPrompt', () => {
    it('reads nested message field', () => {
        const prompt = extractPossibleChatPrompt([
            { sessionId: 'x', payload: { message: 'add simple functions3' } },
        ]);
        expect(prompt).to.equal('add simple functions3');
    });

    it('prefers explicit prompt key over other strings', () => {
        const prompt = extractPossibleChatPrompt([
            { context: '/tmp/foo', prompt: 'hello world' },
        ]);
        expect(prompt).to.equal('hello world');
    });

    it('returns undefined for empty args', () => {
        expect(extractPossibleChatPrompt(undefined)).to.be.undefined;
        expect(extractPossibleChatPrompt([])).to.be.undefined;
    });

    it('truncates to maxLen', () => {
        const long = 'a'.repeat(100);
        const prompt = extractPossibleChatPrompt([{ message: long }], 20);
        expect(prompt?.length).to.equal(20);
    });
});

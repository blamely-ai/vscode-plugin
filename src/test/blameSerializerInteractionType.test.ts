import { expect } from 'chai';
import {
    interactionTypeForBlameJson,
    normalizeAiInteractionTypeForDisk,
} from '../blame/blameJsonPersist';
import type { LineBlame } from '../blame/BlameMap';

function baseLine(overrides: Partial<LineBlame>): LineBlame {
    return {
        lineNumber: 1,
        authorType: 'HUMAN',
        provider: null,
        timestamp: '2020-01-01T00:00:00.000Z',
        commitSha: null,
        model: null,
        prompt: null,
        interactionType: null,
        ide: 'test-ide',
        aiChars: 0,
        humanChars: 3,
        changeType: 'ADD',
        newLineNumber: 1,
        oldLineNumber: null,
        codingType: 'TYPING',
        ...overrides,
    };
}

describe('BlameSerializer interactionType', () => {
      it('uses null on disk for human rows', () => {
        expect(interactionTypeForBlameJson(baseLine({ authorType: 'HUMAN', interactionType: null }))).to.equal(null);
        expect(
            interactionTypeForBlameJson(baseLine({ authorType: 'HUMAN', interactionType: 'chat_panel' }))
        ).to.equal(null);
    });

    it('maps AI without type to completion', () => {
        expect(
            interactionTypeForBlameJson(
                baseLine({
                    authorType: 'AI',
                    interactionType: null,
                    aiChars: 5,
                    humanChars: 0,
                })
            )
        ).to.equal('completion');
    });

    it('maps chat_panel to panel and chat_inline to chat', () => {
        expect(
            interactionTypeForBlameJson(
                baseLine({
                    authorType: 'AI',
                    interactionType: 'chat_panel',
                    aiChars: 5,
                    humanChars: 0,
                })
            )
        ).to.equal('panel');
        expect(
            interactionTypeForBlameJson(
                baseLine({
                    authorType: 'AI',
                    interactionType: 'chat_inline',
                    aiChars: 5,
                    humanChars: 0,
                })
            )
        ).to.equal('chat');
    });

    it('maps CLI scopes to cli', () => {
        expect(normalizeAiInteractionTypeForDisk('ai_cli_trace')).to.equal('cli');
        expect(normalizeAiInteractionTypeForDisk('blamely-cli-invoke')).to.equal('cli');
    });
});

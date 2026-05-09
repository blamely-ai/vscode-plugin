import { expect } from 'chai';
import { extensionIdLooksAiCodingAssistant } from '../utils/aiAssistantExtensionHint';

describe('extensionIdLooksAiCodingAssistant', () => {
    it('matches GitHub Copilot extension ids', () => {
        expect(extensionIdLooksAiCodingAssistant('GitHub.copilot')).to.equal(true);
        expect(extensionIdLooksAiCodingAssistant('github.copilot-chat')).to.equal(true);
    });

    it('matches Anthropic / Claude family ids', () => {
        expect(extensionIdLooksAiCodingAssistant('anthropic.claude-code')).to.equal(true);
        expect(extensionIdLooksAiCodingAssistant('Anthropic.claude')).to.equal(true);
        expect(extensionIdLooksAiCodingAssistant('saoudrizwan.claude-dev')).to.equal(true);
    });

    it('matches Cursor and common assistants', () => {
        expect(extensionIdLooksAiCodingAssistant('cursor.cursor')).to.equal(true);
        expect(extensionIdLooksAiCodingAssistant('codeium.codeium')).to.equal(true);
        expect(extensionIdLooksAiCodingAssistant('cline.cline')).to.equal(true);
    });

    it('ignores unrelated extensions', () => {
        expect(extensionIdLooksAiCodingAssistant('dbaeumer.vscode-eslint')).to.equal(false);
        expect(extensionIdLooksAiCodingAssistant('ms-python.python')).to.equal(false);
    });
});

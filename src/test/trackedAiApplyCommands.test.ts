import { expect } from 'chai';
import {
    AI_COMMAND_PATTERNS,
    isInlineGhostSuggestionCommand,
    matchesTrackedAiApplyCommand,
} from '../utils/trackedAiApplyCommands';

describe('trackedAiApplyCommands', () => {
    it('matches new Cursor composer / CLI-style apply command IDs', () => {
        const ids = [
            'composer.acceptAll',
            'composer.applyAll',
            'cursor.composer.applyAll',
            'cursor.aiChat.applyEdit',
            'cursor.applyEditAtCursor',
            'cursor.aiChat.acceptDiff',
            'cursor.applySearchAndReplace',
            'cursor.agent.applyAll',
            'cline.acceptApproval',
            'cline.applyChanges',
            'claude-dev.acceptChanges',
            'anthropic.applyEdit',
            'anthropic.chat.acceptDiff',
            'claude.acceptCurrentDiff',
        ];
        for (const id of ids) {
            expect(matchesTrackedAiApplyCommand(id), id).to.equal(true);
        }
    });

    it('treats keep like apply/accept for chat and composer commands', () => {
        expect(matchesTrackedAiApplyCommand('workbench.action.chat.keep')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('inlineChat.keep')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('composer.keepAll')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('github.copilot.chat.keepChange')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('github.copilot.chat.keep')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('github.copilot.chat.keepAll')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('multiDiffEditor.keep')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('cursor.inlineEdit.keep')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('workbench.action.inlineEdit.keep')).to.equal(true);
    });

    it('matches Cursor agent / cloud / Copilot apply patterns beyond static list', () => {
        expect(matchesTrackedAiApplyCommand('cursor.agent.local.applyAll')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('cursor.cloud.composer.acceptAll')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('cursor.background.agent.keepAll')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('github.copilot.chat.agent.applyWorkspaceEdit')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('cursor.agent.open')).to.equal(false);
    });

    it('broad fallback matches new chat/apply IDs without an explicit static entry', () => {
        expect(matchesTrackedAiApplyCommand('cursor.diffReview.acceptAll')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('workbench.action.chat.run.applyEdit')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('myext.chat.applyPatch')).to.equal(true);
        expect(matchesTrackedAiApplyCommand('cursor.theme.enableSync')).to.equal(false);
        expect(matchesTrackedAiApplyCommand('git.commit')).to.equal(false);
        expect(matchesTrackedAiApplyCommand('github.copilot.chat.signIn')).to.equal(false);
    });

    it('enumerates Cursor / Cline additions in AI_COMMAND_PATTERNS.chatPanel', () => {
        const panelSet = new Set(AI_COMMAND_PATTERNS.chatPanel);
        expect(panelSet.has('cursor.agent.applyAll')).to.equal(true);
        expect(panelSet.has('cline.acceptApproval')).to.equal(true);
    });

    it('isInlineGhostSuggestionCommand detects VS Code inline suggest commits only', () => {
        expect(isInlineGhostSuggestionCommand('editor.action.inlineSuggest.commit')).to.equal(true);
        expect(isInlineGhostSuggestionCommand('editor.action.inlineSuggest.acceptNextWord')).to.equal(true);
        expect(isInlineGhostSuggestionCommand('workbench.action.chat.apply')).to.equal(false);
    });
});

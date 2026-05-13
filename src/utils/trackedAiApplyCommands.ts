/**
 * AI-related command IDs that should trigger the "next edit is AI" window.
 * Separate from AiContextExtractor (no vscode import) so mocha tests can validate matching.
 */

export const AI_COMMAND_PATTERNS = {
    completion: [
        'editor.action.inlineSuggest.commit',
        'editor.action.inlineSuggest.acceptNextWord',
        'editor.action.inlineSuggest.acceptNextLine',
        'claude.acceptCompletion',
        'claude.inline.accept',
        'anthropic.acceptCompletion',
        'cline.acceptCompletion',
    ],
    chatInline: [
        'inlineChat.accept',
        'inlineChat.acceptChanges',
        'github.copilot.inline.accept',
        'cursor.acceptDiff',
    ],
    chatPanel: [
        'github.copilot.chat.apply',
        'github.copilot.chat.insertAtCursor',
        'github.copilot.chat.insertIntoTerminal',
        'github.copilot.chat.keep',
        'github.copilot.chat.keepAll',
        'github.copilot.chat.keepChange',
        'workbench.action.chat.applyToEditor',
        'workbench.action.chat.apply',
        'workbench.action.chat.keep',
        'workbench.action.chat.keepAll',
        'composer.acceptAll',
        'composer.applyAll',
        'cursor.composer.applyAll',
        'cursor.aiChat.applyEdit',
        'cursor.applyEditAtCursor',
        'cursor.aiChat.acceptDiff',
        'cursor.applySearchAndReplace',
        'cursor.agent.applyAll',
        'cursor.applyCodeBlock',
        'cursor.applyGeneratedCode',
        'cursor.aiChat.keep',
        'cursor.composer.keepAll',
        'codeium.acceptSuggestion',
        'cline.acceptApproval',
        'cline.applyChanges',
        'claude-dev.acceptChanges',
        'anthropic.applyEdit',
        'anthropic.chat.acceptDiff',
        'claude.acceptCurrentDiff',
        'claude.chat.apply',
        'claude.chat.insert',
        'anthropic.chat.apply',
        'anthropic.chat.insert',
    ],
    chatSend: [
        'workbench.action.chat.submit',
        'github.copilot.chat.sendMessage',
        'workbench.action.chat.send',
        'github.copilot.chat.send',
        'github.copilot.chat.submit',
    ],
};

/** Command ids for inline ghost text (Copilot / Cursor Tab) — accepting them is product-default AI. */
export function isInlineGhostSuggestionCommand(commandId: string): boolean {
    const id = commandId.toLowerCase();
    return AI_COMMAND_PATTERNS.completion.some(p => id === p.toLowerCase());
}

/**
 * True when this command should open the "next edit is AI" window.
 * Must stay tighter than AiContextExtractor.isAiRelatedCommand to avoid unrelated editor IDs.
 */
export function matchesTrackedAiApplyCommand(commandId: string): boolean {
    const id = commandId.toLowerCase();
    const staticList = [
        ...AI_COMMAND_PATTERNS.completion,
        ...AI_COMMAND_PATTERNS.chatInline,
        ...AI_COMMAND_PATTERNS.chatPanel,
    ];
    if (staticList.some(p => id === p.toLowerCase())) {
        return true;
    }
    /**
     * Review UI “Keep” for AI-proposed diffs — IDs often omit “chat” (unified diff, inline edit review).
     */
    if (
        (id.includes('keep') || id.includes('keepall') || id.includes('keep-all')) &&
        (id.includes('diff') || id.includes('multidiff') || id.includes('multi-diff'))
    ) {
        return true;
    }
    if (id.startsWith('workbench.action.chat.') &&
        (id.includes('apply') || id.includes('accept') || id.includes('insert') || id.includes('keep') ||
            id.includes('acceptall') || id.includes('accept-all'))) {
        return true;
    }
    if ((id.includes('multidiff') || id.includes('multi-diff')) &&
        (id.includes('accept') || id.includes('apply') || id.includes('keep') || id.includes('save'))) {
        return true;
    }
    if ((id.includes('claude') || id.includes('anthropic') || id.includes('cline')) &&
        (id.includes('completion') || id.includes('inline') || id.includes('suggest') || id.includes('tab')) &&
        (id.includes('accept') || id.includes('commit') || id.includes('insert'))) {
        return true;
    }
    if ((id.includes('claude') || id.includes('anthropic') || id.includes('cline')) &&
        (id.includes('apply') || id.includes('accept') || id.includes('insert') || id.includes('keep') ||
            id.includes('create') || id.includes('file'))) {
        return true;
    }
    if (id.includes('chat') &&
        (id.includes('apply') || id.includes('accept') || id.includes('insert') || id.includes('keep') ||
            id.includes('createfile') || id.includes('writefile'))) {
        return true;
    }
    if (id.includes('composer') && (id.includes('apply') || id.includes('accept') || id.includes('keep'))) {
        return true;
    }
    if (id.startsWith('inlinechat.') && id.includes('keep')) {
        return true;
    }

    /** Cursor: agent (local / cloud / background) and Composer — built-in IDs change between releases. */
    if (id.startsWith('cursor.')) {
        const applyLike =
            id.includes('apply') ||
            id.includes('accept') ||
            id.includes('keep') ||
            id.includes('approve') ||
            id.includes('commit');
        const agentSurface =
            id.includes('agent') ||
            id.includes('composer') ||
            id.includes('aichat') ||
            id.includes('chat') ||
            id.includes('cloud') ||
            id.includes('background') ||
            /\bgh\b/.test(id) ||
            id.includes('github') ||
            id.includes('cli') ||
            id.includes('inlineedit') ||
            id.includes('inline-edit') ||
            id.includes('nextedit') ||
            id.includes('next-edit');
        if (applyLike && agentSurface) {
            return true;
        }
    }

    /** GitHub Copilot — chat apply / edits / agent paths beyond the static list. */
    if (
        id.startsWith('github.copilot.') &&
        (id.includes('apply') || id.includes('accept') || id.includes('insert') || id.includes('keep')) &&
        !id.includes('toggle') &&
        !id.includes('signin')
    ) {
        return true;
    }

    /** Built-in Chat Agents (tool / code edits) — IDs vary by VS Code version. */
    if (id.startsWith('workbench.action.chat.')) {
        if (
            id.includes('tool') ||
            id.includes('edits') ||
            id.includes('workspaceedit') ||
            id.includes('codebase')
        ) {
            if (id.includes('apply') || id.includes('accept') || id.includes('insert') || id.includes('keep')) {
                return true;
            }
        }
    }

    /**
     * Last-resort: chat / agent / Cursor / Copilot surface + apply-like verb.
     * Catches new product command IDs between releases (main cause of “chat apply → Human”).
     */
    if (
        looksBroadChatAgentSurface(id) &&
        looksChatApplyLikeIntent(id) &&
        !isBroadChatApplyExcluded(id)
    ) {
        return true;
    }

    return false;
}

function looksBroadChatAgentSurface(id: string): boolean {
    return (
        id.includes('chat') ||
        id.includes('composer') ||
        id.includes('copilot') ||
        id.includes('inlinechat') ||
        id.includes('agent') ||
        id.startsWith('cursor.') ||
        id.includes('anthropic') ||
        id.includes('claude') ||
        id.includes('cline') ||
        id.includes('codeium') ||
        id.startsWith('workbench.action.chat') ||
        id.startsWith('composer.') ||
        id.includes('aichat') ||
        id.includes('inlineedit') ||
        id.includes('inline-edit') ||
        id.includes('nextedit') ||
        id.includes('next-edit')
    );
}

function looksChatApplyLikeIntent(id: string): boolean {
    if (
        id.includes('apply') ||
        id.includes('accept') ||
        id.includes('keep') ||
        id.includes('insert') ||
        id.includes('approve')
    ) {
        return true;
    }
    /** e.g. composer “commit” of AI-proposed edits — still a chat/composer surface-only */
    if (
        id.includes('commit') &&
        (id.includes('chat') || id.includes('composer') || id.includes('copilot') || id.startsWith('cursor.'))
    ) {
        return true;
    }
    return false;
}

function isBroadChatApplyExcluded(id: string): boolean {
    if (id.startsWith('git.') || id.startsWith('gitlens.')) {
        return true;
    }
    if (id.includes('signin') || id.includes('sign-in')) {
        return true;
    }
    if (id.includes('discard') || id.includes('reject') || id.includes('cancel')) {
        return true;
    }
    if (id.includes('scm.') && id.includes('commit')) {
        return true;
    }
    return false;
}

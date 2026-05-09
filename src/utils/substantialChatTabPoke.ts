import * as vscode from 'vscode';

/** Matches extension.ts / ChangeTracker “large streaming apply” thresholds. */
export function summarizeSubstantialInsert(contentChanges: readonly vscode.TextDocumentContentChangeEvent[]): {
    insertLen: number;
    maxChunk: number;
    newlineRuns: number;
    substantial: boolean;
} {
    let insertLen = 0;
    let maxChunk = 0;
    let newlineRuns = 0;
    for (const c of contentChanges) {
        insertLen += c.text.length;
        maxChunk = Math.max(maxChunk, c.text.length);
        newlineRuns += (c.text.match(/\n/g) || []).length;
    }
    const substantial =
        insertLen >= 72 ||
        (insertLen >= 40 && newlineRuns >= 2) ||
        (maxChunk >= 56 && newlineRuns >= 1);
    return { insertLen, maxChunk, newlineRuns, substantial };
}

export function tabLooksAiChat(tab: vscode.Tab): boolean {
    const label = typeof tab.label === 'string' ? tab.label.toLowerCase() : '';
    const hints = [
        'chat', 'composer', 'agent', 'claude', 'cline', 'copilot', 'cursor',
        'cloud', 'background', 'gh ', 'cli', 'github',
    ];
    return hints.some(h => label.includes(h));
}

/** Any tab open that looks like Chat / Composer / Agent (foreground optional). */
export function anyChatLikeTabOpen(): boolean {
    try {
        for (const g of vscode.window.tabGroups.all) {
            for (const tab of g.tabs) {
                if (tab && tabLooksAiChat(tab)) {
                    return true;
                }
            }
        }
    } catch {
        /* Tab API unavailable in minimal hosts */
    }
    return false;
}

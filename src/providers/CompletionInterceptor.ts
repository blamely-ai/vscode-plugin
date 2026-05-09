import * as vscode from 'vscode';
import { TraceStore } from '../store/TraceStore';
import { blameFileKey } from '../utils/WorkspacePaths';
import * as Logger from '../utils/Logger';

const CONTEXT_LINES = 5;

export class CompletionInterceptor implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private traceStore: TraceStore;

    constructor(traceStore: TraceStore) {
        Logger.completionDebug('track: constructor — CompletionInterceptor');
        this.traceStore = traceStore;
        this.register();
        Logger.completionDebug('track: constructor — register finished');
    }

    private register(): void {
        Logger.completionDebug('track: register — starting CompletionInterceptor.register()');
        // Register a proxy InlineCompletionItemProvider for all files
        const provider: vscode.InlineCompletionItemProvider = {
            provideInlineCompletionItems: async (
                document: vscode.TextDocument,
                position: vscode.Position,
                context: vscode.InlineCompletionContext,
                token: vscode.CancellationToken
            ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> => {
                const uriStr = document.uri.toString();
                const lang = document.languageId;
                const trigger = context.triggerKind;
                const selected = context.selectedCompletionInfo
                    ? `selected len=${context.selectedCompletionInfo.text.length} range=${context.selectedCompletionInfo.range.start.line}:${context.selectedCompletionInfo.range.start.character}-${context.selectedCompletionInfo.range.end.line}:${context.selectedCompletionInfo.range.end.character}`
                    : 'no selectedCompletionInfo';
                Logger.completionDebug(
                    `track: provideInlineCompletionItems — uri=${uriStr} lang=${lang} line=${position.line} col=${position.character} ` +
                        `triggerKind=${trigger} ${selected} cancelled=${token.isCancellationRequested}`
                );
                // We don't provide our own completions — we intercept from registered providers
                // The actual interception happens by monitoring accepted completions via ChangeTracker
                Logger.completionDebug('track: provideInlineCompletionItems — return undefined (proxy only)');
                return undefined;
            }
        };

        const disposable = vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**/*' },
            provider
        );
        this.disposables.push(disposable);
        Logger.completionDebug('track: register — registerInlineCompletionItemProvider(**/*) attached');

        // Monitor completion events from known providers
        this.monitorProviders();
        Logger.completionDebug('track: register — monitorProviders done');
    }

    private monitorProviders(): void {
        Logger.completionDebug('track: monitorProviders — start');
        // Check for Copilot
        const copilot = vscode.extensions.getExtension('github.copilot');
        if (copilot) {
            Logger.info('GitHub Copilot detected');
            Logger.completionDebug(
                `track: monitorProviders — github.copilot present active=${copilot.isActive}`
            );
        } else {
            Logger.completionDebug('track: monitorProviders — github.copilot not installed');
        }

        // Check for Cursor
        const cursor = vscode.extensions.getExtension('cursor.cursor');
        if (cursor) {
            Logger.info('Cursor AI detected');
            Logger.completionDebug(
                `track: monitorProviders — cursor.cursor present active=${cursor.isActive}`
            );
        } else {
            Logger.completionDebug('track: monitorProviders — cursor.cursor not installed');
        }

        // Listen for extension activations to detect late-loading providers
        const activationDisposable = vscode.extensions.onDidChange(() => {
            Logger.completionDebug('track: onDidChangeExtensions — detectNewProviders');
            this.detectNewProviders();
        });
        this.disposables.push(activationDisposable);
        Logger.completionDebug('track: monitorProviders — onDidChangeExtensions listener registered');
    }

    private detectNewProviders(): void {
        const copilot = vscode.extensions.getExtension('github.copilot');
        if (copilot?.isActive) {
            Logger.info('GitHub Copilot activated');
            Logger.completionDebug('track: detectNewProviders — GitHub Copilot is now active');
        } else {
            Logger.completionDebug(
                `track: detectNewProviders — copilot state exists=${!!copilot} active=${copilot?.isActive ?? false}`
            );
        }
    }

    /**
     * Called by ChangeTracker when a completion appears to have been offered.
     * Records the suggestion in the trace store.
     */
    recordSuggestion(
        document: vscode.TextDocument,
        position: vscode.Position,
        suggestedText: string,
        providerId: string
    ): string {
        Logger.completionDebug(
            `track: recordSuggestion — enter providerId=${providerId} uri=${document.uri.toString()} ` +
                `line=${position.line} col=${position.character} textLen=${suggestedText.length}`
        );
        const relativePath = blameFileKey(document.uri);

        const lineEnd = position.line + suggestedText.split('\n').length - 1;

        // Get context before cursor
        const contextStart = Math.max(0, position.line - CONTEXT_LINES);
        const contextBefore = document.getText(
            new vscode.Range(contextStart, 0, position.line, position.character)
        );
        Logger.completionDebug(
            `track: recordSuggestion — relativePath=${relativePath} lineEnd1Based=${lineEnd + 1} contextBeforeLen=${contextBefore.length}`
        );

        const record = this.traceStore.addSuggestion(
            relativePath,
            position.line + 1, // 1-indexed
            lineEnd + 1,
            position.character,
            position.character + suggestedText.length,
            suggestedText,
            providerId,
            contextBefore
        );

        Logger.info(`Suggestion recorded: ${record.suggestion_id.slice(0, 8)} from ${providerId}`);
        Logger.completionDebug(
            `track: recordSuggestion — stored suggestion_id=${record.suggestion_id.slice(0, 8)}…`
        );
        return record.suggestion_id;
    }

    dispose(): void {
        Logger.completionDebug('track: dispose — CompletionInterceptor disposing');
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

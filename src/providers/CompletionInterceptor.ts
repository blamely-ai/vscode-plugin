import * as vscode from 'vscode';
import { TraceStore } from '../store/TraceStore';
import { normalizePath } from '../utils/Platform';
import * as Logger from '../utils/Logger';

const CONTEXT_LINES = 5;

export class CompletionInterceptor implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private traceStore: TraceStore;

    constructor(traceStore: TraceStore) {
        this.traceStore = traceStore;
        this.register();
    }

    private register(): void {
        // Register a proxy InlineCompletionItemProvider for all files
        const provider: vscode.InlineCompletionItemProvider = {
            provideInlineCompletionItems: async (
                document: vscode.TextDocument,
                position: vscode.Position,
                context: vscode.InlineCompletionContext,
                token: vscode.CancellationToken
            ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> => {
                // We don't provide our own completions — we intercept from registered providers
                // The actual interception happens by monitoring accepted completions via ChangeTracker
                return undefined;
            }
        };

        const disposable = vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**/*' },
            provider
        );
        this.disposables.push(disposable);

        // Monitor completion events from known providers
        this.monitorProviders();
    }

    private monitorProviders(): void {
        // Check for Copilot
        const copilot = vscode.extensions.getExtension('github.copilot');
        if (copilot) {
            Logger.info('GitHub Copilot detected');
        }

        // Check for Cursor
        const cursor = vscode.extensions.getExtension('cursor.cursor');
        if (cursor) {
            Logger.info('Cursor AI detected');
        }

        // Listen for extension activations to detect late-loading providers
        const activationDisposable = vscode.extensions.onDidChange(() => {
            this.detectNewProviders();
        });
        this.disposables.push(activationDisposable);
    }

    private detectNewProviders(): void {
        const copilot = vscode.extensions.getExtension('github.copilot');
        if (copilot?.isActive) {
            Logger.info('GitHub Copilot activated');
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
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const relativePath = workspaceFolder
            ? normalizePath(vscode.workspace.asRelativePath(document.uri, false))
            : normalizePath(document.uri.fsPath);

        const lineEnd = position.line + suggestedText.split('\n').length - 1;

        // Get context before cursor
        const contextStart = Math.max(0, position.line - CONTEXT_LINES);
        const contextBefore = document.getText(
            new vscode.Range(contextStart, 0, position.line, position.character)
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
        return record.suggestion_id;
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

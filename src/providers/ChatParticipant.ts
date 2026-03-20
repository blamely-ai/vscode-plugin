import * as vscode from 'vscode';
import { TraceStore } from '../store/TraceStore';
import { BlameMap } from '../blame/BlameMap';
import { normalizePath } from '../utils/Platform';
import * as Logger from '../utils/Logger';

export class ChatParticipant implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private traceStore: TraceStore;
    private blameMap: BlameMap;
    private onBlameUpdated: () => void;

    constructor(traceStore: TraceStore, blameMap: BlameMap, onBlameUpdated: () => void) {
        this.traceStore = traceStore;
        this.blameMap = blameMap;
        this.onBlameUpdated = onBlameUpdated;
        this.register();
    }

    private register(): void {
        try {
            if (typeof vscode.chat === 'undefined' || typeof vscode.chat.createChatParticipant !== 'function') {
                Logger.info('Chat Participant API not available in this VS Code version');
                return;
            }

            const participant = vscode.chat.createChatParticipant(
                'blamely.ai',
                (request, context, response, token) => this.handleChatRequest(request, context, response, token)
            );

            participant.iconPath = vscode.Uri.joinPath(
                vscode.extensions.getExtension('blamely.blamely')?.extensionUri ||
                vscode.Uri.file(''),
                'images', 'icon.png'
            );

            this.disposables.push(participant);
            Logger.info('Blamely Chat Participant registered (@blamely)');
        } catch (err) {
            Logger.warn(`Failed to register Chat Participant: ${err}`);
        }
    }

    private async handleChatRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<void> {
        const userPrompt = request.prompt;
        const modelId = request.model?.id || 'unknown';
        const modelName = request.model?.name || 'unknown';
        const modelVendor = (request.model as any)?.vendor || 'unknown';
        const fullModelName = `${modelVendor}/${modelName}`;

        Logger.info(`@blamely prompt: "${userPrompt}" | model: ${fullModelName}`);

        // Get the active editor context for file attribution
        const editor = vscode.window.activeTextEditor;
        let filePath = 'unknown';
        let startLine = 1;

        if (editor) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            filePath = workspaceFolder
                ? normalizePath(vscode.workspace.asRelativePath(editor.document.uri, false))
                : normalizePath(editor.document.uri.fsPath);
            startLine = editor.selection.active.line + 1; // 1-indexed
        }

        // Record the suggestion with full prompt and model info BEFORE sending to AI
        const record = this.traceStore.addSuggestion(
            filePath,
            startLine,
            startLine, // Will be updated after we know how many lines were generated
            0,
            0,
            '', // Will be updated with the generated text
            'blamely_chat_participant',
            '',
            fullModelName,
            userPrompt
        );

        // Forward the request to the selected language model
        let generatedText = '';
        try {
            const chatResponse = await request.model.sendRequest(
                [vscode.LanguageModelChatMessage.User(userPrompt)],
                {},
                token
            );

            for await (const chunk of chatResponse.text) {
                response.markdown(chunk);
                generatedText += chunk;
            }
        } catch (err) {
            if (err instanceof vscode.LanguageModelError) {
                response.markdown(`⚠️ Model error: ${err.message}`);
            } else {
                response.markdown(`⚠️ Error: ${err}`);
            }
            Logger.warn(`Chat model error: ${err}`);
            return;
        }

        // Update the suggestion record with the final generated text
        this.traceStore.markAccepted(record.suggestion_id, generatedText);

        // Calculate how many lines were generated
        const generatedLines = generatedText.split('\n').length;
        const endLine = startLine + generatedLines - 1;

        // Set blame for the generated lines
        if (editor && generatedText.length > 0) {
            this.blameMap.setAttribute(
                filePath,
                startLine,
                endLine,
                'AI',
                'blamely_chat_participant',
                fullModelName,
                userPrompt,
                'chat_panel',
                undefined,
                generatedText.length
            );

            this.onBlameUpdated();
        }

        Logger.info(`@blamely generated ${generatedLines} lines via ${fullModelName} for ${filePath}`);
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

import * as vscode from 'vscode';
import { TraceStore } from '../store/TraceStore';
import { BlameMap } from '../blame/BlameMap';
import { blameFileKey } from '../utils/WorkspacePaths';
import * as Logger from '../utils/Logger';
import { chatPanelSignal } from '../utils/chatPanelSignal';
import { codingTypeForTextInsert, isEmptyLineInsertText } from './editAttributionHeuristics';

const LM_PREVIEW_CHARS = 600;

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
                console.log(
                    '[Blamely][chat-traffic] vscode.chat / createChatParticipant unavailable — @Blamely LM logging disabled. ' +
                        'Native Cursor chat is not hooked here; attribution uses editor-change heuristics + AI-host poke.'
                );
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

        // Get the active editor context for file attribution
        const editor = vscode.window.activeTextEditor;
        let filePath = 'unknown';
        let startLine = 1;

        if (editor) {
            filePath = blameFileKey(editor.document.uri);
            startLine = editor.selection.active.line + 1; // 1-indexed
        }

        console.log('[Blamely][chat-panel]', {
            phase: 'lm-request',
            source: '@blamely.participant',
            prompt: userPrompt,
            modelId,
            modelName,
            modelVendor,
            fullModelName,
            filePath,
            startLine,
        });
        chatPanelSignal('participant-lm-request', {
            source: '@blamely',
            model: fullModelName,
            promptChars: userPrompt.length,
            promptPreview:
                userPrompt.length <= LM_PREVIEW_CHARS
                    ? userPrompt
                    : `${userPrompt.slice(0, LM_PREVIEW_CHARS)}… (+${userPrompt.length - LM_PREVIEW_CHARS} chars)`,
            filePath,
            startLine,
        });
        console.log('[Blamely][chat-traffic] @blamely LM request', {
            model: fullModelName,
            promptChars: userPrompt.length,
            promptPreview:
                userPrompt.length <= LM_PREVIEW_CHARS
                    ? userPrompt
                    : `${userPrompt.slice(0, LM_PREVIEW_CHARS)}…`,
            filePath,
            startLine,
        });
        const logTraffic =
            vscode.workspace.getConfiguration('blamely').get<boolean>('logChatPanelMessages') ?? false;
        if (logTraffic) {
            console.log(
                `Blamely [chat-send] @blamely participant prompt=${JSON.stringify(userPrompt)} model=${fullModelName}`
            );
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
            chatPanelSignal('participant-lm-response-error', {
                source: '@blamely',
                model: fullModelName,
                error: err instanceof Error ? err.message : String(err),
                languageModelError: err instanceof vscode.LanguageModelError,
            });
            console.log('[Blamely][chat-traffic] @blamely LM error', {
                model: fullModelName,
                error: err instanceof Error ? err.message : String(err),
            });
            const logTrafficErr =
                vscode.workspace.getConfiguration('blamely').get<boolean>('logChatPanelMessages') ?? false;
            if (logTrafficErr) {
                console.log(
                    `Blamely [chat-response-error] @blamely participant model=${fullModelName} error=${JSON.stringify(
                        err instanceof Error ? err.message : String(err)
                    )}`
                );
            }
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
        const previewLimit = 4000;
        console.log('[Blamely][chat-panel]', {
            phase: 'lm-response',
            source: '@blamely.participant',
            fullModelName,
            charLength: generatedText.length,
            lineCount: generatedLines,
            previewTruncated: generatedText.length > previewLimit,
            textPreview:
                generatedText.length <= previewLimit
                    ? generatedText
                    : `${generatedText.slice(0, previewLimit)}\n… (+${generatedText.length - previewLimit} chars)`,
        });
        const trafficRespPreview =
            generatedText.length <= LM_PREVIEW_CHARS
                ? generatedText
                : `${generatedText.slice(0, LM_PREVIEW_CHARS)}… (+${generatedText.length - LM_PREVIEW_CHARS} chars)`;
        chatPanelSignal('participant-lm-response', {
            source: '@blamely',
            model: fullModelName,
            chars: generatedText.length,
            lines: generatedLines,
            textPreview: trafficRespPreview,
        });
        console.log('[Blamely][chat-traffic] @blamely LM response', {
            model: fullModelName,
            chars: generatedText.length,
            lines: generatedLines,
            textPreview: trafficRespPreview,
        });

        const logTrafficAfter =
            vscode.workspace.getConfiguration('blamely').get<boolean>('logChatPanelMessages') ?? false;
        if (logTrafficAfter) {
            if (generatedText.length > 0) {
                const preview =
                    generatedText.length <= previewLimit
                        ? generatedText
                        : `${generatedText.slice(0, previewLimit)}\n… (+${generatedText.length - previewLimit} chars)`;
                console.log(
                    `Blamely [chat-response] @blamely participant model=${fullModelName} chars=${generatedText.length} lines=${generatedLines} text=${JSON.stringify(preview)}`
                );
            } else {
                console.log(
                    `Blamely [chat-response] @blamely participant model=${fullModelName} chars=0 lines=0 (empty reply)`
                );
            }
        }

        const endLine = startLine + generatedLines - 1;

        // Set blame for the generated lines
        if (editor && generatedText.length > 0) {
            const chatInsertCoding = codingTypeForTextInsert(
                generatedText,
                isEmptyLineInsertText(generatedText)
            );
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
                generatedText.length,
                undefined,
                chatInsertCoding
            );

            this.onBlameUpdated();
        }

        console.log('[Blamely][chat-traffic] @blamely generated lines applied to blame', {
            lines: generatedLines,
            model: fullModelName,
            filePath,
        });
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

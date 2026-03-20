import * as vscode from 'vscode';
import * as Logger from './Logger';

export interface AiContext {
    prompt: string | null;
    model: string | null;
    provider: string | null;
    interactionType: string | null;
}

const EXTENSION_TO_PROVIDER: Record<string, string> = {
    'github.copilot': 'github-copilot',
    'github.copilot-chat': 'github-copilot',
    'codeium.codeium': 'codeium',
    'codeium.windsurf': 'codeium',
    'tabnine.tabnine-vscode': 'tabnine',
    'supermaven.supermaven': 'supermaven',
    'amazonwebservices.aws-toolkit-vscode': 'amazon-q',
    'amazonwebservices.amazon-q-vscode': 'amazon-q',
    'continue.continue': 'continue',
    'codegpt.codegpt': 'codegpt',
    'cursor.cursor': 'cursor',
};

const KNOWN_MODEL_PATTERNS = [
    'gpt-5', 'gpt-4', 'gpt-3.5', 'gpt5', 'gpt4', 'gpt3', 'gpt-4o', 'gpt4o', '4o',
    'gpt-5.1', 'gpt-5.2', 'gpt-5.3', 'gpt-5.4', 'gpt-4.1', '5.1-codex', '5.2-codex', '5.3-codex', 'codex',
    'claude', 'opus', 'sonnet', 'haiku', '4.5', '4.6', '2.5', '3 flash', '3 pro',
    'gemini', 'palm',
    'codellama', 'llama', 'mixtral', 'mistral',
    'deepseek', 'starcoder', 'codestral',
    'o1-mini', 'o1-preview', 'o3-mini', 'o3', 'o4-mini',
    'chatgpt', 'mini', 'grok', 'preview',
];

let cachedModel: string | null = null;
let cachedModelTimestamp = 0;
const MODEL_CACHE_TTL_MS = 30_000;

/**
 * Detects the active AI model using the VS Code Language Model API and installed extensions.
 * Mirrors IntelliJ AiContextExtractor: tries API first, then extension settings, then heuristics.
 */
export async function detectModel(): Promise<string | null> {
    const now = Date.now();
    if (cachedModel && now - cachedModelTimestamp < MODEL_CACHE_TTL_MS) {
        return cachedModel;
    }

    const model =
        (await tryLanguageModelApi()) ??
        tryExtensionSettings() ??
        tryAppNameHeuristic();

    if (model) {
        cachedModel = sanitizeModelForReport(model);
        cachedModelTimestamp = now;
    }
    return cachedModel;
}

/** Detect which AI providers are installed and active. */
export function detectProvider(): string | null {
    if (vscode.env.appName.toLowerCase().includes('cursor')) {
        return 'cursor';
    }
    for (const [extId, provider] of Object.entries(EXTENSION_TO_PROVIDER)) {
        const ext = vscode.extensions.getExtension(extId);
        if (ext) return provider;
    }
    return null;
}

/**
 * Detect all installed AI providers (there can be multiple).
 * Returns provider names sorted by priority.
 */
export function detectAllProviders(): string[] {
    const providers: string[] = [];
    if (vscode.env.appName.toLowerCase().includes('cursor')) {
        providers.push('cursor');
    }
    for (const [extId, provider] of Object.entries(EXTENSION_TO_PROVIDER)) {
        const ext = vscode.extensions.getExtension(extId);
        if (ext && !providers.includes(provider)) {
            providers.push(provider);
        }
    }
    return providers;
}

/**
 * Determine interaction type based on contextual clues.
 * Mirrors IntelliJ detectInteractionType(): chat_inline, chat_panel, completion.
 */
export function detectInteractionType(commandId?: string): string | null {
    if (!commandId) return null;
    const id = commandId.toLowerCase();

    if (id.includes('inline') && (id.includes('chat') || id.includes('edit'))) return 'chat_inline';
    if (id.includes('chat') || id.includes('panel')) return 'chat_panel';
    if (id.includes('completion') || id.includes('inlay') || id.includes('suggest') || id.includes('tab')) return 'completion';
    if (id.includes('apply') || id.includes('accept') || id.includes('insert')) {
        if (id.includes('chat') || id.includes('copilot') || id.includes('ai') || id.includes('cursor')) {
            return 'chat_panel';
        }
        return 'completion';
    }
    return 'unknown';
}

/**
 * Full context extraction - combines model, provider, interaction type.
 * Call this when an AI action is detected.
 */
export async function extract(commandId?: string): Promise<AiContext> {
    const provider = detectProvider();
    const model = await detectModel();
    const interactionType = detectInteractionType(commandId);
    return { prompt: null, model, provider, interactionType };
}

/** Map an extension ID to a clean provider name. */
export function resolveProviderName(rawId: string | null): string {
    if (!rawId) return 'unknown';
    const lower = rawId.toLowerCase();
    for (const [extId, provider] of Object.entries(EXTENSION_TO_PROVIDER)) {
        if (lower.includes(extId) || lower.includes(provider)) return provider;
    }
    if (lower.includes('copilot')) return 'github-copilot';
    if (lower.includes('cursor')) return 'cursor';
    if (lower.includes('codeium')) return 'codeium';
    if (lower.includes('tabnine')) return 'tabnine';
    return rawId;
}

/**
 * Sanitize a model name: reject package/class names, trim, validate.
 * Mirrors IntelliJ AiContextExtractor.sanitizeModelForReport().
 */
export function sanitizeModelForReport(model: string | null): string | null {
    if (!model || model.trim().length < 2) return null;
    const trimmed = model.trim();
    if (looksLikePackageName(trimmed)) return null;
    return trimmed;
}

function looksLikePackageName(s: string): boolean {
    const lower = s.toLowerCase();
    if (lower.includes('com.') || lower.includes('org.') || lower.includes('net.')) return true;
    if (/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(lower)) return true;
    return false;
}

/** Check if a string looks like a known model name. */
export function looksLikeModelName(s: string): boolean {
    const lower = s.toLowerCase();
    return KNOWN_MODEL_PATTERNS.some(p => lower.includes(p));
}

// --- Private detection strategies ---

async function tryLanguageModelApi(): Promise<string | null> {
    try {
        if (typeof vscode.lm === 'undefined' || typeof vscode.lm.selectChatModels !== 'function') {
            return null;
        }
        const models = await vscode.lm.selectChatModels();
        if (!models || models.length === 0) return null;

        // Prefer models from known AI providers
        for (const m of models) {
            const fullName = buildModelName(m);
            if (looksLikeModelName(fullName)) return fullName;
        }
        // Fall back to first model
        return buildModelName(models[0]);
    } catch (err) {
        Logger.warn(`Could not query language model API: ${err}`);
        return null;
    }
}

function buildModelName(m: { id: string; vendor?: string; family?: string; version?: string; name?: string }): string {
    const parts: string[] = [];
    if (m.vendor) parts.push(m.vendor);
    if (m.family) parts.push(m.family);
    if (m.version) parts.push(m.version);
    if (parts.length > 0) return parts.join('/');
    if (m.name) return m.name;
    return m.id;
}

function tryExtensionSettings(): string | null {
    try {
        const copilotConfig = vscode.workspace.getConfiguration('github.copilot');
        const chatModel = copilotConfig.get<string>('chat.model') ?? copilotConfig.get<string>('selectedModel');
        if (chatModel && chatModel.trim().length > 2) return chatModel.trim();
    } catch { /* ignore */ }

    try {
        const cursorConfig = vscode.workspace.getConfiguration('cursor');
        const model = cursorConfig.get<string>('model') ?? cursorConfig.get<string>('aiModel');
        if (model && model.trim().length > 2) return model.trim();
    } catch { /* ignore */ }

    return null;
}

function tryAppNameHeuristic(): string | null {
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('cursor')) return 'cursor-ai';
    const copilot = vscode.extensions.getExtension('github.copilot');
    if (copilot) return 'github-copilot';
    return null;
}

/**
 * AI-related command IDs/patterns that should trigger markNextChangeAsAi.
 * Mirrors IntelliJ isAiRelatedAction + isChatPanelApplyCommand + isChatSendCommand.
 */
export const AI_COMMAND_PATTERNS = {
    completion: [
        'editor.action.inlineSuggest.commit',
        'editor.action.inlineSuggest.acceptNextWord',
        'editor.action.inlineSuggest.acceptNextLine',
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
        'workbench.action.chat.applyToEditor',
        'workbench.action.chat.apply',
        'cursor.applyCodeBlock',
        'cursor.applyGeneratedCode',
        'codeium.acceptSuggestion',
    ],
    chatSend: [
        'workbench.action.chat.submit',
        'github.copilot.chat.sendMessage',
        'workbench.action.chat.send',
    ],
};

/** Returns true if the given command ID is AI-related. */
export function isAiRelatedCommand(commandId: string): boolean {
    const id = commandId.toLowerCase();
    const allPatterns = [
        ...AI_COMMAND_PATTERNS.completion,
        ...AI_COMMAND_PATTERNS.chatInline,
        ...AI_COMMAND_PATTERNS.chatPanel,
    ];
    if (allPatterns.some(p => id === p.toLowerCase())) return true;
    if (id.includes('copilot') || id.includes('codeium') || id.includes('tabnine') || id.includes('cursor')) {
        if (id.includes('accept') || id.includes('apply') || id.includes('insert') || id.includes('commit')) {
            return true;
        }
    }
    if (id.includes('inlinecompletion') || id.includes('inline.completion')) return true;
    if (id.includes('inline') && id.includes('suggest')) return true;
    return false;
}

/** Returns true if the given command is a chat send/submit action. */
export function isChatSendCommand(commandId: string): boolean {
    const id = commandId.toLowerCase();
    return AI_COMMAND_PATTERNS.chatSend.some(p => id === p.toLowerCase())
        || ((id.includes('chat') || id.includes('copilot') || id.includes('cursor'))
            && (id.includes('send') || id.includes('submit') || id.includes('ask')));
}

/** Duration for the markNextChangeAsAi window depending on interaction type. */
export function getAiWindowDuration(interactionType: string | null): number {
    switch (interactionType) {
        case 'chat_panel': return 15_000;
        case 'chat_inline': return 8_000;
        case 'completion': return 2_000;
        default: return 3_000;
    }
}

/** Invalidate cached model (e.g. when settings change). */
export function invalidateModelCache(): void {
    cachedModel = null;
    cachedModelTimestamp = 0;
}

import * as vscode from 'vscode';
import * as Logger from './Logger';
import { sanitizeModelForReport } from './modelSanitize';
import { AI_COMMAND_PATTERNS } from './trackedAiApplyCommands';
import { extensionIdLooksAiCodingAssistant } from './aiAssistantExtensionHint';

export { AI_COMMAND_PATTERNS, matchesTrackedAiApplyCommand, isInlineGhostSuggestionCommand } from './trackedAiApplyCommands';
export { extensionIdLooksAiCodingAssistant } from './aiAssistantExtensionHint';

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
    'anthropic.claude-code': 'anthropic-claude',
    'anthropic.claude': 'anthropic-claude',
    'saoudrizwan.claude-dev': 'anthropic-claude',
    'cline.cline': 'anthropic-claude',
};

let aiCodingAssistantHostCache: { checkedAtMs: number; value: boolean } | null = null;
const AI_CODING_ASSISTANT_HOST_CACHE_MS = 45_000;

export function invalidateAiCodingAssistantHostCache(): void {
    aiCodingAssistantHostCache = null;
}

/**
 * Whether this VS Code / Cursor host likely has an AI coding assistant (Copilot Chat, Claude panel, etc.).
 * Used for sidebar-stream attribution where chat is not a vscode.Tab and command hooks may be missing.
 *
 * Order: cheap signals first, then {@link detectAllProviders}, then a substring scan of all extensions.
 */
export function anyAiCodingAssistantHostDetected(): boolean {
    const now = Date.now();
    const cached = aiCodingAssistantHostCache;
    if (cached) {
        /** Negative results re-checked sooner — Copilot/lm may activate after first extension tick. */
        const ttlMs = cached.value ? AI_CODING_ASSISTANT_HOST_CACHE_MS : 5_000;
        if (now - cached.checkedAtMs < ttlMs) {
            return cached.value;
        }
    }

    let value = false;
    if (typeof vscode.lm !== 'undefined') {
        /** Stock VS Code: Copilot Chat / built-in LM surface */
        value = true;
    } else if (vscode.env.appName.toLowerCase().includes('cursor')) {
        value = true;
    } else if (detectAllProviders().length > 0) {
        value = true;
    } else {
        try {
            value = vscode.extensions.all.some((ext) => extensionIdLooksAiCodingAssistant(ext.id));
        } catch {
            value = false;
        }
    }

    aiCodingAssistantHostCache = { checkedAtMs: now, value };
    return value;
}

/** Structured provider-detection logs for Debug Console (expand objects in DevTools). */
function logProviderConsole(payload: Record<string, unknown>): void {
    console.log('[Blamely][provider]', payload);
}

let lastDetectProviderSignature = '';

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

/** Safe subset of extension package.json for provider-detection logs. */
function extensionPackageSummaryForLog(extId: string): Record<string, unknown> | undefined {
    try {
        const ext = vscode.extensions.getExtension(extId);
        if (!ext?.packageJSON) {
            return undefined;
        }
        const p = ext.packageJSON as Record<string, unknown>;
        const desc = typeof p.description === 'string' ? p.description.trim() : '';
        const previewCap = 360;
        return {
            id: extId,
            version: p.version,
            name: p.name,
            displayName: p.displayName,
            publisher: p.publisher,
            isActive: ext.isActive,
            descriptionPreview:
                desc.length === 0 ? undefined : desc.length <= previewCap ? desc : `${desc.slice(0, previewCap)}…`,
        };
    } catch {
        return undefined;
    }
}

/** Detect which AI providers are installed and active. */
export function detectProvider(): string | null {
    let result: string | null = null;
    let matchedVia: 'appName' | 'extension' | 'none' = 'none';
    let matchedExtId: string | undefined;

    if (vscode.env.appName.toLowerCase().includes('cursor')) {
        result = 'cursor';
        matchedVia = 'appName';
    } else {
        for (const [extId, provider] of Object.entries(EXTENSION_TO_PROVIDER)) {
            const ext = vscode.extensions.getExtension(extId);
            if (ext) {
                result = provider;
                matchedVia = 'extension';
                matchedExtId = extId;
                break;
            }
        }
    }

    const sig = `${result ?? 'null'}|${matchedVia}|${matchedExtId ?? ''}`;
    if (sig !== lastDetectProviderSignature) {
        lastDetectProviderSignature = sig;
        const matchedExtension =
            matchedExtId !== undefined ? extensionPackageSummaryForLog(matchedExtId) : undefined;
        const detail = {
            fn: 'detectProvider',
            result,
            matchedVia,
            matchedExtId,
            appName: vscode.env.appName,
            remoteName: vscode.env.remoteName || undefined,
            vscodeLmDefined: typeof vscode.lm !== 'undefined',
            /** Extension manifest subset + description preview (no HTTP — host-local detection only). */
            content: {
                matchedExtension,
                cursorHost: matchedVia === 'appName' && result === 'cursor',
            },
        };
        logProviderConsole(detail);
        Logger.info(`detectProvider response: ${JSON.stringify(detail)}`);
    }

    return result;
}

/**
 * Detect all installed AI providers (there can be multiple).
 * Returns provider names sorted by priority.
 */
export function detectAllProviders(): string[] {
    const providers: string[] = [];
    const matchedExtensionIds: string[] = [];
    const appName = vscode.env.appName;
    const cursorFromApp = appName.toLowerCase().includes('cursor');
    if (cursorFromApp) {
        providers.push('cursor');
    }
    for (const [extId, provider] of Object.entries(EXTENSION_TO_PROVIDER)) {
        const ext = vscode.extensions.getExtension(extId);
        if (ext && !providers.includes(provider)) {
            providers.push(provider);
            matchedExtensionIds.push(extId);
        }
    }
    /**
     * Stock VS Code exposes Language Model / Chat without always mapping to a known extension id.
     * Without this, {@link ChangeTracker} `providerBiasHeuristic` stays off and chat-panel applies
     * that look format-like never get AI attribution.
     */
    if (typeof vscode.lm !== 'undefined') {
        const builtinLm = 'vscode-language-models';
        if (!providers.includes(builtinLm)) {
            providers.push(builtinLm);
            matchedExtensionIds.push('(builtin:vscode.lm)');
        }
    }

    const extensionScan = Object.entries(EXTENSION_TO_PROVIDER).map(([extId, mappedProvider]) => {
        const ext = vscode.extensions.getExtension(extId);
        return {
            extId,
            mapsTo: mappedProvider,
            state: ext ? (ext.isActive ? 'active' : 'inactive') : 'absent',
        };
    });

    logProviderConsole({
        fn: 'detectAllProviders',
        phase: 'extension-scan',
        appName,
        cursorFromApp,
        vscodeLmDefined: typeof vscode.lm !== 'undefined',
        extensionScan,
    });
    logProviderConsole({
        fn: 'detectAllProviders',
        phase: 'resolved',
        providers: [...providers],
        matchedExtensionIds: [...matchedExtensionIds],
    });

    Logger.info(
        `detectAllProviders: appName=${JSON.stringify(appName)} cursorFromApp=${cursorFromApp} ` +
            `providers=[${providers.join(', ')}] matchedExtensions=[${matchedExtensionIds.join(', ')}]`
    );
    Logger.info(
        `detectAllProviders scan: ${extensionScan.map(e => `${e.extId}=${e.state}`).join('; ')}`
    );
    return providers;
}

/**
 * Determine interaction type based on contextual clues.
 * Mirrors IntelliJ detectInteractionType(): chat_inline, chat_panel, completion.
 */
export function detectInteractionType(commandId?: string): string | null {
    if (!commandId) return null;
    const id = commandId.toLowerCase();

    // Agent / Composer apply: use chat_panel duration (15s) when command IDs change per release.
    if (
        (id.includes('agent') || id.includes('composer')) &&
        (id.includes('apply') || id.includes('accept') || id.includes('keep') || id.includes('approve'))
    ) {
        return 'chat_panel';
    }
    if (id.includes('cloud') && (id.includes('apply') || id.includes('keep'))) {
        return 'chat_panel';
    }

    if (id.includes('multidiff') && (id.includes('accept') || id.includes('apply') || id.includes('keep') || id.includes('save'))) {
        return 'chat_panel';
    }

    if (
        (id.includes('keep') || id.includes('keepall') || id.includes('keep-all')) &&
        (id.includes('diff') || id.includes('multidiff') || id.includes('multi-diff'))
    ) {
        return 'chat_panel';
    }

    if (
        id.includes('inlineedit') &&
        (id.includes('keep') || id.includes('accept') || id.includes('apply') || id.includes('approve'))
    ) {
        return 'chat_panel';
    }

    if (id.includes('composer') && (id.includes('apply') || id.includes('accept') || id.includes('keep'))) {
        return 'chat_panel';
    }

    // Claude/Anthropic completion actions can include provider IDs in command names.
    if ((id.includes('claude') || id.includes('anthropic') || id.includes('cline')) &&
        (id.includes('completion') || id.includes('inline') || id.includes('suggest') || id.includes('tab'))) {
        return 'completion';
    }
    if (id.includes('inline') && (id.includes('chat') || id.includes('edit'))) return 'chat_inline';
    if (id.includes('chat') || id.includes('panel')) return 'chat_panel';
    if (id.includes('completion') || id.includes('inlay') || id.includes('suggest') || id.includes('tab')) return 'completion';
    if (id.includes('apply') || id.includes('accept') || id.includes('insert') || id.includes('keep')) {
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
    const ctx: AiContext = { prompt: null, model, provider, interactionType };
    logProviderConsole({
        fn: 'extract',
        commandId: commandId ?? null,
        provider: ctx.provider,
        model: ctx.model,
        interactionType: ctx.interactionType,
    });
    Logger.info(
        `extract response: ${JSON.stringify({
            commandId: commandId ?? null,
            provider: ctx.provider,
            model: ctx.model,
            interactionType: ctx.interactionType,
        })}`
    );
    return ctx;
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
    if (lower.includes('claude')
         || lower.includes('anthropic')
         || lower.includes('cline')) 
         return 'anthropic-claude';
    return rawId;
}

export { sanitizeModelForReport } from './modelSanitize';

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
 * User rejected or discarded AI output (inline chat, panel, composer). Clears the pending
 * "next edits are AI" window so the next keystrokes are not mis-attributed.
 */
export function matchesTrackedAiRejectCommand(commandId: string): boolean {
    const id = commandId.toLowerCase();
    if (id.startsWith('git.') || id.startsWith('gitlens')) {
        return false;
    }
    const staticReject = [
        'inlinechat.discard',
        'inlinechat.discardall',
        'github.copilot.chat.cancel',
        'cursor.rejectdiff',
        'cursor.discarddiff',
    ];
    if (staticReject.some(p => id === p)) {
        return true;
    }
    if (id.startsWith('workbench.action.chat.') &&
        (id.includes('discard') || id.includes('reject') || id.includes('cancel'))) {
        return true;
    }
    if (id.startsWith('inlinechat.') && (id.includes('discard') || id.includes('reject'))) {
        return true;
    }
    if (id.includes('composer') && (id.includes('discard') || id.includes('reject') || id.includes('cancel'))) {
        return true;
    }
    if (id.startsWith('cursor.') && (id.includes('reject') || id.includes('discard'))) {
        return true;
    }
    // Dismiss inline ghost text without accepting (not a full "reject" but same intent for tracking)
    if (id === 'editor.action.inlineSuggest.hide' || id === 'editor.action.inlineSuggest.hideExplicitly') {
        return true;
    }
    return false;
}

/** Returns true if the given command ID is AI-related. */
export function isAiRelatedCommand(commandId: string): boolean {
    const id = commandId.toLowerCase();
    const allPatterns = [
        ...AI_COMMAND_PATTERNS.completion,
        ...AI_COMMAND_PATTERNS.chatInline,
        ...AI_COMMAND_PATTERNS.chatPanel,
    ];
    if (allPatterns.some(p => id === p.toLowerCase())) return true;
    if (id.includes('copilot') || id.includes('codeium') || id.includes('tabnine') || id.includes('cursor') ||
        id.includes('claude') || id.includes('anthropic') || id.includes('cline')) {
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
    if (AI_COMMAND_PATTERNS.chatSend.some(p => id === p.toLowerCase())) {
        return true;
    }
    if (
        id.startsWith('github.copilot.') &&
        (id.includes('send') || id.includes('submit')) &&
        !id.includes('signin') &&
        !id.includes('sign-in')
    ) {
        return true;
    }
    if (
        (id.includes('chat') ||
            id.includes('copilot') ||
            id.includes('cursor') ||
            id.includes('claude') ||
            id.includes('anthropic')) &&
        (id.includes('send') || id.includes('submit') || id.includes('ask'))
    ) {
        return true;
    }
    return false;
}

/** Duration for the markNextChangeAsAi window depending on interaction type. */
export function getAiWindowDuration(interactionType: string | null): number {
    switch (interactionType) {
        /** Large chat/agent applies stream many replacements; 15s routinely expires mid-stream → Human + format-preservation false positives. */
        case 'chat_panel': return 90_000;
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

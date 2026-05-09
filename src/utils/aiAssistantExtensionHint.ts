/** Substrings for extension publisher.id when not listed in AiContextExtractor map (sidebar chat / LM hosts). */
const AI_EXTENSION_ID_SUBSTRINGS = [
    'github.copilot',
    'copilot-chat',
    'copilot.',
    'anthropic.',
    'claude-code',
    '.claude',
    'claude-dev',
    'cline.',
    'cursor.',
    'codeium',
    'continue.',
    'windsurf',
    'tabnine',
    'supermaven',
    'amazon-q',
    'amazonwebservices.',
    'openai.',
    'gemini',
    'chatgpt',
    'aichat',
    'microsoft-chatagent',
];

/**
 * True when `publisher.name` style id likely belongs to Copilot / Claude / Cursor / Codeium / etc.
 */
export function extensionIdLooksAiCodingAssistant(extId: string): boolean {
    const id = extId.toLowerCase();
    return AI_EXTENSION_ID_SUBSTRINGS.some((h) => id.includes(h.toLowerCase()));
}

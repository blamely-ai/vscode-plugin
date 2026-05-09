/**
 * Best-effort extraction of user prompt text from vscode.commands execution arguments.
 * Hosts pass different shapes; there is no stable public schema.
 */

const PROMPT_KEYS = [
    'prompt',
    'message',
    'text',
    'query',
    'input',
    'content',
    'userMessage',
    'userPrompt',
    'instruction',
    'request',
    'value',
    'markdown',
];

function looksLikeOneLinePathOrUri(s: string): boolean {
    const t = s.trim();
    if (t.length < 3 || t.length > 4096) {
        return true;
    }
    if (/^file:/i.test(t) || /^vscode-resource:/i.test(t)) {
        return true;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && t.includes('://')) {
        return true;
    }
    return /^[/\\]|^[a-z]:\\/i.test(t);
}

function directPromptFields(o: Record<string, unknown>, maxLen: number): string | undefined {
    for (const k of PROMPT_KEYS) {
        if (!(k in o)) {
            continue;
        }
        const v = o[k];
        if (typeof v !== 'string') {
            continue;
        }
        const s = v.trim();
        if (s.length > 0) {
            return s.slice(0, maxLen);
        }
    }
    return undefined;
}

export function extractPossibleChatPrompt(args: unknown[] | undefined, maxLen = 8000): string | undefined {
    if (!args || args.length === 0) {
        return undefined;
    }
    const seen = new WeakSet<object>();

    function walk(v: unknown, depth: number): string | undefined {
        if (depth > 8 || v === undefined || v === null) {
            return undefined;
        }
        if (typeof v === 'string') {
            const s = v.trim();
            if (s.length >= 2 && s.length <= maxLen && !looksLikeOneLinePathOrUri(s)) {
                return s.slice(0, maxLen);
            }
            return undefined;
        }
        if (typeof v !== 'object') {
            return undefined;
        }
        if (seen.has(v)) {
            return undefined;
        }
        seen.add(v);

        if (Array.isArray(v)) {
            for (const item of v) {
                const r = walk(item, depth + 1);
                if (r) {
                    return r;
                }
            }
            return undefined;
        }

        const o = v as Record<string, unknown>;
        const direct = directPromptFields(o, maxLen);
        if (direct) {
            return direct;
        }

        for (const val of Object.values(o)) {
            const r = walk(val, depth + 1);
            if (r) {
                return r;
            }
        }
        return undefined;
    }

    /** Prefer structured fields before picking arbitrary strings from arguments. */
    for (const a of args) {
        if (a && typeof a === 'object' && !Array.isArray(a)) {
            const d = directPromptFields(a as Record<string, unknown>, maxLen);
            if (d) {
                return d;
            }
        }
    }

    for (const a of args) {
        const r = walk(a, 0);
        if (r) {
            return r;
        }
    }
    return undefined;
}

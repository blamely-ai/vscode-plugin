/**
 * Model-name cleanup for reports (no vscode dependency — safe for unit tests).
 */

function looksLikePackageName(s: string): boolean {
    const lower = s.toLowerCase();
    if (lower.includes('com.') || lower.includes('org.') || lower.includes('net.')) return true;
    if (/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(lower)) return true;
    return false;
}

/**
 * Collapse repeated slash segments from LM API shapes like
 * `copilot/gemini-3.1-pro-preview/gemini-3.1-pro-preview`.
 */
function dedupeSlashSegments(model: string): string {
    const parts = model.split('/').filter(p => p.length > 0);
    const out: string[] = [];
    for (const p of parts) {
        if (out.length > 0 && out[out.length - 1].toLowerCase() === p.toLowerCase()) {
            continue;
        }
        out.push(p);
    }
    return out.join('/');
}

/**
 * Sanitize a model name: reject package/class names, trim, validate.
 * Mirrors IntelliJ AiContextExtractor.sanitizeModelForReport().
 */
export function sanitizeModelForReport(model: string | null): string | null {
    if (!model || model.trim().length < 2) return null;
    let trimmed = model.trim();
    if (looksLikePackageName(trimmed)) return null;
    trimmed = dedupeSlashSegments(trimmed);
    return trimmed.length >= 2 ? trimmed : null;
}

import { LineBlame } from '../blame/BlameMap';

/** Plain-text gutter tooltip (mirrors IntelliJ BlameDecorationsTooltipTest). */
export function formatBlameChangedDate(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return 'Unknown';
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return trimmed;
    return d.toLocaleString();
}

/** Raw provider id (e.g. `codex`, `copilot`) → display label for gutter hover (e.g. `Codex`, `Copilot`). */
export function toolDisplayName(provider: string): string {
    const trimmed = provider.trim().toLowerCase();
    return trimmed.length === 0 ? trimmed : trimmed[0].toUpperCase() + trimmed.slice(1);
}

export function blameGutterTooltipText(entry: LineBlame): string {
    // Only show the change date when we actually have one — an empty timestamp
    // would otherwise render a noisy "Change Date: Unknown" line.
    const changed = entry.timestamp?.trim() ? formatBlameChangedDate(entry.timestamp) : '';
    if (entry.authorType === 'AI') {
        const lines = ['Author: AI'];
        if (entry.provider) lines.push(`Tool: ${toolDisplayName(entry.provider)}`);
        if (entry.model) lines.push(`Model: ${entry.model}`);
        if (changed) lines.push(`Change Date: ${changed}`);
        return lines.join('\n');
    }
    const lines = ['Author: Human'];
    if (changed) lines.push(`Change Date: ${changed}`);
    if (entry.commitSha) lines.push(`Commit: ${entry.commitSha.slice(0, 8)}`);
    return lines.join('\n');
}

export function escapeMarkdown(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function quotePromptForTooltip(prompt: string): string {
    const clean = escapeMarkdown(prompt).trim();
    const short = clean.length > 220 ? `${clean.slice(0, 220)}...` : clean;
    return `> ${short}`;
}

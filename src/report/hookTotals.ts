import type { LineBlame } from '../blame/BlameMap';
import { sanitizeModelForReport } from '../utils/modelSanitize';

/** Per-file aggregates used when building YAML and hook preamble totals. */
export interface FileEntry {
    path: string;
    source: string;
    model: string;
    aiLinesAdded: number;
    humanLinesAdded: number;
    aiLinesDeleted: number;
    humanLinesDeleted: number;
    linesDeleted: number;
    totalEntries: number;
    percentage: string;
    prompts: string[];
}

/** Aggregated counts for pre-commit message suffix / internal parity (no longer written to a sidecar file). */
export interface HookTotals {
    aiLinesAdded: number;
    aiLinesDeleted: number;
    humanLinesAdded: number;
    humanLinesDeleted: number;
}

export function totalsFromFileEntries(fileEntries: FileEntry[]): HookTotals {
    return {
        aiLinesAdded: fileEntries.reduce((s, e) => s + e.aiLinesAdded, 0),
        aiLinesDeleted: fileEntries.reduce((s, e) => s + e.aiLinesDeleted, 0),
        humanLinesAdded: fileEntries.reduce((s, e) => s + e.humanLinesAdded, 0),
        humanLinesDeleted: fileEntries.reduce((s, e) => s + e.humanLinesDeleted, 0),
    };
}

/**
 * Header lines read by `hookRunner.js`: legacy AI/Human totals plus per-kind add/delete counts (v2).
 */
export function detectorHookPreamble(totals: HookTotals): string {
    const { aiLinesAdded: aa, aiLinesDeleted: ad, humanLinesAdded: ha, humanLinesDeleted: hd } = totals;
    const aiTotal = aa + ad;
    const humanTotal = ha + hd;
    const all = aiTotal + humanTotal;
    const aiPct = all > 0 ? ((100 * aiTotal) / all).toFixed(1) : '0.0';
    const humanPct = all > 0 ? ((100 * humanTotal) / all).toFixed(1) : '0.0';
    return (
        `# AI-authored lines: ${aiTotal} (${aiPct}%)\n` +
        `# Human-authored lines: ${humanTotal} (${humanPct}%)\n` +
        `# ai_lines_added: ${aa}\n` +
        `# ai_lines_deleted: ${ad}\n` +
        `# human_lines_added: ${ha}\n` +
        `# human_lines_deleted: ${hd}\n\n`
    );
}

/** For tests / tooling: same aggregation as report files without generating YAML. */
export function computeHookTotalsFromBlameSnapshot(entireBlame: Record<string, LineBlame[]>): HookTotals {
    const interactionTypesFromBlame = new Set<string>();
    const fileEntries = buildFileEntries(entireBlame, interactionTypesFromBlame);
    return totalsFromFileEntries(fileEntries);
}

export function buildFileEntries(
    entireBlame: Record<string, LineBlame[]>,
    interactionTypesFromBlame: Set<string>
): FileEntry[] {
    const fileEntries: FileEntry[] = [];
    for (const [filePath, entries] of Object.entries(entireBlame)) {
        if (entries.length === 0) continue;
        const addedEntries = entries.filter(e => (e.changeType ?? 'ADD') === 'ADD');
        const deletedEntries = entries.filter(e => e.changeType === 'DELETE');

        let aiLines = 0;
        let humanLines = 0;
        let aiLinesDeleted = 0;
        let humanLinesDeleted = 0;
        const modelsSet = new Set<string>();
        const promptsSet = new Set<string>();

        for (const e of addedEntries) {
            if (e.authorType === 'AI') {
                aiLines++;
                const sanitized = sanitizeModelForReport(e.model);
                if (sanitized) modelsSet.add(sanitized);
                if (e.prompt) promptsSet.add(e.prompt);
                if (e.interactionType?.trim()) interactionTypesFromBlame.add(e.interactionType);
            } else {
                humanLines++;
            }
        }

        for (const e of deletedEntries) {
            if (e.authorType === 'AI') {
                aiLinesDeleted++;
            } else {
                humanLinesDeleted++;
            }
        }

        const deletedCount = deletedEntries.length;
        const totalAdded = aiLines + humanLines;
        const totalAll = totalAdded + deletedCount;
        const aiMassFile = aiLines + aiLinesDeleted;
        const pct = totalAll > 0 ? ((100 * aiMassFile) / totalAll).toFixed(1) + '%' : '0.0%';
        const modelDisplay =
            modelsSet.size === 0 ? 'unknown' : modelsSet.size === 1 ? [...modelsSet][0] : 'multiple';

        fileEntries.push({
            path: filePath,
            source: 'unknown',
            model: modelDisplay,
            aiLinesAdded: aiLines,
            humanLinesAdded: humanLines,
            aiLinesDeleted,
            humanLinesDeleted,
            linesDeleted: deletedCount,
            totalEntries: totalAll,
            percentage: pct,
            prompts: [...promptsSet],
        });
    }
    return fileEntries;
}

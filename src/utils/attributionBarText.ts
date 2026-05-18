import type { LineBlame } from '../blame/BlameMap';

/** Count attributions treated as Δ lines (same as one row per added/deleted line in commit snapshot). */
export function countAiHumanLineDeltas(snapshot: Record<string, LineBlame[]>): { ai: number; human: number } {
    let ai = 0;
    let human = 0;
    for (const entries of Object.values(snapshot)) {
        for (const e of entries) {
            if (e.authorType === 'AI') {
                ai++;
            } else {
                human++;
            }
        }
    }
    return { ai, human };
}

/**
 * Plain-text post-commit line aligned with hookRunner.js / blamely-cli `ui.AttributionBar`
 * (percentages + bar only; no Δ line counts). For VS Code Output when terminal hook output is not shown.
 */
export function formatPostCommitAttributionBar(aiLines: number, humanLines: number, barWidth = 40): string {
    const total = aiLines + humanLines;
    if (total <= 0) {
        return '[blamely] no line-level attribution in this commit snapshot (empty diff snapshot or nothing to split).';
    }
    const aiFrac = aiLines / total;
    let aiW = Math.round(aiFrac * barWidth);
    if (aiW > barWidth) {
        aiW = barWidth;
    }
    if (aiW < 0) {
        aiW = 0;
    }
    const humW = barWidth - aiW;
    const aiPct = (100 * aiFrac).toFixed(1);
    const huPct = (100 - 100 * aiFrac).toFixed(1);
    const bar = '#'.repeat(aiW) + '-'.repeat(humW);
    return `[blamely] AI ${aiPct}%  [${bar}]  ${huPct}% Human`;
}

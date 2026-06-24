import { LineBlame } from '../blame/BlameMap';

// Shared shape + converter for Attribution v2 working logs (`blamely authorship`
// output), consumed by CliDataService to fill the BlameMap (which BlameDecorations
// paints). Kept in its own module to keep the converter dependency-light.

export interface WlLine {
    start: number;
    end: number;
    author: 'ai' | 'human';
    tool?: string;
    model?: string;
    gen_type?: string;
}

export interface WorkingLogJson {
    file?: string;
    lines?: WlLine[];
}

/** Expands a working log's per-range authors into the per-line LineBlame the gutter
 *  renderer consumes (one entry per line; AI → AI icon, else Human). */
export function toLineBlame(wl: WorkingLogJson): LineBlame[] {
    const out: LineBlame[] = [];
    for (const r of wl.lines ?? []) {
        const ai = r.author === 'ai';
        for (let ln = r.start; ln <= r.end; ln++) {
            out.push({
                lineNumber: ln,
                authorType: ai ? 'AI' : 'HUMAN',
                timestamp: '',
                aiChars: ai ? 1 : 0,
                humanChars: ai ? 0 : 1,
                changeType: 'ADD',
                codingType: 'TYPING',
                provider: ai ? r.tool ?? null : null,
                model: ai ? r.model ?? null : null,
                interactionType: ai ? r.gen_type ?? null : null,
                boundedAiRange: true,
            });
        }
    }
    return out;
}

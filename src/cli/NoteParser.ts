import { CliNote } from './types';

export function parseCliNote(raw: string): CliNote | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) {
        return null;
    }
    try {
        const note = JSON.parse(trimmed) as CliNote;
        // schema 1: per-line lines[]; schema 2: collapsed {start,end} ranges.
        // This parser only reads by_gen_type/totals, so both are accepted.
        if ((note.schema !== 1 && note.schema !== 2) || !note.commit) {
            return null;
        }
        return note;
    } catch {
        return null;
    }
}

export function genTypesFromNote(note: CliNote): string[] {
    const out: string[] = [];
    const gt = note.by_gen_type;
    if (!gt) {
        return out;
    }
    if (gt.chat > 0) out.push('chat');
    if (gt.cli > 0) out.push('cli');
    if (gt.completion > 0) out.push('completion');
    if ((gt.unknown ?? 0) > 0) out.push('unknown');
    return out;
}

export function modelsFromNote(note: CliNote): string[] {
    const models = note.totals?.models;
    if (!models) {
        return [];
    }
    return Object.keys(models).filter(m => m && m !== 'unknown');
}

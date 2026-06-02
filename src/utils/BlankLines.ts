import * as fs from 'fs';
import * as path from 'path';
import { LineBlame } from '../blame/BlameMap';

/** True when the line has no non-whitespace content (empty or whitespace-only). */
export function isBlankLine(text: string): boolean {
    return text.replace(/\r$/, '').trim().length === 0;
}

function readFileLines(repoRoot: string, filePath: string): string[] | null {
    try {
        return fs.readFileSync(path.join(repoRoot, filePath), 'utf8').split(/\r?\n/);
    } catch {
        return null;
    }
}

/** Drop line numbers that are blank in the current working-tree file. */
export function filterBlankChangedLines(
    repoRoot: string,
    changedByFile: Map<string, number[]>,
): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const [filePath, lineNums] of changedByFile) {
        const lines = readFileLines(repoRoot, filePath);
        if (!lines) {
            out.set(filePath, lineNums);
            continue;
        }
        const kept = lineNums.filter(ln => {
            const text = lines[ln - 1];
            return text !== undefined && !isBlankLine(text);
        });
        if (kept.length > 0) {
            out.set(filePath, kept);
        }
    }
    return out;
}

/** Remove blame entries for lines that are blank in the working tree. */
export function stripBlankLineBlame(
    repoRoot: string,
    byFile: Map<string, LineBlame[]>,
): Map<string, LineBlame[]> {
    const out = new Map<string, LineBlame[]>();
    for (const [filePath, entries] of byFile) {
        const lines = readFileLines(repoRoot, filePath);
        if (!lines) {
            out.set(filePath, entries);
            continue;
        }
        const kept = entries.filter(e => {
            const text = lines[e.lineNumber - 1];
            return text !== undefined && !isBlankLine(text);
        });
        if (kept.length > 0) {
            out.set(filePath, kept);
        }
    }
    return out;
}

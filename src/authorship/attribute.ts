// Attribution v2 engine — TypeScript port of internal/authorship (Go) in
// blamely-cli. This MUST stay byte-for-byte behavior-compatible with the Go and
// Kotlin implementations: all three run the shared golden vectors
// (src/test/golden_vectors.json, synced from blamely-cli's canonical copy), so any
// drift fails the AttributionGolden test. See docs/attribution-v2-design.md §6.
//
// Cross-platform: pure string logic, no fs/path here.

export const WORKING_LOG_SCHEMA = 'blamely/working-log/1';

export type AuthorType = 'human' | 'ai';

export interface Author {
    author: AuthorType;
    tool?: string;
    model?: string;
    gen_type?: string;
    session?: string;
}

export interface LineAttribution {
    start: number; // 1-based, inclusive
    end: number;
    author: AuthorType;
    tool?: string;
    model?: string;
    gen_type?: string;
    session?: string;
}

export interface WorkingLog {
    schema: string;
    file?: string;
    base_sha?: string;
    blob_sha?: string;
    updated_ms?: number;
    lines: LineAttribution[];
}

export function humanAuthor(): Author {
    return { author: 'human', gen_type: 'human' };
}

/**
 * attribute is THE engine: given the prior working log + the baseline content it
 * describes, and the new content produced by `author`'s edit, return the updated
 * working log. Unchanged lines (LCS-matched) keep their prior author; added/
 * changed lines become `author`; uncovered lines default to Human. No content-
 * hash guessing — identical-but-moved/duplicate lines resolve by diff position.
 */
export function attribute(
    prior: WorkingLog | null,
    baseline: string,
    newContent: string,
    author: Author,
    nowMs = 0,
): WorkingLog {
    const oldLines = splitLines(baseline);
    const newLines = splitLines(newContent);
    const matched = alignLines(oldLines, newLines);

    const perLine: Author[] = new Array(newLines.length);
    for (let i = 0; i < newLines.length; i++) {
        const j = matched[i];
        perLine[i] = j >= 0 ? priorAuthorOr(prior, j + 1) : author;
    }

    return {
        schema: WORKING_LOG_SCHEMA,
        file: prior?.file,
        base_sha: prior?.base_sha,
        blob_sha: undefined, // sha set by the storage layer, not needed for the engine
        updated_ms: nowMs || Date.now(),
        lines: coalesce(perLine),
    };
}

function priorAuthorOr(prior: WorkingLog | null, line: number): Author {
    if (prior) {
        for (const r of prior.lines) {
            if (line >= r.start && line <= r.end) {
                return { author: r.author, tool: r.tool, model: r.model, gen_type: r.gen_type, session: r.session };
            }
        }
    }
    return humanAuthor();
}

/** splitLines drops the trailing empty element from a final newline and strips a
 *  trailing CR so CRLF (Windows) and LF compare equal — matches the Go port. */
function splitLines(s: string): string[] {
    if (s === '') {
        return [];
    }
    const parts = s.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
        parts.pop();
    }
    return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** alignLines: for each NEW line, the OLD line index it is unchanged from (LCS
 *  match) or -1. Standard LCS DP + backtrack; identical to the Go implementation. */
function alignLines(oldLines: string[], newLines: string[]): number[] {
    const n = oldLines.length;
    const m = newLines.length;
    const matched: number[] = new Array(m).fill(-1);
    if (n === 0 || m === 0) {
        return matched;
    }
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (oldLines[i] === newLines[j]) {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                dp[i][j] = dp[i + 1][j];
            } else {
                dp[i][j] = dp[i][j + 1];
            }
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (oldLines[i] === newLines[j]) {
            matched[j] = i;
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return matched;
}

function coalesce(perLine: Author[]): LineAttribution[] {
    const out: LineAttribution[] = [];
    for (let i = 0; i < perLine.length; i++) {
        const ln = i + 1;
        const a = perLine[i];
        const last = out[out.length - 1];
        if (
            last && last.end === ln - 1 &&
            last.author === a.author && (last.tool ?? '') === (a.tool ?? '') &&
            (last.model ?? '') === (a.model ?? '') && (last.gen_type ?? '') === (a.gen_type ?? '') &&
            (last.session ?? '') === (a.session ?? '')
        ) {
            last.end = ln;
            continue;
        }
        out.push({ start: ln, end: ln, author: a.author, tool: a.tool, model: a.model, gen_type: a.gen_type, session: a.session });
    }
    return out;
}

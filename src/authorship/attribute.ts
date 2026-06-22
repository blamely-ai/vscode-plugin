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
    // overrode records the author a changed line replaced (audit marker); absent
    // when the line was not an override.
    overrode?: Author;
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

    // overrode[i] = the author a CHANGED line replaced, when its type differs from
    // the new author (audit marker; does not change who owns the line now).
    const overrode = detectOverrode(prior, matched, oldLines.length, author);

    return {
        schema: WORKING_LOG_SCHEMA,
        file: prior?.file,
        base_sha: prior?.base_sha,
        blob_sha: undefined, // sha set by the storage layer, not needed for the engine
        updated_ms: nowMs || Date.now(),
        lines: coalesce(perLine, overrode),
    };
}

/** detectOverrode finds replace pairs and records the replaced author when its
 *  type differs from the new author. Walks the LCS alignment gap by gap and pairs
 *  unmatched old/new lines positionally — identical to the Go and Kotlin ports. */
function detectOverrode(
    prior: WorkingLog | null,
    matched: number[],
    nOld: number,
    author: Author,
): Array<Author | undefined> {
    const m = matched.length;
    const overrode: Array<Author | undefined> = new Array(m).fill(undefined);
    let oldCursor = 0;
    let i = 0;
    while (i < m) {
        if (matched[i] >= 0) {
            oldCursor = matched[i] + 1;
            i++;
            continue;
        }
        let gapNewEnd = i;
        while (gapNewEnd < m && matched[gapNewEnd] < 0) {
            gapNewEnd++;
        }
        const gapOldEnd = gapNewEnd < m ? matched[gapNewEnd] : nOld;
        for (let k = 0; i + k < gapNewEnd && oldCursor + k < gapOldEnd; k++) {
            const replaced = priorAuthorOr(prior, oldCursor + k + 1);
            if (replaced.author !== author.author) {
                overrode[i + k] = replaced;
            }
        }
        oldCursor = gapOldEnd;
        i = gapNewEnd;
    }
    return overrode;
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
// normalizeLineForMatch collapses a line to its whitespace-insensitive form: trim
// ends + collapse internal whitespace runs to a single space. MUST match the Go and
// Kotlin ports exactly (the golden vectors enforce it) so reflow is detected the
// same way everywhere. Empty after trim → "".
function normalizeLineForMatch(s: string): string {
    const trimmed = s.trim();
    if (trimmed === '') {
        return '';
    }
    return trimmed.split(/\s+/).join(' ');
}

// alignLines compares lines WHITESPACE-NORMALIZED (Phase 4 reflow): a line that
// changed only in indentation / trailing or collapsed whitespace counts as
// unchanged and keeps its prior author. A genuine content change still mismatches.
function alignLines(oldLines: string[], newLines: string[]): number[] {
    const n = oldLines.length;
    const m = newLines.length;
    const matched: number[] = new Array(m).fill(-1);
    if (n === 0 || m === 0) {
        return matched;
    }
    const oldN = oldLines.map(normalizeLineForMatch);
    const newN = newLines.map(normalizeLineForMatch);
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (oldN[i] === newN[j]) {
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
        if (oldN[i] === newN[j]) {
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

function coalesce(perLine: Author[], overrode: Array<Author | undefined>): LineAttribution[] {
    const out: LineAttribution[] = [];
    for (let i = 0; i < perLine.length; i++) {
        const ln = i + 1;
        const a = perLine[i];
        const ov = overrode[i];
        const last = out[out.length - 1];
        if (
            last && last.end === ln - 1 &&
            last.author === a.author && (last.tool ?? '') === (a.tool ?? '') &&
            (last.model ?? '') === (a.model ?? '') && (last.gen_type ?? '') === (a.gen_type ?? '') &&
            (last.session ?? '') === (a.session ?? '') && overrodeEqual(last.overrode, ov)
        ) {
            last.end = ln;
            continue;
        }
        out.push({ start: ln, end: ln, author: a.author, tool: a.tool, model: a.model, gen_type: a.gen_type, session: a.session, overrode: ov });
    }
    return out;
}

function overrodeEqual(a: Author | undefined, b: Author | undefined): boolean {
    if (!a || !b) {
        return !a && !b;
    }
    return a.author === b.author && (a.tool ?? '') === (b.tool ?? '') &&
        (a.model ?? '') === (b.model ?? '') && (a.gen_type ?? '') === (b.gen_type ?? '') &&
        (a.session ?? '') === (b.session ?? '');
}

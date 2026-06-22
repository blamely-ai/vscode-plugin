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

    // movedFrom[i] = old index a new line was MOVED from (relocated identical
    // content), or -1.
    const movedFrom = detectMoves(oldLines, newLines, matched);

    const perLine: Author[] = new Array(newLines.length);
    for (let i = 0; i < newLines.length; i++) {
        const j = matched[i];
        if (j >= 0) {
            perLine[i] = priorAuthorOr(prior, j + 1);
        } else if (movedFrom[i] >= 0) {
            perLine[i] = priorAuthorOr(prior, movedFrom[i] + 1);
        } else {
            perLine[i] = author;
        }
    }

    // overrode[i] = the author a CHANGED line replaced, when its type differs from
    // the new author (audit marker; does not change who owns the line now).
    const overrode = detectOverrode(prior, matched, movedFrom, oldLines.length, author);

    return {
        schema: WORKING_LOG_SCHEMA,
        file: prior?.file,
        base_sha: prior?.base_sha,
        blob_sha: undefined, // sha set by the storage layer, not needed for the engine
        updated_ms: nowMs || Date.now(),
        lines: coalesce(perLine, overrode),
    };
}

/** detectMoves pairs each unmatched NEW line with an unmatched OLD line of identical
 *  (whitespace-normalized) content — FIFO by content. Identical to the Go and Kotlin
 *  ports. A new line with no surviving deleted twin is a genuine add (-1). */
function detectMoves(oldLines: string[], newLines: string[], matched: number[]): number[] {
    const moved: number[] = new Array(newLines.length).fill(-1);
    const oldMatched: boolean[] = new Array(oldLines.length).fill(false);
    for (const j of matched) {
        if (j >= 0) {
            oldMatched[j] = true;
        }
    }
    const oldN = oldLines.map(normalizeLineForMatch);
    const newN = newLines.map(normalizeLineForMatch);
    const queues = new Map<string, number[]>();
    for (let oi = 0; oi < oldLines.length; oi++) {
        if (!oldMatched[oi]) {
            const q = queues.get(oldN[oi]);
            if (q) {
                q.push(oi);
            } else {
                queues.set(oldN[oi], [oi]);
            }
        }
    }
    for (let ni = 0; ni < newLines.length; ni++) {
        if (matched[ni] >= 0) {
            continue;
        }
        const q = queues.get(newN[ni]);
        if (q && q.length > 0) {
            moved[ni] = q.shift() as number;
        }
    }
    return moved;
}

/** detectOverrode finds replace pairs and records the replaced author when its type
 *  differs from the new author. Walks the LCS gap by gap and pairs, positionally,
 *  the NEW lines that are neither matched nor moved against the OLD lines not
 *  consumed by a move — identical to the Go and Kotlin ports. Moves never override. */
function detectOverrode(
    prior: WorkingLog | null,
    matched: number[],
    movedFrom: number[],
    nOld: number,
    author: Author,
): Array<Author | undefined> {
    const m = matched.length;
    const overrode: Array<Author | undefined> = new Array(m).fill(undefined);
    const consumedOld: boolean[] = new Array(nOld).fill(false);
    for (const mf of movedFrom) {
        if (mf >= 0) {
            consumedOld[mf] = true;
        }
    }
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
        const newAvail: number[] = [];
        const oldAvail: number[] = [];
        for (let ni = i; ni < gapNewEnd; ni++) {
            if (movedFrom[ni] < 0) {
                newAvail.push(ni);
            }
        }
        for (let oi = oldCursor; oi < gapOldEnd; oi++) {
            if (!consumedOld[oi]) {
                oldAvail.push(oi);
            }
        }
        for (let k = 0; k < newAvail.length && k < oldAvail.length; k++) {
            const replaced = priorAuthorOr(prior, oldAvail[k] + 1);
            if (replaced.author !== author.author) {
                overrode[newAvail[k]] = replaced;
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
// normalizeLineForMatch reduces a line to its whitespace-insensitive form by
// REMOVING all whitespace (git diff -w semantics) — indentation, trailing, and
// operator spacing (`x=1` ↔ `x = 1`) all read as reflow and keep the prior author.
// MUST match the Go and Kotlin ports exactly (the golden vectors enforce it).
function normalizeLineForMatch(s: string): string {
    return s.replace(/\s/g, '');
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

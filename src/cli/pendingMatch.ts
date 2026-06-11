import * as crypto from 'crypto';

/** sha256 hex of a line (matches the reader/writer hashing convention). */
export function lineSha(s: string): string {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * A pending (optimistic) AI line may only be asserted when the current line text
 * still hashes to the content_sha captured at accept time. This is what stops a
 * human line inserted in the MIDDLE of a fresh AI band — which slides into the
 * frozen pending line-range — from inheriting AI. Pending entries without a sha
 * (blank lines) keep the legacy line-number bridge.
 */
export function pendingMatchesLine(pending: { contentSha?: string | null }, text: string): boolean {
    if (!pending.contentSha) return true;
    return pending.contentSha === lineSha(text.replace(/\r$/, ''));
}

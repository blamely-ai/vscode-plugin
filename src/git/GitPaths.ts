import * as fs from 'fs';
import * as path from 'path';

/** Checkout-local Git directory, NOT the shared git-common-dir/repository ID.
 * Read the gitfile directly so working-log reads do not spawn git on each edit.
 * Missing .git keeps the ordinary layout (also used before git init). */
export function checkoutGitDir(repoRoot: string): string {
    const entry = path.join(repoRoot, '.git');
    try {
        if (fs.statSync(entry).isFile()) {
            const raw = fs.readFileSync(entry, 'utf8').trim();
            if (raw.startsWith('gitdir: ')) {
                return path.resolve(repoRoot, raw.slice('gitdir: '.length).trim());
            }
        }
    } catch { /* missing/unreadable → ordinary layout */ }
    return entry;
}

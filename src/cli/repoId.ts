import * as fs from 'fs';
import * as path from 'path';
import * as GitUtils from '../git/GitUtils';

/**
 * Canonical repo identity — matches oobeya-cli gitutil.RepoID.
 * Uses git-common-dir with /.git stripped and symlinks resolved.
 */
export async function getRepoId(repoRoot: string): Promise<string | null> {
    const gitDir = await GitUtils.runGitCommand(repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (!gitDir?.trim()) {
        return null;
    }
    let dir = gitDir.trim();
    if (path.basename(dir) === '.git') {
        dir = path.dirname(dir);
    }
    try {
        return fs.realpathSync(dir);
    } catch {
        return path.normalize(dir);
    }
}

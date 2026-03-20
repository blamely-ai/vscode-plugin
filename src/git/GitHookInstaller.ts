import * as fs from 'fs';
import * as path from 'path';
import * as Logger from '../utils/Logger';
import { isWindows, hookScriptContent, hookBatWrapper } from '../utils/Platform';
import { getGitDir } from './GitUtils';

export async function install(workspaceRoot: string, extensionPath: string): Promise<boolean> {
    try {
        const gitDir = await getGitDir(workspaceRoot);
        if (!gitDir) {
            Logger.warn('Not a git repository — skipping hook installation');
            return false;
        }

        const hooksDir = path.join(workspaceRoot, gitDir, 'hooks');
        await fs.promises.mkdir(hooksDir, { recursive: true });

        const hookPath = path.join(hooksDir, 'pre-commit');

        // Backup existing hook if present
        try {
            await fs.promises.access(hookPath);
            const backupPath = hookPath + '.backup';
            await fs.promises.copyFile(hookPath, backupPath);
            Logger.info(`Existing pre-commit hook backed up to ${backupPath}`);
        } catch {
            // No existing hook
        }

        // Write hook script
        const content = hookScriptContent(extensionPath);
        await fs.promises.writeFile(hookPath, content, { mode: 0o755 });
        Logger.info(`Pre-commit hook installed at ${hookPath}`);

        // On Windows, also write a .bat wrapper
        if (isWindows()) {
            const batPath = hookPath + '.bat';
            const batContent = hookBatWrapper(extensionPath);
            await fs.promises.writeFile(batPath, batContent);
            Logger.info(`Windows .bat wrapper installed at ${batPath}`);
        }

        return true;
    } catch (err) {
        Logger.error('Failed to install git hook', err);
        return false;
    }
}

export type RestoreHookResult = 'restored' | 'removed' | 'none';

/** Restore pre-commit from backup or remove hook. Matches IntelliJ RestoreGitHookAction. */
export async function uninstall(workspaceRoot: string): Promise<RestoreHookResult> {
    try {
        const gitDir = await getGitDir(workspaceRoot);
        if (!gitDir) return 'none';

        const hookPath = path.join(workspaceRoot, gitDir, 'hooks', 'pre-commit');
        const backupPath = hookPath + '.backup';

        try {
            await fs.promises.access(backupPath);
            await fs.promises.copyFile(backupPath, hookPath);
            await fs.promises.unlink(backupPath);
            Logger.info('Pre-commit hook restored from backup');
            return 'restored';
        } catch {
            // No backup: remove hook if present
            try {
                await fs.promises.unlink(hookPath);
                Logger.info('Pre-commit hook removed');
                return 'removed';
            } catch {
                return 'none';
            }
        }
    } catch (err) {
        Logger.error('Failed to uninstall git hook', err);
        return 'none';
    }
}

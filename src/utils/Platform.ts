import * as path from 'path';

export function isWindows(): boolean {
    return process.platform === 'win32';
}

export function normalizePath(filePath: string): string {
    return filePath.split(path.sep).join(path.posix.sep);
}

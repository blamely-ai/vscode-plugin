/** Short product label for blame snapshots and reports (e.g. "Cursor", "Visual Studio Code"). */
export function currentIdeLabel(): string | null {
    try {
        // Lazy require so unit tests (Node without the vscode runtime) can import callers.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const n = vscode.env.appName?.trim();
        return n && n.length > 0 ? n : null;
    } catch {
        return null;
    }
}

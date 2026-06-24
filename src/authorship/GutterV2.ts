import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { blameFileKey } from '../utils/WorkspacePaths';
import { installedBinaryPath } from '../cli/paths';
import { attributionV2Enabled } from './WorkingLogTracker';
import { WorkingLogJson, toLineBlame } from './workingLogBlame';
import * as Logger from '../utils/Logger';

const execFileAsync = promisify(execFile);

/**
 * Attribution v2 gutter overlay (docs/attribution-v2-design.md Phase 3). When v2 is
 * on (default), it paints the visible editors' gutters from `blamely authorship`
 * (the single per-line source — committed authorship seeded + uncommitted working-log
 * edits — the commit note also flips to, invariant I4).
 *
 * It re-fetches (debounced) on editor/visibility/save/edit changes AND on each
 * CliDataService refresh (which includes the 3s HEAD poll, so a commit re-queries and
 * the gutter clears once the file has no uncommitted changes). `authorship` returns
 * only the changed lines, so the gutter marks changes and clears at commit.
 */
export class GutterV2 implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private debounce?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly blameMap: BlameMap,
        private readonly repaint: () => void,
        private readonly cliData: CliDataService,
    ) {}

    activate(): void {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
            vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
            // No per-keystroke onDidChangeTextDocument trigger: typing doesn't change
            // authorship until the daemon records it, and VS Code shifts existing
            // decorations with edits automatically. The attribution change arrives via
            // onRefresh below, which CliDataService now fires from its working-log
            // watcher (when the daemon actually writes) — so re-fetching on every
            // keystroke was redundant spawns of `blamely authorship`.
            //
            // On any refresh (incl. a commit moving HEAD) RE-FETCH, so the gutter
            // reflects the current state — e.g. a committed file now has no
            // uncommitted changes and clears, rather than re-asserting stale icons.
            this.cliData.onRefresh(() => this.schedule()),
        );
        this.schedule();
    }

    private schedule(): void {
        if (!attributionV2Enabled()) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.refreshVisible(), 200);
    }

    private async refreshVisible(): Promise<void> {
        if (!attributionV2Enabled()) return;
        const bin = installedBinaryPath();
        if (!fs.existsSync(bin)) return;
        let painted = false;
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.uri.scheme !== 'file') continue;
            const entries = await this.fetch(bin, ed.document.uri.fsPath);
            if (entries) {
                const key = blameFileKey(ed.document.uri);
                this.blameMap.setFileBlame(key, entries);
                painted = true;
            }
        }
        if (painted) this.repaint();
    }

    private async fetch(bin: string, fsPath: string): Promise<LineBlame[] | null> {
        try {
            const { stdout } = await execFileAsync(bin, ['authorship', fsPath], {
                env: { ...process.env },
                timeout: 5000,
                maxBuffer: 8 * 1024 * 1024,
            });
            const trimmed = stdout.trim();
            if (!trimmed) return null;
            return toLineBlame(JSON.parse(trimmed) as WorkingLogJson);
        } catch (err) {
            Logger.warn(`GutterV2: authorship query failed: ${err}`);
            return null;
        }
    }

    dispose(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
    }
}

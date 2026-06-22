import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { blameFileKey } from '../utils/WorkspacePaths';
import { installedBinaryPath } from '../cli/paths';
import { attributionV2Enabled } from './WorkingLogTracker';
import * as Logger from '../utils/Logger';

const execFileAsync = promisify(execFile);

interface WlLine {
    start: number;
    end: number;
    author: 'ai' | 'human';
    tool?: string;
    model?: string;
    gen_type?: string;
}
interface WorkingLogJson {
    file?: string;
    lines?: WlLine[];
}

/**
 * Attribution v2 gutter overlay (docs/attribution-v2-design.md Phase 3). When v2 is
 * on (default), it paints the visible editors' gutters from `blamely authorship`
 * (the single per-line source — committed authorship seeded + uncommitted working-log
 * edits — the commit note also flips to, invariant I4).
 *
 * It is the gutter's source of truth when v2 is on, so it must win against the v1
 * CliDataService, which clears/replaces the shared BlameMap on its own timer. To
 * avoid the "icons load then disappear / flicker to AI" race, GutterV2:
 *   - caches the last per-file authorship and RE-ASSERTS it immediately on every v1
 *     refresh (so a v1 refresh can never leave the gutter cleared), and
 *   - re-fetches (debounced) on editor/visibility/save/edit changes.
 */
export class GutterV2 implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private debounce?: ReturnType<typeof setTimeout>;
    private readonly cache = new Map<string, LineBlame[]>();

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
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
                    this.schedule();
                }
            }),
            // v1 just rewrote the shared map — re-assert v2 immediately so the gutter
            // can't be cleared/clobbered out from under us.
            this.cliData.onRefresh(() => this.reassert()),
        );
        this.schedule();
    }

    /** Synchronously re-apply the cached v2 entries for the visible editors (no CLI
     *  call) so a v1 refresh never wins the final paint. */
    private reassert(): void {
        if (!attributionV2Enabled() || this.cache.size === 0) {
            return;
        }
        let any = false;
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.uri.scheme !== 'file') continue;
            const key = blameFileKey(ed.document.uri);
            const entries = this.cache.get(key);
            if (entries) {
                this.blameMap.setFileBlame(key, entries);
                any = true;
            }
        }
        if (any) this.repaint();
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
                this.cache.set(key, entries);
                this.blameMap.setFileBlame(key, entries);
                painted = true;
            }
        }
        if (painted) this.repaint();
    }

    private async fetch(bin: string, fsPath: string): Promise<LineBlame[] | null> {
        try {
            const { stdout } = await execFileAsync(bin, ['authorship', fsPath], {
                env: { ...process.env, BLAMELY_ATTRIBUTION_V2: '1' },
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
        this.cache.clear();
    }
}

/** Expands the working log's per-range authors into the per-line LineBlame the gutter
 *  renderer consumes (one entry per line; AI → AI icon, else Human). */
function toLineBlame(wl: WorkingLogJson): LineBlame[] {
    const out: LineBlame[] = [];
    for (const r of wl.lines ?? []) {
        const ai = r.author === 'ai';
        for (let ln = r.start; ln <= r.end; ln++) {
            out.push({
                lineNumber: ln,
                authorType: ai ? 'AI' : 'HUMAN',
                timestamp: '',
                aiChars: ai ? 1 : 0,
                humanChars: ai ? 0 : 1,
                changeType: 'ADD',
                codingType: 'TYPING',
                provider: ai ? r.tool ?? null : null,
                model: ai ? r.model ?? null : null,
                interactionType: ai ? r.gen_type ?? null : null,
                boundedAiRange: true,
            });
        }
    }
    return out;
}

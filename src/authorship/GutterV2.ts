import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { BlameMap, LineBlame } from '../blame/BlameMap';
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
 * Attribution v2 gutter overlay (docs/attribution-v2-design.md Phase 3), gated by
 * the `blamely.attributionV2` setting. When ON, it paints the ACTIVE editor's gutter
 * from `blamely authorship <file>` — the single per-line source (committed authorship
 * seeded + uncommitted working-log edits) the commit note also flips to (invariant
 * I4). When OFF (default), it is completely inert and the v1 path owns the gutter.
 *
 * Known limitation while experimental: only the active editor is overlaid (the status
 * bar / sidebar still aggregate the v1 map), and a v1 timer refresh may transiently
 * repaint between overlay ticks. Repo-wide ownership is a follow-up once the flip is
 * validated in the IDE.
 */
export class GutterV2 implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private debounce?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly blameMap: BlameMap,
        private readonly repaint: () => void,
    ) {}

    activate(): void {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
            vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document === vscode.window.activeTextEditor?.document) this.schedule();
            }),
        );
        this.schedule();
    }

    private schedule(): void {
        if (!attributionV2Enabled()) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.refreshActive(), 300);
    }

    private async refreshActive(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file' || !attributionV2Enabled()) {
            return;
        }
        const bin = installedBinaryPath();
        if (!fs.existsSync(bin)) {
            return;
        }
        let wl: WorkingLogJson;
        try {
            const { stdout } = await execFileAsync(bin, ['authorship', editor.document.uri.fsPath], {
                env: { ...process.env, BLAMELY_ATTRIBUTION_V2: '1' },
                timeout: 5000,
                maxBuffer: 8 * 1024 * 1024,
            });
            const trimmed = stdout.trim();
            if (!trimmed) {
                return;
            }
            wl = JSON.parse(trimmed) as WorkingLogJson;
        } catch (err) {
            Logger.warn(`GutterV2: authorship query failed: ${err}`);
            return;
        }
        const entries = toLineBlame(wl);
        if (!entries.length) {
            return;
        }
        this.blameMap.setFileBlame(blameFileKey(editor.document.uri), entries);
        this.repaint();
    }

    dispose(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
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

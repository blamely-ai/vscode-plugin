import * as vscode from 'vscode';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { uriFromBlameFileKey } from '../utils/WorkspacePaths';
import * as Logger from '../utils/Logger';


interface FileStats {
    filePath: string;
    fileName: string;
    ext: string;
    aiLines: number;
    humanLines: number;
    aiPct: number;
    humanPct: number;
    totalLines: number;
}

/** Changes panel — runtime edits from oobeya-cli SQLite. */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewId = 'blamelySidebar';

    private view?: vscode.WebviewView;
    private blameMap: BlameMap;
    private cliData: CliDataService;
    private disposables: vscode.Disposable[] = [];

    constructor(blameMap: BlameMap, cliData: CliDataService) {
        this.blameMap = blameMap;
        this.cliData = cliData;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'refresh') {
                void this.cliData.refresh().then(() => this.refreshAsync());
            }
            if (msg.command === 'openFile' && msg.filePath) {
                this.openFile(msg.filePath);
            }
        });
        this.disposables.push(this.cliData.onRefresh(() => void this.refreshAsync()));
        void this.refreshAsync();
    }

    refresh(): void {
        void this.refreshAsync();
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
    }

    private async refreshAsync(): Promise<void> {
        if (!this.view) return;
        try {
            this.view.webview.html = await this.buildHtml();
        } catch (err) {
            Logger.warn(`Blamely sidebar refresh failed: ${err}`);
        }
    }

    private openFile(filePath: string): void {
        const uri = uriFromBlameFileKey(filePath)
            ?? (filePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(filePath)
                ? vscode.Uri.file(filePath)
                : vscode.workspace.workspaceFolders?.[0]
                    ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath)
                    : undefined);
        if (!uri) {
            vscode.window.showErrorMessage(`Could not open ${filePath}`);
            return;
        }
        void vscode.window.showTextDocument(uri).then(undefined, () => {
            vscode.window.showErrorMessage(`Could not open ${filePath}`);
        });
    }

    private getFileStatsList(): FileStats[] {
        const result: FileStats[] = [];

        for (const filePath of this.blameMap.getTrackedFiles()) {
            const byLine = new Map<number, LineBlame>();
            for (const e of this.blameMap.getBlame(filePath)) {
                const existing = byLine.get(e.lineNumber);
                if (!existing || (e.aiChars + e.humanChars) >= (existing.aiChars + existing.humanChars)) {
                    byLine.set(e.lineNumber, e);
                }
            }

            let aiLines = 0, humanLines = 0;
            for (const e of byLine.values()) {
                if (e.authorType === 'AI') aiLines++;
                else humanLines++;
            }

            if (aiLines === 0 && humanLines === 0) continue;

            const totalLines = aiLines + humanLines;
            const aiPct = Math.round((aiLines / totalLines) * 100);
            const humanPct = 100 - aiPct;

            const parts = filePath.split('/');
            const fullName = parts[parts.length - 1] || filePath;
            const dotIdx = fullName.lastIndexOf('.');
            const name = dotIdx > 0 ? fullName.slice(0, dotIdx) : fullName;
            const ext = dotIdx > 0 ? fullName.slice(dotIdx) : '';

            result.push({ filePath, fileName: name, ext, aiLines, humanLines, aiPct, humanPct, totalLines });
        }

        return result.sort((a, b) => b.totalLines - a.totalLines);
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private fmtNum(n: number): string {
        return n >= 1000 ? n.toLocaleString('en-US').replace(/,/g, ' ') : String(n);
    }

    private static readonly CSS = `
:root {
  --bg-primary:    var(--vscode-editor-background, #1e1f22);
  --bg-secondary:  var(--vscode-sideBar-background, #2b2d30);
  --bg-elevated:   var(--vscode-editorGroupHeader-tabsBackground, #313438);
  --bg-hover:      var(--vscode-list-hoverBackground, #2e3035);
  --border:        var(--vscode-panel-border, #3d4045);
  --text-primary:  var(--vscode-foreground, #dfe1e5);
  --text-secondary:var(--vscode-descriptionForeground, #9da0a8);
  --ai-color:      #4d9de0;
  --human-color:   #56a064;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--text-primary); background: var(--bg-primary); padding: 12px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.header h2 { font-size: 13px; font-weight: 600; }
.btn { background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-primary); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
.summary { display: flex; gap: 16px; padding: 10px 12px; background: var(--bg-secondary); border-radius: 6px; margin-bottom: 12px; border: 1px solid var(--border); }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 10px; color: var(--text-secondary); text-transform: uppercase; }
.stat-value { font-size: 14px; font-weight: 600; }
.stat-ai .stat-value { color: var(--ai-color); }
.stat-human .stat-value { color: var(--human-color); }
.file-list { display: flex; flex-direction: column; gap: 6px; }
.file-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--bg-secondary); border-radius: 4px; border: 1px solid var(--border); cursor: pointer; }
.file-row:hover { background: var(--bg-hover); }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-stats { font-size: 11px; color: var(--text-secondary); }
.bar { height: 3px; border-radius: 2px; background: var(--border); margin-top: 4px; overflow: hidden; display: flex; }
.bar-ai { background: var(--ai-color); }
.bar-human { background: var(--human-color); }
.empty { text-align: center; padding: 24px; color: var(--text-secondary); }
.badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: var(--bg-elevated); color: var(--text-secondary); }
`;

    private async buildHtml(): Promise<string> {
        const files = this.getFileStatsList();
        const daemon = this.cliData.getDaemonStatus();
        let totalAiLines = 0, totalHumanLines = 0;
        for (const f of files) {
            totalAiLines += f.aiLines;
            totalHumanLines += f.humanLines;
        }
        const total = totalAiLines + totalHumanLines;
        const aiPct = total > 0 ? Math.round((totalAiLines / total) * 100) : 0;
        const humanPct = 100 - aiPct;

        const fileRows = files.map(f => {
            const aiW = f.totalLines > 0 ? f.aiPct : 0;
            const humanW = 100 - aiW;
            return `<div class="file-row" onclick="openFile('${this.esc(f.filePath)}')">
                <span class="file-name">${this.esc(f.fileName)}<span style="opacity:0.6">${this.esc(f.ext)}</span></span>
                <span class="file-stats">🤖 ${f.aiLines} | 👤 ${f.humanLines}</span>
                <div style="width:60px"><div class="bar"><div class="bar-ai" style="width:${aiW}%"></div><div class="bar-human" style="width:${humanW}%"></div></div></div>
            </div>`;
        }).join('');

        const emptyMsg = daemon.running
            ? 'No runtime edits tracked yet. Use AI tools with blamely hooks installed.'
            : 'blamely daemon is offline. Run <code>blamely install</code> and <code>blamely daemon</code>.';

        return `<!DOCTYPE html><html><head><style>${SidebarProvider.CSS}</style></head><body>
<div class="header">
  <h2>Changes <span class="badge">${daemon.running ? 'runtime' : 'offline'}</span></h2>
  <button class="btn" onclick="refresh()">Refresh</button>
</div>
<div class="summary">
  <div class="stat stat-ai"><span class="stat-label">AI</span><span class="stat-value">${totalAiLines} ≡ · ${aiPct}%</span></div>
  <div class="stat stat-human"><span class="stat-label">Human</span><span class="stat-value">${totalHumanLines} ≡ · ${humanPct}%</span></div>
</div>
${files.length === 0 ? `<div class="empty">${emptyMsg}</div>` : `<div class="file-list">${fileRows}</div>`}
<script>
const vscode = acquireVsCodeApi();
function refresh() { vscode.postMessage({ command: 'refresh' }); }
function openFile(p) { vscode.postMessage({ command: 'openFile', filePath: p }); }
</script>
</body></html>`;
    }
}

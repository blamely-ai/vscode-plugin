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
  --ai:#5aa2f0; --ai-soft:rgba(90,162,240,.14);
  --human:#5fb56b; --human-soft:rgba(95,181,107,.14);
  --txt: var(--vscode-foreground, #e7e9ee);
  --txt-2: var(--vscode-descriptionForeground, #9aa1ad);
  --txt-3: rgba(127,132,142,.85);
  --surface: rgba(255,255,255,.025);
  --surface-2: rgba(255,255,255,.05);
  --surface-h: rgba(255,255,255,.07);
  --line: rgba(255,255,255,.08);
  --line-soft: rgba(255,255,255,.05);
  --shadow: 0 1px 2px rgba(0,0,0,.28), 0 14px 32px -18px rgba(0,0,0,.6);
  --shadow-sm: 0 1px 2px rgba(0,0,0,.22);
  --mono: var(--vscode-editor-font-family, 'JetBrains Mono', ui-monospace, monospace);
  --sans: var(--vscode-font-family, -apple-system, 'Inter', system-ui, sans-serif);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--sans); font-size: 13px; color: var(--txt); background: var(--vscode-sideBar-background, #1e1f22); padding: 16px 18px 22px; -webkit-font-smoothing: antialiased; }

.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header h2 { font-size: 13px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.badge {
  font-family: var(--mono); font-size: 9.5px; font-weight: 600; letter-spacing: .04em;
  padding: 2px 8px; border-radius: 999px; text-transform: uppercase;
}
.badge.on  { color: var(--human); background: var(--human-soft); border: 1px solid rgba(95,181,107,.25); }
.badge.off { color: var(--txt-3); background: var(--surface-2); border: 1px solid var(--line); }
.btn {
  background: var(--surface-2); border: 1px solid var(--line); color: var(--txt-2);
  padding: 6px 12px; border-radius: 999px; cursor: pointer; font-size: 11px; font-weight: 550;
  font-family: var(--sans); transition: all .15s;
}
.btn:hover { background: var(--surface-h); color: var(--txt); }

.summary {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: var(--shadow); padding: 16px; margin-bottom: 18px;
  display: flex; flex-direction: column; gap: 14px;
}
.ratio { display: flex; height: 9px; border-radius: 999px; overflow: hidden; gap: 2px; background: var(--surface-2); }
.ratio .seg.ai { background: linear-gradient(90deg, #4a93ec, #8cc0ff); }
.ratio .seg.human { background: linear-gradient(90deg, #4ea75c, #82d48d); }
.counts { display: flex; gap: 20px; }
.count { display: flex; flex-direction: column; gap: 3px; }
.count-val { font-family: var(--mono); font-size: 17px; font-weight: 680; letter-spacing: -.01em; }
.count-val.ai { color: var(--ai); } .count-val.human { color: var(--human); }
.count-key { font-size: 10px; color: var(--txt-3); text-transform: uppercase; letter-spacing: .07em; display: flex; align-items: center; gap: 5px; }
.count-key .dot { width: 6px; height: 6px; border-radius: 50%; }
.count-key.ai .dot { background: var(--ai); } .count-key.human .dot { background: var(--human); }

.section-label { font-size: 10px; font-weight: 650; letter-spacing: .1em; text-transform: uppercase; color: var(--txt-3); display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.section-label .count-pill { font-family: var(--mono); font-weight: 600; color: var(--txt-2); background: var(--surface-2); border-radius: 999px; padding: 1px 7px; letter-spacing: 0; }
.section-label::after { content: ''; flex: 1; height: 1px; background: var(--line-soft); }

.file-list { display: flex; flex-direction: column; gap: 9px; }
.file {
  background: var(--surface); border: 1px solid var(--line); border-radius: 11px;
  box-shadow: var(--shadow-sm); padding: 12px 13px; cursor: pointer;
  display: flex; flex-direction: column; gap: 9px;
  transition: background .16s, transform .16s, box-shadow .16s;
}
.file:hover { background: var(--surface-h); transform: translateY(-1px); box-shadow: var(--shadow); }
.file-top { display: flex; align-items: center; gap: 9px; }
.file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; font-size: 12.5px; }
.file-name .ext { color: var(--txt-3); }
.file-ai-pct { font-family: var(--mono); font-size: 10.5px; font-weight: 650; color: var(--ai); background: var(--ai-soft); border-radius: 6px; padding: 2px 7px; flex-shrink: 0; }
.bar { height: 5px; border-radius: 999px; background: var(--surface-2); overflow: hidden; display: flex; gap: 2px; }
.bar-ai { background: linear-gradient(90deg, #4a93ec, #8cc0ff); }
.bar-human { background: linear-gradient(90deg, #4ea75c, #82d48d); }
.file-counts { display: flex; gap: 14px; font-family: var(--mono); font-size: 11px; color: var(--txt-2); }
.file-counts .k { color: var(--txt-3); }
.file-counts .ai { color: var(--ai); } .file-counts .human { color: var(--human); }

.empty { text-align: center; padding: 28px 16px; color: var(--txt-3); font-size: 12px; line-height: 1.5; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; }
.empty code { font-family: var(--mono); font-size: 11px; background: var(--surface-2); padding: 1px 5px; border-radius: 5px; }
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
            return `<div class="file" onclick="openFile('${this.esc(f.filePath)}')">
                <div class="file-top">
                  <span class="file-name">${this.esc(f.fileName)}<span class="ext">${this.esc(f.ext)}</span></span>
                  <span class="file-ai-pct">${aiW}% AI</span>
                </div>
                <div class="bar"><div class="bar-ai" style="width:${aiW}%"></div><div class="bar-human" style="width:${humanW}%"></div></div>
                <div class="file-counts"><span><span class="ai">${this.fmtNum(f.aiLines)}</span> <span class="k">AI</span></span><span><span class="human">${this.fmtNum(f.humanLines)}</span> <span class="k">Human</span></span></div>
            </div>`;
        }).join('');

        const emptyMsg = daemon.running
            ? 'No runtime edits tracked yet. Use AI tools with blamely hooks installed.'
            : 'blamely daemon is offline. Run <code>blamely install</code> and <code>blamely daemon</code>.';

        return `<!DOCTYPE html><html><head><style>${SidebarProvider.CSS}</style></head><body>
<div class="header">
  <h2>Changes <span class="badge ${daemon.running ? 'on' : 'off'}">${daemon.running ? 'runtime' : 'offline'}</span></h2>
  <button class="btn" onclick="refresh()">&#x21bb; Refresh</button>
</div>
<div class="summary">
  <div class="ratio"><div class="seg ai" style="width:${aiPct}%"></div><div class="seg human" style="width:${humanPct}%"></div></div>
  <div class="counts">
    <div class="count"><span class="count-val ai">${this.fmtNum(totalAiLines)}</span><span class="count-key ai"><span class="dot"></span>AI &middot; ${aiPct}%</span></div>
    <div class="count"><span class="count-val human">${this.fmtNum(totalHumanLines)}</span><span class="count-key human"><span class="dot"></span>Human &middot; ${humanPct}%</span></div>
  </div>
</div>
${files.length === 0
                ? `<div class="empty">${emptyMsg}</div>`
                : `<div class="section-label">Files <span class="count-pill">${files.length}</span></div><div class="file-list">${fileRows}</div>`}
<script>
const vscode = acquireVsCodeApi();
function refresh() { vscode.postMessage({ command: 'refresh' }); }
function openFile(p) { vscode.postMessage({ command: 'openFile', filePath: p }); }
</script>
</body></html>`;
    }
}

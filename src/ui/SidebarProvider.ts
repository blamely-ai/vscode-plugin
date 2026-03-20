import * as vscode from 'vscode';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { TraceStore } from '../store/TraceStore';
import * as AiContextExtractor from '../utils/AiContextExtractor';

interface FileStats {
    filePath: string;
    fileName: string;
    ext: string;
    aiChars: number;
    humanChars: number;
    aiLines: number;
    humanLines: number;
    aiPct: number;
    humanPct: number;
    totalChars: number;
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewId = 'aiTraceSidebar';

    private view?: vscode.WebviewView;
    private blameMap: BlameMap;
    private traceStore: TraceStore;
    private refreshInterval?: NodeJS.Timeout;

    constructor(blameMap: BlameMap, traceStore: TraceStore) {
        this.blameMap = blameMap;
        this.traceStore = traceStore;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'refresh') this.refresh();
            if (msg.command === 'openFile' && msg.filePath) {
                this.openFile(msg.filePath);
            }
        });
        this.refresh();
        if (!this.refreshInterval) {
            this.refreshInterval = setInterval(() => this.refresh(), 2000);
        }
    }

    dispose(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
    }

    refresh(): void {
        if (!this.view) return;
        this.view.webview.html = this.buildHtml();
    }

    private openFile(filePath: string): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const uri = workspaceFolder && !filePath.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(filePath)
            ? vscode.Uri.joinPath(workspaceFolder.uri, filePath)
            : vscode.Uri.file(filePath);
        void vscode.window.showTextDocument(uri).then(undefined, () => {
            vscode.window.showErrorMessage(`Could not open ${filePath}`);
        });
    }

    private getFileStatsList(): FileStats[] {
        const files = this.blameMap.getTrackedFiles();
        const result: FileStats[] = [];

        for (const filePath of files) {
            const allEntries = this.blameMap.getBlame(filePath).filter(e => e.commitSha == null);
            if (allEntries.length === 0) continue;

            const byLine = new Map<number, LineBlame>();
            for (const e of allEntries) {
                const existing = byLine.get(e.lineNumber);
                const eTotal = (e.aiChars ?? 0) + (e.humanChars ?? 0);
                const curTotal = existing ? (existing.aiChars ?? 0) + (existing.humanChars ?? 0) : 0;
                if (eTotal >= curTotal) byLine.set(e.lineNumber, e);
            }

            let aiChars = 0, humanChars = 0, aiLines = 0, humanLines = 0;
            for (const e of byLine.values()) {
                aiChars += e.aiChars ?? 0;
                humanChars += e.humanChars ?? 0;
                if (e.authorType === 'AI') aiLines++;
                else humanLines++;
            }

            const totalChars = aiChars + humanChars;
            const aiPct = totalChars > 0 ? Math.round((aiChars / totalChars) * 100) : 0;
            const humanPct = totalChars > 0 ? 100 - aiPct : 0;

            const parts = filePath.split('/');
            const fullName = parts[parts.length - 1] || filePath;
            const dotIdx = fullName.lastIndexOf('.');
            const name = dotIdx > 0 ? fullName.slice(0, dotIdx) : fullName;
            const ext = dotIdx > 0 ? fullName.slice(dotIdx) : '';

            result.push({ filePath, fileName: name, ext, aiChars, humanChars, aiLines, humanLines, aiPct, humanPct, totalChars });
        }

        return result;
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
  --bg-selected:   var(--vscode-list-activeSelectionBackground, #214283);
  --border:        var(--vscode-panel-border, #3d4045);
  --border-subtle: #2a2c30;

  --text-primary:  var(--vscode-foreground, #dfe1e5);
  --text-secondary:var(--vscode-descriptionForeground, #9da0a8);
  --text-muted:    #6b6f76;

  --ai-color:      #4d9de0;
  --ai-bg:         rgba(77,157,224,0.12);
  --human-color:   #56a064;
  --human-bg:      rgba(86,160,100,0.12);
  --del-color:     #e06c75;

  --accent-purple: #9e7bc4;
  --accent-orange: #e5943a;

  --mono: var(--vscode-editor-font-family, 'JetBrains Mono', monospace);
  --sans: var(--vscode-font-family, 'Inter', sans-serif);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.toolbar {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 8px;
  height: 36px;
  flex-shrink: 0;
  user-select: none;
}

.model-selector {
  display: flex; align-items: center; gap: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: default;
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 140px;
}
.model-selector .label { color: var(--text-muted); font-size: 10px; }
.model-selector .value { color: var(--text-primary); font-family: var(--mono); font-weight: 500; flex: 1; }

.toolbar-sep { width: 1px; height: 18px; background: var(--border); margin: 0 8px; }

.toolbar-btn {
  background: none; border: none; cursor: pointer;
  color: var(--text-muted); padding: 4px 6px;
  border-radius: 4px; font-size: 12px;
  transition: color .13s, background .13s;
  display: flex; align-items: center; gap: 4px;
}
.toolbar-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.toolbar-btn .btn-label { font-size: 11px; }

.toolbar-right { margin-left: auto; display: flex; align-items: center; gap: 2px; }

.summary-strip {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
  padding: 6px 12px;
  display: flex; align-items: center; gap: 12px;
  flex-shrink: 0;
}
.summary-stat {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px;
}
.summary-stat .dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.summary-stat.ai-stat   .dot { background: var(--ai-color); box-shadow: 0 0 4px var(--ai-color); }
.summary-stat.human-stat .dot { background: var(--human-color); }
.summary-stat .num { font-family: var(--mono); font-weight: 600; }
.summary-stat.ai-stat   .num { color: var(--ai-color); }
.summary-stat.human-stat .num { color: var(--human-color); }
.summary-stat .pct {
  font-family: var(--mono); font-size: 10px; font-weight: 700;
  padding: 1px 5px; border-radius: 3px;
}
.summary-stat.ai-stat .pct   { background: var(--ai-bg); color: var(--ai-color); }
.summary-stat.human-stat .pct { background: var(--human-bg); color: var(--human-color); }

.seg-bar {
  flex: 1; max-width: 200px;
  display: flex; height: 4px; border-radius: 2px; overflow: hidden; gap: 1px;
}
.seg { height: 100%; border-radius: 2px; }
.seg.ai    { background: linear-gradient(90deg, #3a8fd4, #6ec0f5); }
.seg.human { background: var(--human-color); }

.tree-container {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: 4px 0;
}

.group-row {
  display: flex; align-items: center; gap: 0;
  height: 26px; padding: 0 8px;
  cursor: pointer; user-select: none;
  transition: background .12s;
}
.group-row:hover { background: var(--bg-hover); }

.chevron {
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 10px;
  transition: transform .2s; flex-shrink: 0;
}
.chevron.open { transform: rotate(0deg); }
.chevron.closed { transform: rotate(-90deg); }

.group-icon { margin-right: 5px; font-size: 13px; }

.group-name {
  font-size: 12px; font-weight: 600;
  color: var(--text-primary); flex: 1;
}

.group-count {
  font-family: var(--mono); font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-elevated);
  padding: 1px 6px; border-radius: 10px;
  border: 1px solid var(--border-subtle);
}

.file-list { overflow: hidden; }
.file-list.collapsed { display: none; }

.file-row {
  display: flex; align-items: center;
  height: 24px; padding: 0 8px 0 30px;
  cursor: pointer; user-select: none;
  transition: background .1s;
  gap: 0;
}
.file-row:hover { background: var(--bg-hover); }
.file-row.selected { background: var(--bg-selected); }

.file-icon { margin-right: 6px; font-size: 11px; flex-shrink: 0; opacity: .75; }

.file-name {
  font-family: var(--mono); font-size: 11px;
  color: var(--text-primary); font-weight: 500;
  min-width: 80px; flex-shrink: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.file-name .ext { color: var(--text-muted); }

.file-stats {
  display: flex; align-items: center; gap: 6px;
  margin-left: 10px; flex: 1; min-width: 0;
}

.fs-block {
  display: flex; align-items: center; gap: 4px;
  font-family: var(--mono); font-size: 10px;
}
.fs-block .fs-label { color: var(--text-muted); }
.fs-block .fs-chars { font-weight: 500; }
.fs-block .fs-lines { color: var(--text-muted); }
.fs-block .fs-pct {
  font-weight: 700; padding: 1px 4px; border-radius: 2px;
}
.fs-block.ai-block .fs-chars { color: var(--ai-color); }
.fs-block.ai-block .fs-pct   { color: var(--ai-color); background: var(--ai-bg); }
.fs-block.hu-block .fs-chars { color: var(--human-color); }
.fs-block.hu-block .fs-pct   { color: var(--human-color); background: var(--human-bg); }

.fs-sep { color: var(--border); font-size: 11px; }

.file-bar {
  width: 60px; height: 3px;
  background: var(--bg-elevated);
  border-radius: 2px; overflow: hidden;
  flex-shrink: 0; margin-left: 4px;
}
.file-bar-fill {
  height: 100%; border-radius: 2px;
  background: linear-gradient(90deg, #3a8fd4, #6ec0f5);
}

.empty-state {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; height: 100%;
  color: var(--text-muted); font-size: 12px;
}
.empty-state .icon { font-size: 28px; opacity: .3; }

.status-bar {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-subtle);
  padding: 3px 12px;
  display: flex; align-items: center; gap: 12px;
  font-size: 10px; color: var(--text-muted);
  flex-shrink: 0; font-family: var(--mono);
}
.status-bar .status-ok { color: var(--human-color); }

::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #555; }
`;

    private getFileIcon(ext: string): string {
        const map: Record<string, string> = {
            '.ts': '🟦', '.tsx': '🟦', '.js': '🟨', '.jsx': '🟨',
            '.html': '🌐', '.css': '🎨', '.scss': '🎨', '.less': '🎨',
            '.json': '📋', '.yml': '📋', '.yaml': '📋',
            '.md': '📝', '.py': '🐍', '.java': '☕', '.kt': '🟣',
            '.go': '🔵', '.rs': '🦀', '.rb': '💎', '.php': '🐘',
            '.sh': '📜', '.sql': '🗃️', '.xml': '📄',
        };
        return map[ext.toLowerCase()] || '📄';
    }

    private buildHtml(): string {
        const fileStats = this.getFileStatsList();
        const totalAiChars = fileStats.reduce((s, f) => s + f.aiChars, 0);
        const totalHumanChars = fileStats.reduce((s, f) => s + f.humanChars, 0);
        const totalAiLines = fileStats.reduce((s, f) => s + f.aiLines, 0);
        const totalHumanLines = fileStats.reduce((s, f) => s + f.humanLines, 0);
        const totalChars = totalAiChars + totalHumanChars;
        const aiPct = totalChars > 0 ? Math.round((totalAiChars / totalChars) * 100) : 0;
        const humanPct = totalChars > 0 ? 100 - aiPct : 0;

        const modelName = 'detecting...';
        const interactionTypes = new Set<string>();
        for (const filePath of this.blameMap.getTrackedFiles()) {
            for (const e of this.blameMap.getBlame(filePath)) {
                if (e.commitSha === null && e.interactionType) interactionTypes.add(e.interactionType);
            }
        }
        const typesStr = [...interactionTypes].sort().join(', ') || 'none';

        let h = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>${SidebarProvider.CSS}</style></head><body>`;

        // Toolbar
        h += `<div class="toolbar">`;
        h += `<div class="model-selector">`;
        h += `<span class="label">AI model</span>`;
        h += `<span style="color:var(--border)">|</span>`;
        h += `<span class="value">${this.esc(modelName)}</span>`;
        h += `</div>`;
        h += `<div class="toolbar-sep"></div>`;
        h += `<div class="toolbar-right">`;
        h += `<button class="toolbar-btn" title="Refresh" onclick="(function(){acquireVsCodeApi().postMessage({command:'refresh'})})()">&#x21bb;</button>`;
        h += `</div>`;
        h += `</div>`;

        // Summary strip
        h += `<div class="summary-strip">`;
        h += `<div class="summary-stat ai-stat">`;
        h += `<span class="dot"></span>`;
        h += `<span class="num">${this.fmtNum(totalAiChars)}</span>`;
        h += `<span style="color:var(--text-muted);font-size:11px">chars</span>`;
        h += `<span class="num" style="margin-left:2px">${totalAiLines}</span>`;
        h += `<span style="color:var(--text-muted);font-size:10px">lines</span>`;
        h += `<span class="pct">${aiPct}%</span>`;
        h += `</div>`;

        h += `<div class="seg-bar">`;
        h += `<div class="seg ai" style="width:${aiPct}%"></div>`;
        h += `<div class="seg human" style="width:${humanPct}%"></div>`;
        h += `</div>`;

        h += `<div class="summary-stat human-stat">`;
        h += `<span class="dot"></span>`;
        h += `<span class="num">${this.fmtNum(totalHumanChars)}</span>`;
        h += `<span style="color:var(--text-muted);font-size:11px">chars</span>`;
        h += `<span class="num" style="margin-left:2px">${totalHumanLines}</span>`;
        h += `<span style="color:var(--text-muted);font-size:10px">lines</span>`;
        h += `<span class="pct">${humanPct}%</span>`;
        h += `</div>`;

        h += `<div style="margin-left:auto;font-size:11px;color:var(--text-muted)">${fileStats.length} file${fileStats.length !== 1 ? 's' : ''}</div>`;
        h += `</div>`;

        // Tree container
        h += `<div class="tree-container">`;

        if (fileStats.length === 0) {
            h += `<div class="empty-state"><span class="icon">📂</span><span>No uncommitted changes tracked</span></div>`;
        } else {
            // Changes group
            h += `<div class="group-row" onclick="toggleGroup('changes-group', this)">`;
            h += `<span class="chevron open" id="changes-chevron">&#x25BE;</span>`;
            h += `<span class="group-icon">📁</span>`;
            h += `<span class="group-name">Changes</span>`;
            h += `<span class="group-count">${fileStats.length}</span>`;
            h += `</div>`;

            h += `<div class="file-list" id="changes-group">`;
            for (const f of fileStats) {
                const icon = this.getFileIcon(f.ext);
                h += `<div class="file-row" onclick="selectRow(this); openFile('${this.esc(f.filePath)}')" title="${this.esc(f.filePath)}">`;
                h += `<span class="file-icon">${icon}</span>`;
                h += `<span class="file-name">${this.esc(f.fileName)}<span class="ext">${this.esc(f.ext)}</span></span>`;
                h += `<div class="file-stats">`;

                h += `<div class="fs-block ai-block">`;
                h += `<span class="fs-label">AI:</span>`;
                h += `<span class="fs-chars">${this.fmtNum(f.aiChars)}</span>`;
                h += `<span class="fs-lines">&copy; ${f.aiLines}</span>`;
                h += `<span class="fs-pct">${f.aiPct}%</span>`;
                h += `</div>`;

                h += `<span class="fs-sep">|</span>`;

                h += `<div class="fs-block hu-block">`;
                h += `<span class="fs-label">Human:</span>`;
                h += `<span class="fs-chars">${this.fmtNum(f.humanChars)}</span>`;
                h += `<span class="fs-lines">&copy; ${f.humanLines}</span>`;
                h += `<span class="fs-pct">${f.humanPct}%</span>`;
                h += `</div>`;

                h += `<div class="file-bar"><div class="file-bar-fill" style="width:${f.aiPct}%"></div></div>`;
                h += `</div>`; // file-stats
                h += `</div>`; // file-row
            }
            h += `</div>`; // file-list
        }

        h += `</div>`; // tree-container

        // Status bar
        h += `<div class="status-bar">`;
        h += `<span class="status-ok">&#x25CF; Tracking</span>`;
        h += `<span>${fileStats.length} files tracked</span>`;
        h += `<span>&middot;</span>`;
        h += `<span>${this.esc(typesStr)}</span>`;
        h += `</div>`;

        // Script
        h += `<script>
const vscodeApi = acquireVsCodeApi();
function toggleGroup(groupId, rowEl) {
  const group = document.getElementById(groupId);
  const chevId = groupId.replace('-group', '-chevron');
  const chev = document.getElementById(chevId);
  const isOpen = !group.classList.contains('collapsed');
  if (isOpen) {
    group.classList.add('collapsed');
    chev.classList.remove('open');
    chev.classList.add('closed');
  } else {
    group.classList.remove('collapsed');
    chev.classList.remove('closed');
    chev.classList.add('open');
  }
}
function selectRow(el) {
  document.querySelectorAll('.file-row.selected').forEach(r => r.classList.remove('selected'));
  el.classList.add('selected');
}
function openFile(filePath) {
  vscodeApi.postMessage({ command: 'openFile', filePath: filePath });
}
</script>`;

        h += `</body></html>`;
        return h;
    }
}

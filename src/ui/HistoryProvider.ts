import * as vscode from 'vscode';
import * as GitUtils from '../git/GitUtils';
import * as Logger from '../utils/Logger';

interface CommitReport {
    commitHash: string;
    commitMessage: string;
    branch: string;
    generatedAt: string;
    author: string;
    authorDate: string;
    totalFilesChanged: number;
    totalLinesAdded: number;
    totalLinesDeleted: number;
    totalChanges: number;
    aiLinesAdded: number;
    humanLinesAdded: number;
    aiPercentage: string;
    models: string[];
    interactionTypes: string[];
    timeWaitingForAiMs: number;
    firstStartCodingTime: string;
    codingTimeMs: number;
    modelCount: number;
}

interface ModelDetail {
    totalLines: number;
    commitCount: number;
    interactionTypes: Set<string>;
    nullPromptCount: number;
}

interface OverallData {
    commits: CommitReport[];
    totalAiLines: number;
    totalHumanLines: number;
    totalDeleted: number;
    totalFiles: number;
    totalEdits: number;
    modelDetails: Map<string, ModelDetail>;
    totalWaitingMs: number;
    allInteractionTypes: Set<string>;
    totalCodingTimeMs: number;
}

export class HistoryProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'aiTraceHistory';

    private static readonly BRAIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1.5C5.5 1.5 4.8 2 4.5 2.5C3.8 2.2 3 2.5 2.7 3.2C2.2 3.5 1.8 4.2 2 5C1.5 5.5 1.5 6.3 2 7C1.8 7.7 2 8.5 2.7 9C3 9.5 3.5 9.8 4.2 9.8C4.5 10.5 5.2 11 6 11.2V7" stroke="#AFB1B3" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 1.5C7.5 1.5 8.2 2 8.5 2.5C9.2 2.2 10 2.5 10.3 3.2C10.8 3.5 11.2 4.2 11 5C11.5 5.5 11.5 6.3 11 7C11.2 7.7 11 8.5 10.3 9C10 9.5 9.5 9.8 8.8 9.8C8.5 10.5 7.8 11 7 11.2V7" stroke="#AFB1B3" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 5C5 5.5 5.5 6 6.5 6.5" stroke="#AFB1B3" stroke-width="0.7" stroke-linecap="round"/><path d="M8.5 5C8 5.5 7.5 6 6.5 6.5" stroke="#AFB1B3" stroke-width="0.7" stroke-linecap="round"/></svg>`;

    private view?: vscode.WebviewView;
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'refresh') this.refresh();
        });
        this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.view) return;
        try {
            const data = await this.loadOverallData();
            this.view.webview.html = this.buildHtml(data);
        } catch (err) {
            Logger.error('Failed to load history data', err);
            if (this.view) {
                this.view.webview.html = this.buildEmptyHtml('Failed to load history.');
            }
        }
    }

    private async loadOverallData(): Promise<OverallData> {
        const empty: OverallData = {
            commits: [], totalAiLines: 0, totalHumanLines: 0, totalDeleted: 0,
            totalFiles: 0, totalEdits: 0, modelDetails: new Map(), totalWaitingMs: 0,
            allInteractionTypes: new Set(), totalCodingTimeMs: 0,
        };

        const cwd = await GitUtils.getRepoRoot(this.workspaceRoot);
        if (!cwd) return empty;

        const logOut = await GitUtils.runGitCommand(cwd, 'log', '--format=%H%n%aN%n%ar', '--max-count=50');
        if (!logOut) return empty;
        const logLines = logOut.split('\n').filter(l => l.trim());

        interface GitCommitInfo { sha: string; author: string; date: string; }
        const gitInfos: GitCommitInfo[] = [];
        for (let i = 0; i + 2 < logLines.length; i += 3) {
            gitInfos.push({ sha: logLines[i], author: logLines[i + 1], date: logLines[i + 2] });
        }

        const commits: CommitReport[] = [];
        const globalModelDetails = new Map<string, ModelDetail>();
        const allInteractions = new Set<string>();
        let totalAi = 0, totalHuman = 0, totalDel = 0, totalFiles = 0, totalEdits = 0, totalWait = 0, totalCoding = 0;

        for (const info of gitInfos) {
            const note = await GitUtils.getNoteContent(cwd, info.sha);
            if (!note) continue;
            const report = this.parseReport(note, info.author, info.date);
            if (!report) continue;

            commits.push(report);
            totalAi += report.aiLinesAdded;
            totalHuman += report.humanLinesAdded;
            totalDel += report.totalLinesDeleted;
            totalFiles += report.totalFilesChanged;
            totalEdits += report.totalChanges;
            totalWait += report.timeWaitingForAiMs;
            totalCoding += report.codingTimeMs;
            for (const t of report.interactionTypes) {
                if (t !== 'unknown') allInteractions.add(t);
            }

            const validModels = report.models.filter(m => m !== 'unknown');
            const aiPerModel = validModels.length > 0 ? Math.floor(report.aiLinesAdded / validModels.length) : 0;
            const aiRemainder = validModels.length > 0 ? report.aiLinesAdded % validModels.length : 0;
            for (let mi = 0; mi < validModels.length; mi++) {
                const m = validModels[mi];
                let d = globalModelDetails.get(m);
                if (!d) {
                    d = { totalLines: 0, commitCount: 0, interactionTypes: new Set(), nullPromptCount: 0 };
                    globalModelDetails.set(m, d);
                }
                d.totalLines += aiPerModel + (mi < aiRemainder ? 1 : 0);
                for (const t of report.interactionTypes) {
                    if (t !== 'unknown') d.interactionTypes.add(t);
                }
                d.commitCount++;
            }
        }

        return {
            commits, totalAiLines: totalAi, totalHumanLines: totalHuman, totalDeleted: totalDel,
            totalFiles, totalEdits, modelDetails: globalModelDetails, totalWaitingMs: totalWait,
            allInteractionTypes: allInteractions, totalCodingTimeMs: totalCoding,
        };
    }

    private parseReport(note: string, author: string, authorDate: string): CommitReport | null {
        const lines = note.split('\n');
        const yamlVal = (key: string): string | null => {
            for (const line of lines) {
                const t = line.trim();
                if (t.startsWith(`${key}:`)) return t.slice(key.length + 1).trim().replace(/^"|"$/g, '');
            }
            return null;
        };

        const commitHash = yamlVal('commit_hash');
        if (!commitHash) return null;
        const commitMessage = yamlVal('commit_message') ?? '';
        const branch = yamlVal('branch') ?? '';
        const generatedAt = yamlVal('commitDate') ?? yamlVal('generated_at') ?? '';
        const totalFilesChanged = parseInt(yamlVal('total_files_changed') ?? '0') || 0;
        const totalLinesAdded = parseInt(yamlVal('total_lines_added') ?? '0') || 0;
        const totalLinesDeleted = parseInt(yamlVal('total_lines_deleted') ?? '0') || 0;
        const totalChanges = parseInt(yamlVal('total_changes') ?? '0') || (totalLinesAdded + totalLinesDeleted);
        const aiLinesAdded = parseInt(yamlVal('ai_lines_added') ?? '0') || 0;
        const humanLinesAdded = parseInt(yamlVal('human_lines_added') ?? '0') || 0;
        const aiPercentage = yamlVal('ai_percentage') ?? '0%';
        const timeWaitingForAiMs = parseInt(yamlVal('time_waiting_for_ai_ms') ?? '0') || 0;
        const firstStartCodingTime = yamlVal('first_start_coding_time') ?? '';
        const modelCount = parseInt(yamlVal('model_count') ?? '0') || 0;

        let codingTimeMs = 0;
        if (firstStartCodingTime && firstStartCodingTime !== 'null' && generatedAt) {
            try {
                const start = new Date(firstStartCodingTime).getTime();
                const end = new Date(generatedAt).getTime();
                codingTimeMs = Math.max(0, end - start);
            } catch { /* ignore */ }
        }

        const models: string[] = [];
        const interactionTypes: string[] = [];
        let inModels = false, inInteraction = false;
        for (const line of lines) {
            const t = line.trim();
            if (t === 'models:') { inModels = true; inInteraction = false; continue; }
            if (t === 'interaction_types:') { inInteraction = true; inModels = false; continue; }
            if (t.endsWith(':') && !t.startsWith('-')) { inModels = false; inInteraction = false; }
            if (inModels && t.startsWith('- ')) models.push(t.slice(2).replace(/^"|"$/g, '').trim());
            if (inInteraction && t.startsWith('- ')) interactionTypes.push(t.slice(2).replace(/^"|"$/g, '').trim());
        }

        return {
            commitHash, commitMessage, branch, generatedAt, author, authorDate,
            totalFilesChanged, totalLinesAdded, totalLinesDeleted, totalChanges,
            aiLinesAdded, humanLinesAdded, aiPercentage,
            models, interactionTypes, timeWaitingForAiMs, firstStartCodingTime, codingTimeMs,
            modelCount,
        };
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    private formatDuration(ms: number): string {
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        if (s > 0) return `${s}s`;
        return `${ms}ms`;
    }

    private static readonly CSS = `
:root {
  --bg-primary:    var(--vscode-editor-background, #1e1f22);
  --bg-secondary:  var(--vscode-sideBar-background, #2b2d30);
  --bg-elevated:   var(--vscode-editorGroupHeader-tabsBackground, #313438);
  --bg-hover:      var(--vscode-list-hoverBackground, #383b40);
  --border:        var(--vscode-panel-border, #3d4045);
  --border-subtle: #2e3034;

  --text-primary:  var(--vscode-foreground, #dfe1e5);
  --text-secondary:var(--vscode-descriptionForeground, #9da0a8);
  --text-muted:    #6b6f76;
  --text-code:     #c9d1d9;

  --ai-color:      #4d9de0;
  --ai-glow:       rgba(77,157,224,0.18);
  --human-color:   #56a064;
  --human-glow:    rgba(86,160,100,0.15);
  --delete-color:  #e06c75;
  --delete-glow:   rgba(224,108,117,0.15);

  --accent-blue:   #4d9de0;
  --accent-green:  #56a064;
  --accent-orange: #e5943a;
  --accent-purple: #9e7bc4;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;

  --mono: var(--vscode-editor-font-family, 'JetBrains Mono', 'Fira Code', monospace);
  --sans: var(--vscode-font-family, 'Inter', -apple-system, sans-serif);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
}

.tool-header {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 38px;
  user-select: none;
}
.tool-header .icon {
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.tool-header .icon svg { width: 14px; height: 14px; }
.tool-header h1 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.02em;
  flex: 1;
}
.tool-actions { display: flex; gap: 2px; }
.tool-btn {
  background: none; border: none; cursor: pointer;
  color: var(--text-muted);
  padding: 4px 6px; border-radius: var(--radius-sm);
  font-size: 11px; transition: color .15s, background .15s;
}
.tool-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

.panel { padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }

.overview-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.summary-row {
  display: flex; align-items: center; gap: 10px;
}
.summary-left {
  display: flex; align-items: center; gap: 8px;
}
.summary-right {
  margin-left: auto;
  display: flex; align-items: center; gap: 12px;
}
.meta-chip {
  display: flex; align-items: center; gap: 5px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.meta-chip .dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.meta-chip.commits .dot { background: var(--accent-orange); }
.meta-chip.files   .dot { background: var(--accent-blue); }
.meta-chip.time    .dot { background: var(--accent-green); }
.meta-chip.wait    .dot { background: var(--accent-purple); }
.stat-badge {
  font-family: var(--mono);
  font-size: 12px; font-weight: 600;
  padding: 2px 8px;
  border-radius: 20px;
  letter-spacing: -0.01em;
}
.stat-badge.ai    { color: var(--ai-color);     background: var(--ai-glow);     border: 1px solid rgba(77,157,224,.25); }
.stat-badge.human { color: var(--human-color);  background: var(--human-glow);  border: 1px solid rgba(86,160,100,.25); }
.stat-badge.del   { color: var(--delete-color); background: var(--delete-glow); border: 1px solid rgba(224,108,117,.25); }

.seg-bar {
  display: flex; height: 6px; border-radius: 3px; overflow: hidden; gap: 1.5px;
}
.seg-bar .seg {
  border-radius: 2px;
  transition: width .6s cubic-bezier(.4,0,.2,1);
}
.seg-bar .seg.ai    { background: linear-gradient(90deg, #3a8fd4, #5baee8); }
.seg-bar .seg.human { background: linear-gradient(90deg, #4a9458, #63ba72); }
.seg-bar .seg.del   { background: linear-gradient(90deg, #c55862, #e07a82); }

.section-label {
  font-size: 10px; font-weight: 600; letter-spacing: .09em;
  text-transform: uppercase; color: var(--text-muted);
  padding-left: 2px;
  display: flex; align-items: center; gap: 6px;
}
.section-label::after {
  content: ''; flex: 1; height: 1px; background: var(--border-subtle);
}

.models-grid { display: flex; flex-direction: column; gap: 7px; }
.model-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  cursor: pointer;
  transition: background .15s, border-color .15s, transform .12s;
  position: relative; overflow: hidden;
}
.model-card::before {
  content: '';
  position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px;
  border-radius: 2px 0 0 2px;
  opacity: 0; transition: opacity .2s;
}
.model-card:hover { background: var(--bg-hover); border-color: var(--border); }
.model-card:hover::before { opacity: 1; }
.model-card.rank-1::before { background: var(--ai-color); }
.model-card.rank-2::before { background: var(--accent-green); }
.model-card.rank-3::before { background: var(--accent-orange); }

.model-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 7px;
}
.rank-badge {
  font-family: var(--mono); font-size: 9px; font-weight: 700;
  width: 18px; height: 18px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.rank-1 .rank-badge { background: rgba(77,157,224,.2); color: var(--ai-color); }
.rank-2 .rank-badge { background: rgba(86,160,100,.2); color: var(--accent-green); }
.rank-3 .rank-badge { background: rgba(229,148,58,.2);  color: var(--accent-orange); }

.model-name {
  font-family: var(--mono); font-size: 12px; font-weight: 600;
  color: var(--text-primary); flex: 1;
}
.model-meta {
  font-size: 11px; color: var(--text-muted);
  display: flex; gap: 10px;
}
.model-meta span { font-family: var(--mono); }
.model-meta .highlight { color: var(--text-secondary); }

.model-bar-track {
  height: 4px; background: var(--bg-elevated); border-radius: 2px; overflow: hidden;
}
.model-bar-fill {
  height: 100%; border-radius: 2px;
  transition: width .7s cubic-bezier(.4,0,.2,1) .1s;
}
.rank-1 .model-bar-fill { background: linear-gradient(90deg, #3a8fd4 0%, #7ec8f8 100%); }
.rank-2 .model-bar-fill { background: linear-gradient(90deg, #4a9458 0%, #7ad485 100%); }
.rank-3 .model-bar-fill { background: linear-gradient(90deg, #c97a28 0%, #e8b060 100%); }

.commits-table {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.table-head {
  display: grid;
  grid-template-columns: 62px 75px 1fr 60px 60px 120px 60px 80px;
  padding: 7px 12px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  gap: 8px;
}
.th {
  font-size: 10px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--text-muted);
}
.th.right { text-align: right; }

.commit-row {
  display: grid;
  grid-template-columns: 62px 75px 1fr 60px 60px 120px 60px 80px;
  padding: 8px 12px; gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: background .12s;
}
.commit-row:last-child { border-bottom: none; }
.commit-row:hover { background: var(--bg-hover); }

.commit-hash {
  font-family: var(--mono); font-size: 11px; font-weight: 600;
  color: var(--accent-blue);
  text-decoration: none;
}

.commit-msg {
  font-size: 12px; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.diff-add  { font-family: var(--mono); font-size: 11px; color: var(--human-color); text-align: right; }
.diff-del  { font-family: var(--mono); font-size: 11px; color: var(--delete-color); text-align: right; }
.coding-time { font-family: var(--mono); font-size: 10px; color: var(--text-secondary); white-space: nowrap; }
.commit-author { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 75px; }

.mini-bar-cell { display: flex; align-items: center; gap: 5px; }
.mini-bar-track {
  flex: 1; height: 4px; background: var(--bg-elevated);
  border-radius: 2px; overflow: hidden;
}
.mini-bar-fill {
  height: 100%; border-radius: 2px;
  background: linear-gradient(90deg, #3a8fd4, #7ec8f8);
}
.mini-pct {
  font-family: var(--mono); font-size: 10px;
  font-weight: 600; color: var(--ai-color);
  min-width: 36px; text-align: right;
}

.tag {
  display: inline-flex; align-items: center;
  padding: 2px 6px; border-radius: 3px;
  font-size: 10px; font-weight: 500;
  white-space: nowrap;
}
.tag.type-completion { background: rgba(158,123,196,.15); color: var(--accent-purple); border: 1px solid rgba(158,123,196,.25); }
.tag.type-chat_panel { background: rgba(229,148,58,.12); color: var(--accent-orange); border: 1px solid rgba(229,148,58,.2); }
.tag.type-chat_inline { background: rgba(77,157,224,.15); color: var(--accent-blue); border: 1px solid rgba(77,157,224,.25); }
.tag.type-branch { background: rgba(158,123,196,.15); color: var(--accent-purple); border: 1px solid rgba(158,123,196,.25); }
.tag.type-default { background: rgba(158,123,196,.15); color: var(--accent-purple); border: 1px solid rgba(158,123,196,.25); }

.panel-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 2px;
}
.footer-info { font-size: 11px; color: var(--text-muted); font-family: var(--mono); }
.refresh-btn {
  background: none; border: 1px solid var(--border);
  color: var(--text-secondary); cursor: pointer;
  padding: 4px 10px; border-radius: var(--radius-sm);
  font-size: 11px; font-family: var(--sans);
  transition: all .15s; display: flex; align-items: center; gap: 5px;
}
.refresh-btn:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--border); }

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.overview-card { animation: fadeUp .3s ease both; }
.models-grid   { animation: fadeUp .3s ease .05s both; }
.commits-table { animation: fadeUp .3s ease .1s both; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
`;

    private buildEmptyHtml(message: string): string {
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>${HistoryProvider.CSS}</style></head><body>
<div class="tool-header">
  <div class="icon">${HistoryProvider.BRAIN_SVG}</div>
  <h1>Blamely</h1>
</div>
<div class="panel">
  <div class="overview-card">
    <p style="color:var(--text-muted);font-size:12px">${this.esc(message)}</p>
  </div>
</div>
</body></html>`;
    }

    private buildHtml(data: OverallData): string {
        if (data.commits.length === 0) {
            return this.buildEmptyHtml('No Blamely reports found in git notes.');
        }

        const totalAll = data.totalAiLines + data.totalHumanLines;
        const aiPct = totalAll > 0 ? (100.0 * data.totalAiLines / totalAll) : 0;
        const humanPct = 100.0 - aiPct;

        const sortedModels = [...data.modelDetails.entries()].sort((a, b) => b[1].totalLines - a[1].totalLines).slice(0, 3);
        const totalModelLines = sortedModels.reduce((s, e) => s + e[1].totalLines, 0);

        const interactionList = [...data.allInteractionTypes].sort().join(', ');

        let h = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>${HistoryProvider.CSS}</style></head><body>`;

        // Tool header
        h += `<div class="tool-header">`;
        h += `<div class="icon">${HistoryProvider.BRAIN_SVG}</div>`;
        h += `<h1>Blamely</h1>`;
        h += `<div class="tool-actions">`;
        h += `<button class="tool-btn" title="Refresh" onclick="(function(){acquireVsCodeApi().postMessage({command:'refresh'})})()">&#x21bb;</button>`;
        h += `</div></div>`;

        h += `<div class="panel">`;

        // Overview card
        h += `<div class="overview-card">`;
        h += `<div class="summary-row">`;
        h += `<div class="summary-left">`;
        h += `<span class="stat-badge ai">${data.totalAiLines} AI lines &middot; ${aiPct.toFixed(1)}%</span>`;
        h += `<span class="stat-badge human">${data.totalHumanLines} Human &middot; ${humanPct.toFixed(1)}%</span>`;
        h += `</div>`;
        h += `<div class="summary-right">`;
        h += `<span class="meta-chip commits"><span class="dot"></span>${data.commits.length} commits</span>`;
        h += `<span class="meta-chip files"><span class="dot"></span>${data.totalFiles} files</span>`;
        if (data.totalCodingTimeMs > 0) {
            h += `<span class="meta-chip time"><span class="dot"></span>Coding: ${this.formatDuration(data.totalCodingTimeMs)}</span>`;
        }
        if (data.totalWaitingMs > 0) {
            h += `<span class="meta-chip wait"><span class="dot"></span>AI wait: ${this.formatDuration(data.totalWaitingMs)}</span>`;
        }
        h += `</div>`;
        h += `</div>`;

        h += `<div class="seg-bar">`;
        h += `<div class="seg ai" style="width:${aiPct.toFixed(1)}%"></div>`;
        h += `<div class="seg human" style="width:${humanPct.toFixed(1)}%"></div>`;
        h += `</div>`;
        h += `</div>`; // overview-card

        // Models section
        if (sortedModels.length > 0) {
            h += `<div class="section-label">AI Models (${sortedModels.length})</div>`;
            h += `<div class="models-grid">`;

            for (let i = 0; i < sortedModels.length; i++) {
                const [modelName, detail] = sortedModels[i];
                const rank = i + 1;
                const pct = totalModelLines > 0 ? (100.0 * detail.totalLines / totalModelLines).toFixed(1) : '0';
                const typeList = [...detail.interactionTypes].sort().join(', ');

                h += `<div class="model-card rank-${rank}">`;
                h += `<div class="model-header">`;
                h += `<div class="rank-badge">#${rank}</div>`;
                h += `<span class="model-name">${this.esc(modelName)}</span>`;
                h += `<div class="model-meta">`;
                h += `<span class="highlight">${detail.totalLines} lines</span>`;
                h += `<span>${pct}%</span>`;
                h += `<span>${detail.commitCount} commit${detail.commitCount !== 1 ? 's' : ''}</span>`;
                if (typeList) {
                    h += `<span>${this.esc(typeList)}</span>`;
                }
                h += `</div></div>`;
                h += `<div class="model-bar-track"><div class="model-bar-fill" style="width:${pct}%"></div></div>`;
                h += `</div>`; // model-card
            }

            h += `</div>`; // models-grid
        }

        // Commits section
        h += `<div class="section-label">Commits (${data.commits.length})</div>`;
        h += `<div class="commits-table">`;
        h += `<div class="table-head">`;
        h += `<div class="th">Hash</div>`;
        h += `<div class="th">Author</div>`;
        h += `<div class="th">Message</div>`;
        h += `<div class="th right">+Add</div>`;
        h += `<div class="th right">&minus;Del</div>`;
        h += `<div class="th">AI %</div>`;
        h += `<div class="th">Coding</div>`;
        h += `<div class="th">Branch</div>`;
        h += `</div>`;

        for (const report of data.commits) {
            const sha = report.commitHash.slice(0, 7);
            const rawMsg = report.commitMessage.replace(/\n/g, ' ').trim();
            const msg = this.esc(rawMsg);
            const aiPctNum = parseFloat(report.aiPercentage.replace('%', '')) || 0;
            const pctLabel = aiPctNum.toFixed(1);

            const tagHtml = report.branch
                ? `<span class="tag type-branch">${this.esc(report.branch)}</span>`
                : '';

            const authorDisplay = report.author?.trim() ? this.esc(report.author) : '—';
            h += `<div class="commit-row">`;
            h += `<span class="commit-hash">${sha}</span>`;
            h += `<div class="commit-author" title="${report.authorDate ? this.esc(report.author + ' · ' + report.authorDate) : authorDisplay}">${authorDisplay}</div>`;
            h += `<div class="commit-msg" title="${this.esc(rawMsg)}">${msg}</div>`;
            h += `<div class="diff-add">+${report.totalLinesAdded}</div>`;
            h += `<div class="diff-del">&minus;${report.totalLinesDeleted}</div>`;
            h += `<div class="mini-bar-cell"><div class="mini-bar-track"><div class="mini-bar-fill" style="width:${Math.min(aiPctNum, 100)}%"></div></div><span class="mini-pct">${pctLabel}%</span></div>`;
            h += `<div class="coding-time">${report.codingTimeMs > 0 ? this.formatDuration(report.codingTimeMs) : '—'}</div>`;
            h += `<div>${tagHtml}</div>`;
            h += `</div>`; // commit-row
        }

        h += `</div>`; // commits-table

        // Footer
        h += `<div class="panel-footer">`;
        h += `<span class="footer-info">last synced: just now`;
        if (interactionList) {
            h += ` &middot; ${this.esc(interactionList)}`;
        }
        h += `</span>`;
        h += `<button class="refresh-btn" onclick="(function(){acquireVsCodeApi().postMessage({command:'refresh'})})()">&#x21bb; Refresh</button>`;
        h += `</div>`;

        h += `</div>`; // panel
        h += `</body></html>`;
        return h;
    }
}

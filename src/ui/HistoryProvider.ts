import * as vscode from 'vscode';
import * as GitUtils from '../git/GitUtils';
import { parseCliNote, genTypesFromNote, modelsFromNote } from '../cli/NoteParser';
import { CliNote } from '../cli/types';
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
    aiLinesDeleted: number;
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
    public static readonly viewId = 'blamelyHistory';

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
            if (msg.command === 'refresh') {
                void this.refresh();
            }
        });
        void this.refresh();
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
            const report = this.parseReport(note, info.author, info.date, info.sha);
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

    private parseReport(note: string, author: string, authorDate: string, sha: string): CommitReport | null {
        const cli = parseCliNote(note);
        if (cli) {
            return this.parseCliReport(cli, author, authorDate);
        }
        return null;
    }

    private parseCliReport(note: CliNote, author: string, authorDate: string): CommitReport {
        const ai = note.totals.ai_added_lines ?? note.totals.ai_lines ?? 0;
        const human = note.totals.human_added_lines ?? note.totals.human_lines ?? 0;
        const total = ai + human;
        const aiPct = total > 0 ? `${Math.round((ai / total) * 100)}%` : '0%';
        const models = modelsFromNote(note);
        const interactionTypes = genTypesFromNote(note);
        const totalAdded = ai + human;
        return {
            commitHash: note.commit,
            commitMessage: note.message ?? '',
            branch: note.branch ?? '',
            generatedAt: authorDate,
            author,
            authorDate,
            totalFilesChanged: note.totals.files,
            totalLinesAdded: totalAdded,
            totalLinesDeleted: note.totals.deleted_lines,
            aiLinesDeleted: note.totals.ai_deleted_lines ?? 0,
            totalChanges: totalAdded + note.totals.deleted_lines,
            aiLinesAdded: ai,
            humanLinesAdded: human,
            aiPercentage: aiPct,
            models,
            interactionTypes,
            timeWaitingForAiMs: 0,
            firstStartCodingTime: '',
            codingTimeMs: Math.round((note.coding_time_nanos ?? 0) / 1e6),
            modelCount: models.length,
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
  --ai:        #5aa2f0;
  --ai-soft:   rgba(90,162,240,.14);
  --human:     #5fb56b;
  --human-soft:rgba(95,181,107,.14);
  --del:       #e8707a;
  --amber:     #e9a23b;
  --violet:    #a78bd6;

  --txt:   var(--vscode-foreground, #e7e9ee);
  --txt-2: var(--vscode-descriptionForeground, #9aa1ad);
  --txt-3: rgba(127,132,142,.85);

  /* Theme-agnostic elevation: translucent overlays read well on any VS Code
     theme (the sidebar bg shows through), giving the soft "floating card" feel. */
  --surface:    rgba(255,255,255,.025);
  --surface-2:  rgba(255,255,255,.05);
  --surface-h:  rgba(255,255,255,.07);
  --line:       rgba(255,255,255,.08);
  --line-soft:  rgba(255,255,255,.05);
  --shadow:     0 1px 2px rgba(0,0,0,.28), 0 14px 32px -18px rgba(0,0,0,.6);
  --shadow-sm:  0 1px 2px rgba(0,0,0,.22);

  --r:    14px;
  --r-md: 11px;
  --r-sm: 8px;

  --mono: var(--vscode-editor-font-family, 'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace);
  --sans: var(--vscode-font-family, -apple-system, 'Inter', system-ui, sans-serif);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--sans);
  background: var(--vscode-sideBar-background, #1e1f22);
  color: var(--txt);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ── header ─────────────────────────────────────────────────────────────── */
.tool-header {
  display: flex; align-items: center; gap: 9px;
  padding: 14px 18px 4px;
  user-select: none;
}
.tool-header .icon {
  width: 26px; height: 26px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  background: var(--ai-soft);
  border: 1px solid rgba(90,162,240,.22);
}
.tool-header .icon svg { width: 14px; height: 14px; }
.tool-header h1 {
  font-size: 13px; font-weight: 650; color: var(--txt);
  letter-spacing: .01em; flex: 1;
}
.tool-actions { display: flex; gap: 2px; }
.tool-btn {
  background: none; border: none; cursor: pointer; color: var(--txt-3);
  width: 28px; height: 28px; border-radius: 8px; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  transition: color .15s, background .15s;
}
.tool-btn:hover { color: var(--txt); background: var(--surface-2); }

.panel { padding: 10px 18px 22px; display: flex; flex-direction: column; gap: 18px; }
.history-hint {
  font-size: 11.5px; color: var(--txt-3); line-height: 1.45; margin: 0;
}
.history-hint code {
  font-family: var(--mono); font-size: 10.5px;
  background: var(--surface-2); padding: 1px 5px; border-radius: 5px;
}

/* ── hero (overview) ────────────────────────────────────────────────────── */
.hero {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  padding: 18px;
  display: flex; flex-direction: column; gap: 16px;
}
.hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.hero-pct {
  font-size: 38px; font-weight: 720; line-height: 1; letter-spacing: -.02em;
  background: linear-gradient(135deg, #8cc0ff 0%, var(--ai) 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.hero-sub { font-size: 11px; color: var(--txt-2); margin-top: 4px; letter-spacing: .02em; }
.hero-tag {
  font-family: var(--mono); font-size: 10px; font-weight: 600;
  color: var(--ai); background: var(--ai-soft);
  border: 1px solid rgba(90,162,240,.25);
  padding: 4px 9px; border-radius: 999px; white-space: nowrap;
}
.ratio { display: flex; height: 9px; border-radius: 999px; overflow: hidden; gap: 2px; background: var(--surface-2); }
.ratio .seg { transition: width .7s cubic-bezier(.4,0,.2,1); }
.ratio .seg.ai    { background: linear-gradient(90deg, #4a93ec, #8cc0ff); }
.ratio .seg.human { background: linear-gradient(90deg, #4ea75c, #82d48d); }
.hero-counts { display: flex; gap: 18px; }
.count { display: flex; flex-direction: column; gap: 3px; }
.count-val { font-size: 16px; font-weight: 680; font-family: var(--mono); letter-spacing: -.01em; }
.count-val.ai { color: var(--ai); }
.count-val.human { color: var(--human); }
.count-key { font-size: 10px; color: var(--txt-3); display: flex; align-items: center; gap: 5px; text-transform: uppercase; letter-spacing: .07em; }
.count-key .dot { width: 6px; height: 6px; border-radius: 50%; }
.count-key.ai .dot { background: var(--ai); }
.count-key.human .dot { background: var(--human); }

/* stat strip under the hero */
.stat-strip {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 8px; padding-top: 14px; border-top: 1px solid var(--line-soft);
}
.stat { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.stat-num { font-family: var(--mono); font-size: 14px; font-weight: 640; color: var(--txt); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-key { font-size: 9.5px; color: var(--txt-3); text-transform: uppercase; letter-spacing: .07em; }
.add { color: var(--human); }
.del { color: var(--del); }
.del-ai { color: var(--ai); }
.hero-wait { display: flex; align-items: center; justify-content: space-between; padding-top: 12px; border-top: 1px solid var(--line-soft); font-family: var(--mono); font-size: 11px; color: var(--txt-2); }
.hero-wait .k { display: flex; align-items: center; gap: 5px; color: var(--txt-3); }

/* ── section labels ─────────────────────────────────────────────────────── */
.section-label {
  font-size: 10px; font-weight: 650; letter-spacing: .1em;
  text-transform: uppercase; color: var(--txt-3);
  display: flex; align-items: center; gap: 10px; padding: 0 2px;
}
.section-label .count-pill {
  font-family: var(--mono); font-weight: 600; color: var(--txt-2);
  background: var(--surface-2); border-radius: 999px; padding: 1px 7px; letter-spacing: 0;
}
.section-label::after { content: ''; flex: 1; height: 1px; background: var(--line-soft); }

/* ── model cards ────────────────────────────────────────────────────────── */
.models-grid { display: flex; flex-direction: column; gap: 9px; }
.model-card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); box-shadow: var(--shadow-sm);
  padding: 13px 14px; cursor: default; position: relative; overflow: hidden;
  transition: background .16s, border-color .16s, transform .16s, box-shadow .16s;
}
.model-card::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
}
.model-card.rank-1::before { background: linear-gradient(var(--ai), #8cc0ff); }
.model-card.rank-2::before { background: linear-gradient(var(--human), #82d48d); }
.model-card.rank-3::before { background: linear-gradient(var(--amber), #f3c073); }
.model-card:hover { background: var(--surface-h); border-color: var(--line); transform: translateY(-1px); box-shadow: var(--shadow); }

.model-header { display: flex; align-items: center; gap: 10px; margin-bottom: 11px; }
.rank-badge {
  font-family: var(--mono); font-size: 10px; font-weight: 700;
  width: 22px; height: 22px; border-radius: 7px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.rank-1 .rank-badge { background: var(--ai-soft); color: var(--ai); }
.rank-2 .rank-badge { background: var(--human-soft); color: var(--human); }
.rank-3 .rank-badge { background: rgba(233,162,59,.16); color: var(--amber); }
.model-name { font-family: var(--mono); font-size: 12.5px; font-weight: 620; color: var(--txt); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-meta { font-size: 11px; color: var(--txt-3); display: flex; flex-wrap: wrap; gap: 4px 12px; }
.model-meta span { font-family: var(--mono); }
.model-meta .highlight { color: var(--txt-2); font-weight: 600; }
.model-bar-track { height: 5px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.model-bar-fill { height: 100%; border-radius: 999px; transition: width .8s cubic-bezier(.4,0,.2,1) .1s; }
.rank-1 .model-bar-fill { background: linear-gradient(90deg, #4a93ec, #8cc0ff); }
.rank-2 .model-bar-fill { background: linear-gradient(90deg, #4ea75c, #82d48d); }
.rank-3 .model-bar-fill { background: linear-gradient(90deg, #d6912f, #f3c073); }

/* ── commit cards (replaces the cramped table) ──────────────────────────── */
.commit-list { display: flex; flex-direction: column; gap: 9px; }
.commit {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); box-shadow: var(--shadow-sm);
  padding: 12px 14px; cursor: default;
  display: flex; flex-direction: column; gap: 10px;
  transition: background .16s, border-color .16s, transform .16s, box-shadow .16s;
}
.commit:hover { background: var(--surface-h); transform: translateY(-1px); box-shadow: var(--shadow); }
.commit-top { display: flex; align-items: center; gap: 9px; }
.commit-hash {
  font-family: var(--mono); font-size: 10.5px; font-weight: 650; color: var(--ai);
  background: var(--ai-soft); border-radius: 6px; padding: 2px 7px; flex-shrink: 0;
}
.commit-msg { font-size: 12.5px; color: var(--txt); font-weight: 500; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.commit-branch {
  font-family: var(--mono); font-size: 9.5px; color: var(--violet);
  background: rgba(167,139,214,.14); border: 1px solid rgba(167,139,214,.22);
  border-radius: 999px; padding: 2px 8px; flex-shrink: 0; max-width: 90px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.commit-ai-bar { height: 5px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.commit-ai-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #4a93ec, #8cc0ff); transition: width .7s cubic-bezier(.4,0,.2,1); }
.commit-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.cstat { display: flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; color: var(--txt-2); }
.cstat .k { color: var(--txt-3); }
.cstat.ai-pct { margin-left: auto; color: var(--ai); font-weight: 650; }
.cstat .add { color: var(--human); }
.cstat .del { color: var(--del); }
.cstat .del-ai { color: var(--ai); }
.commit-meta { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.model-chip { font-family: var(--mono); font-size: 9.5px; font-weight: 600; color: var(--txt-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; }
.gt-chip { font-family: var(--mono); font-size: 9.5px; font-weight: 600; border-radius: 999px; padding: 2px 8px; text-transform: capitalize; }
.gt-chip.gt-chat { color: var(--amber); background: rgba(233,162,59,.14); border: 1px solid rgba(233,162,59,.22); }
.gt-chip.gt-completion { color: var(--ai); background: var(--ai-soft); border: 1px solid rgba(90,162,240,.22); }
.gt-chip.gt-cli { color: var(--violet); background: rgba(167,139,214,.14); border: 1px solid rgba(167,139,214,.22); }

/* ── footer ─────────────────────────────────────────────────────────────── */
.panel-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 2px; }
.footer-info { font-size: 10.5px; color: var(--txt-3); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.refresh-btn {
  background: var(--surface-2); border: 1px solid var(--line);
  color: var(--txt-2); cursor: pointer; flex-shrink: 0;
  padding: 6px 12px; border-radius: 999px; font-size: 11px; font-family: var(--sans); font-weight: 550;
  transition: all .15s; display: flex; align-items: center; gap: 6px;
}
.refresh-btn:hover { background: var(--surface-h); color: var(--txt); }

/* ── overview card (IntelliJ-style) ── */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); padding: 16px; display: flex; flex-direction: column; gap: 11px; }
.ov-sub { font-size: 11.5px; color: var(--txt-2); }
.ov-sub .mono { font-family: var(--mono); color: var(--ai); font-weight: 600; }
.ov-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.badges { display: flex; flex-wrap: wrap; gap: 8px; }
.badge { font-family: var(--mono); font-size: 11px; font-weight: 650; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.badge.ai { color: var(--ai); background: var(--ai-soft); border: 1px solid rgba(90,162,240,.28); }
.badge.human { color: var(--human); background: var(--human-soft); border: 1px solid rgba(95,181,107,.28); }
.badge.del { color: var(--del); background: rgba(232,112,122,.13); border: 1px solid rgba(232,112,122,.26); }
.chips { display: flex; flex-wrap: wrap; gap: 9px 14px; }
.chip { font-size: 10.5px; color: var(--txt-2); display: flex; align-items: center; gap: 5px; }
.chip::before { content: ''; width: 6px; height: 6px; border-radius: 50%; }
.chip.orange::before { background: var(--amber); }
.chip.blue::before { background: var(--ai); }
.chip.green::before { background: var(--human); }
.chip.purple::before { background: var(--violet); }
.ov-label { font-size: 10px; color: var(--txt-3); text-transform: uppercase; letter-spacing: .06em; margin-top: 3px; }
.ov-label .ins { color: var(--human); font-family: var(--mono); font-weight: 650; text-transform: none; }
.ov-label .del { color: var(--del); font-family: var(--mono); font-weight: 650; text-transform: none; }
.ov-label .vsep { color: var(--line); }
.bar2 { display: flex; height: 7px; border-radius: 999px; overflow: hidden; gap: 2px; background: var(--surface-2); }
.bar2 .ai { background: linear-gradient(90deg, #4a93ec, #8cc0ff); }
.bar2 .human { background: linear-gradient(90deg, #4ea75c, #82d48d); }
.idbar { display: flex; height: 6px; border-radius: 999px; overflow: hidden; background: var(--surface-2); }
.idbar .ins { background: var(--human); }
.idbar .d-ai { background: var(--ai); }
.idbar .d-h { background: var(--del); }
.ov-divider { height: 1px; background: var(--line-soft); margin: 3px 0; }

/* ── commits table (mirrors IntelliJ columns) ── */
.table-wrap { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--shadow-sm); overflow-x: auto; }
.ctable { border-collapse: collapse; width: 100%; font-size: 11.5px; }
.ctable th { font-size: 9px; font-weight: 650; letter-spacing: .06em; color: var(--txt-3); text-transform: uppercase; text-align: left; padding: 9px 10px; background: var(--surface-2); white-space: nowrap; }
.ctable th.r, .ctable td.r { text-align: right; }
.ctable td { padding: 9px 10px; border-top: 1px solid var(--line-soft); white-space: nowrap; color: var(--txt); }
.ctable tbody tr:hover { background: var(--surface-h); }
.ctable .hash { font-family: var(--mono); font-weight: 650; color: var(--ai); }
.ctable .author { color: var(--txt-2); max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
.ctable .msg { color: var(--txt); max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.ctable .add { color: var(--human); font-family: var(--mono); }
.ctable td.del { color: var(--del); font-family: var(--mono); }
.ctable .time { color: var(--txt-2); font-family: var(--mono); }
.ctable .aipct { display: flex; align-items: center; gap: 6px; min-width: 96px; }
.ctable .mini { flex: 1; height: 4px; min-width: 44px; background: var(--surface-2); border-radius: 999px; overflow: hidden; display: inline-block; }
.ctable .mini-fill { display: block; height: 100%; background: linear-gradient(90deg, #4a93ec, #8cc0ff); border-radius: 999px; }
.ctable .aip { font-family: var(--mono); font-weight: 650; color: var(--ai); min-width: 30px; text-align: right; }
.branch { font-family: var(--mono); font-size: 9.5px; color: var(--amber); background: rgba(233,162,59,.13); border: 1px solid rgba(233,162,59,.22); border-radius: 999px; padding: 2px 8px; }
.branch.b-main { color: var(--violet); background: rgba(167,139,214,.14); border-color: rgba(167,139,214,.22); }

@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.hero        { animation: fadeUp .34s cubic-bezier(.4,0,.2,1) both; }
.models-grid { animation: fadeUp .34s cubic-bezier(.4,0,.2,1) .05s both; }
.commit-list { animation: fadeUp .34s cubic-bezier(.4,0,.2,1) .1s both; }

::-webkit-scrollbar { width: 7px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
::-webkit-scrollbar-thumb:hover { background: var(--surface-h); }
`;

    private buildEmptyHtml(message: string): string {
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>${HistoryProvider.CSS}</style></head><body>
<div class="tool-header">
  <div class="icon">${HistoryProvider.BRAIN_SVG}</div>
  <h1>Blamely · History</h1>
  <div class="tool-actions">
    <button type="button" class="tool-btn" title="Refresh" onclick="refreshHistory()">&#x21bb;</button>
  </div>
</div>
<div class="panel">
  <p class="history-hint">Shows commits that have a Blamely report in git notes (<code>refs/notes/blamely</code>) — typically after you commit with the extension active.</p>
  <div class="hero">
    <p style="color:var(--txt-2);font-size:12.5px">${this.esc(message)}</p>
  </div>
</div>
<script>const vscodeApi=acquireVsCodeApi();function refreshHistory(){vscodeApi.postMessage({command:'refresh'});}</script>
</body></html>`;
    }

    private buildHtml(data: OverallData): string {
        if (data.commits.length === 0) {
            return this.buildEmptyHtml('No Blamely reports found in git notes yet.');
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
        h += `<h1>Blamely · History</h1>`;
        h += `<div class="tool-actions">`;
        h += `<button type="button" class="tool-btn" title="Refresh" onclick="refreshHistory()">&#x21bb;</button>`;
        h += `</div></div>`;

        h += `<div class="panel">`;
        h += `<p class="history-hint">Committed work only: each row is a past commit with a Blamely snapshot in <code>refs/notes/blamely</code>. Current edits stay in <strong>Blamely: Changes</strong>.</p>`;

        // ── Overview: latest commit (mirrors the IntelliJ History design) ──
        const latest = data.commits[0];
        const latestAdd = latest.aiLinesAdded + latest.humanLinesAdded;
        const latestAiPctAdd = latestAdd > 0 ? (100.0 * latest.aiLinesAdded / latestAdd) : 0;
        const latestHumanPctAdd = 100.0 - latestAiPctAdd;
        const latestAiDel = latest.aiLinesDeleted;
        const latestHumanDel = Math.max(0, latest.totalLinesDeleted - latestAiDel);
        const idTot = latest.totalLinesAdded + latest.totalLinesDeleted;
        const insW = idTot > 0 ? (100.0 * latest.totalLinesAdded / idTot) : 0;
        const aiDelW = idTot > 0 ? (100.0 * latestAiDel / idTot) : 0;
        const humDelW = idTot > 0 ? (100.0 * latestHumanDel / idTot) : 0;

        // Totals across all commits.
        let totAiDel = 0;
        const toolSet = new Set<string>();
        for (const c of data.commits) {
            totAiDel += c.aiLinesDeleted;
            for (const m of c.models) { if (m && m !== 'unknown') { toolSet.add(m); } }
        }
        const totHumanDel = Math.max(0, data.totalDeleted - totAiDel);
        const toolsLabel = toolSet.size === 0 ? '&mdash;'
            : (toolSet.size <= 2 ? [...toolSet].map(t => this.esc(t)).join(', ') : `${toolSet.size} tools`);

        h += `<div class="card">`;
        h += `<div class="ov-sub">Latest commit <span class="mono">${latest.commitHash.slice(0, 7)}</span></div>`;
        h += `<div class="ov-row">`;
        h += `<div class="badges">`;
        h += `<span class="badge ai">${latest.aiLinesAdded} AI &middot; ${latestAiPctAdd.toFixed(1)}%</span>`;
        h += `<span class="badge human">${latest.humanLinesAdded} Human &middot; ${latestHumanPctAdd.toFixed(1)}%</span>`;
        h += `</div>`;
        h += `<div class="chips">`;
        h += `<span class="chip orange">${data.commits.length} in history</span>`;
        h += `<span class="chip blue">${latest.totalFilesChanged} files</span>`;
        if (latest.codingTimeMs > 0) { h += `<span class="chip green">Coding ${this.formatDuration(latest.codingTimeMs)}</span>`; }
        if (latest.timeWaitingForAiMs > 0) { h += `<span class="chip purple">AI wait ${this.formatDuration(latest.timeWaitingForAiMs)}</span>`; }
        h += `</div></div>`;

        h += `<div class="ov-label">AI vs Human (lines added)</div>`;
        h += `<div class="bar2"><span class="ai" style="width:${latestAiPctAdd.toFixed(1)}%"></span><span class="human" style="width:${latestHumanPctAdd.toFixed(1)}%"></span></div>`;

        h += `<div class="ov-label">Insert / delete (commit diff) &nbsp;<span class="ins">+${latest.totalLinesAdded}</span> insert <span class="vsep">|</span> <span class="del">&minus;${latest.totalLinesDeleted}</span> delete</div>`;
        h += `<div class="idbar"><span class="ins" style="width:${insW.toFixed(1)}%"></span><span class="d-ai" style="width:${aiDelW.toFixed(1)}%"></span><span class="d-h" style="width:${humDelW.toFixed(1)}%"></span></div>`;

        h += `<div class="ov-divider"></div>`;
        h += `<div class="ov-sub">All commits (${data.commits.length})</div>`;
        h += `<div class="badges">`;
        h += `<span class="badge ai">+${data.totalAiLines.toLocaleString()} AI</span>`;
        h += `<span class="badge human">+${data.totalHumanLines.toLocaleString()} Human</span>`;
        h += `<span class="badge ai">&minus;${totAiDel.toLocaleString()} AI</span>`;
        h += `<span class="badge del">&minus;${totHumanDel.toLocaleString()} Human</span>`;
        h += `</div>`;
        h += `<div class="chips">`;
        h += `<span class="chip orange">Tools: ${toolsLabel}</span>`;
        h += `<span class="chip blue">${data.totalFiles} files</span>`;
        if (data.totalCodingTimeMs > 0) { h += `<span class="chip green">Coding ${this.formatDuration(data.totalCodingTimeMs)}</span>`; }
        if (data.totalWaitingMs > 0) { h += `<span class="chip purple">AI wait ${this.formatDuration(data.totalWaitingMs)}</span>`; }
        h += `</div>`;
        h += `</div>`; // card

        // ── AI Models (latest commit) — even split of the commit's AI lines ──
        const validModels = latest.models.filter(m => m && m !== 'unknown');
        if (validModels.length > 0 && latest.aiLinesAdded > 0) {
            const denom = latest.aiLinesAdded || 1;
            const base = Math.floor(latest.aiLinesAdded / validModels.length);
            const rem = latest.aiLinesAdded % validModels.length;
            h += `<div class="section-label">AI Models <span class="count-pill">latest</span></div>`;
            h += `<div class="models-grid">`;
            validModels.slice(0, 3).forEach((name, i) => {
                const lines = base + (i < rem ? 1 : 0);
                const pct = (100.0 * lines / denom).toFixed(1);
                const rank = i + 1;
                h += `<div class="model-card rank-${rank}">`;
                h += `<div class="model-header"><div class="rank-badge">#${rank}</div><span class="model-name">${this.esc(name)}</span>`;
                h += `<div class="model-meta"><span class="highlight">${lines} lines</span><span>${pct}%</span></div></div>`;
                h += `<div class="model-bar-track"><div class="model-bar-fill" style="width:${pct}%"></div></div>`;
                h += `</div>`;
            });
            h += `</div>`;
        }

        // ── Commits table (same columns as IntelliJ; scrolls horizontally) ──
        h += `<div class="section-label">Commits <span class="count-pill">${data.commits.length}</span></div>`;
        h += `<div class="table-wrap"><table class="ctable">`;
        h += `<thead><tr><th>HASH</th><th>AUTHOR</th><th>MESSAGE</th><th class="r">+ADD</th><th class="r">&minus;DEL</th><th>AI %</th><th class="r">CODING</th><th>BRANCH</th></tr></thead><tbody>`;
        for (const report of data.commits) {
            const sha = report.commitHash.slice(0, 7);
            const rawMsg = report.commitMessage.replace(/\n/g, ' ').trim();
            const msg = rawMsg ? this.esc(rawMsg) : '(no message)';
            const aiPctNum = parseFloat(report.aiPercentage.replace('%', '')) || 0;
            const aiDel = report.aiLinesDeleted;
            const humanDel = Math.max(0, report.totalLinesDeleted - aiDel);
            const author = report.author?.trim() ? this.esc(report.author) : '&mdash;';
            const branch = report.branch ? this.esc(report.branch) : '&mdash;';
            const models = report.models.filter(m => m && m !== 'unknown').join(', ');
            const delTitle = `Deleted: AI −${aiDel} · Human −${humanDel}${models ? ' · ' + this.esc(models) : ''}`;
            h += `<tr>`;
            h += `<td class="hash">${sha}</td>`;
            h += `<td class="author" title="${author}">${author}</td>`;
            h += `<td class="msg" title="${this.esc(rawMsg)}">${msg}</td>`;
            h += `<td class="r add">+${report.totalLinesAdded}</td>`;
            h += `<td class="r del" title="${delTitle}">&minus;${report.totalLinesDeleted}</td>`;
            h += `<td class="aipct"><span class="mini"><span class="mini-fill" style="width:${Math.min(aiPctNum, 100)}%"></span></span><span class="aip">${aiPctNum.toFixed(0)}%</span></td>`;
            h += `<td class="r time">${report.codingTimeMs > 0 ? this.formatDuration(report.codingTimeMs) : '&mdash;'}</td>`;
            h += `<td><span class="branch ${report.branch === 'main' || report.branch === 'master' ? 'b-main' : ''}">${branch}</span></td>`;
            h += `</tr>`;
        }
        h += `</tbody></table></div>`;

        // Footer
        h += `<div class="panel-footer">`;
        h += `<span class="footer-info">last synced: just now`;
        if (interactionList) {
            h += ` &middot; ${this.esc(interactionList)}`;
        }
        h += `</span>`;
        h += `<button type="button" class="refresh-btn" onclick="refreshHistory()">&#x21bb; Refresh</button>`;
        h += `</div>`;

        h += `</div>`; // panel
        h += `<script>const vscodeApi=acquireVsCodeApi();function refreshHistory(){vscodeApi.postMessage({command:'refresh'});}</script>`;
        h += `</body></html>`;
        return h;
    }
}

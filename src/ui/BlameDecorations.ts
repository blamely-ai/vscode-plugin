import * as vscode from 'vscode';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { CliDataService } from '../cli/CliDataService';
import { blameFileKey } from '../utils/WorkspacePaths';
import { isBlankLine } from '../utils/BlankLines';
import {
    blameGutterTooltipText,
    escapeMarkdown,
    quotePromptForTooltip,
    toolDisplayName,
    formatBlameChangedDate,
} from './BlameDecorationsTooltip';

export { blameGutterTooltipText, formatBlameChangedDate } from './BlameDecorationsTooltip';

const HUMAN_COLOR = 'var(--vscode-charts-green)';
const DIM = 'var(--vscode-descriptionForeground)';

// Per-tool brand colors, matching the HTML report. Chosen to read on both light
// and dark themes (Cursor's near-white brand is swapped for a legible blue).
const TOOL_COLORS: Record<string, string> = {
    claude: '#d97757',
    cursor: '#7aa2f7',
    codex: '#10a37f',
    copilot: '#a371f7',
    gemini: '#4f9cf0',
};
function toolBrandColor(provider?: string | null): string {
    return TOOL_COLORS[(provider ?? '').trim().toLowerCase()] ?? 'var(--vscode-charts-blue)';
}

/** Dimmed metadata footer: `$(history) <when>  ·  $(git-commit) <sha>`. */
function metaFooter(entry: LineBlame): string {
    const parts: string[] = [];
    // Omit the date entirely when unknown (empty timestamp) rather than showing
    // a "$(history) Unknown" footer.
    if (entry.timestamp?.trim()) {
        parts.push(`$(history) ${escapeMarkdown(formatBlameChangedDate(entry.timestamp))}`);
    }
    if (entry.commitSha) {
        parts.push(`$(git-commit) ${escapeMarkdown(entry.commitSha.slice(0, 8))}`);
    }
    if (parts.length === 0) return '';
    return `<span style="color:${DIM};">${parts.join(' &nbsp;·&nbsp; ')}</span>`;
}

/** Subtle product attribution shown at the bottom of every hover. */
function brandLine(): string {
    return `\n\n<span style="color:${DIM};">$(shield) Provided by **Blamely**</span>`;
}

/**
 * Gutter hover: a brand-colored title (tool, with the model as a secondary chip),
 * the prompt as a quote, and a single dimmed metadata footer. Built directly from
 * the entry (codicons + themed inline color), with a compact, professional layout.
 */
function blameGutterHoverMessage(entry: LineBlame): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = true;
    md.supportThemeIcons = true;

    if (entry.authorType === 'AI') {
        const color = toolBrandColor(entry.provider);
        const tool = entry.provider ? escapeMarkdown(toolDisplayName(entry.provider)) : 'AI';
        let header = `<span style="color:${color};">$(sparkle) **${tool}**</span>`;
        if (entry.model) {
            header += ` &nbsp;<span style="color:${DIM};">${escapeMarkdown(entry.model)}</span>`;
        }
        md.appendMarkdown(`${header}\n\n`);
        if (entry.prompt) {
            md.appendMarkdown(`${quotePromptForTooltip(entry.prompt)}\n\n`);
        }
        md.appendMarkdown(metaFooter(entry));
        md.appendMarkdown(brandLine());
        return md;
    }

    md.appendMarkdown(`<span style="color:${HUMAN_COLOR};">$(account) **Human**</span>\n\n`);
    md.appendMarkdown(metaFooter(entry));
    md.appendMarkdown(brandLine());
    return md;
}

/** Small brain SVG for AI gutter icon (matches IntelliJ GutterBrain). */
const GUTTER_AI_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1.5C5.5 1.5 4.8 2 4.5 2.5C3.8 2.2 3 2.5 2.7 3.2C2.2 3.5 1.8 4.2 2 5C1.5 5.5 1.5 6.3 2 7C1.8 7.7 2 8.5 2.7 9C3 9.5 3.5 9.8 4.2 9.8C4.5 10.5 5.2 11 6 11.2V7" stroke="#4d9de0" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 1.5C7.5 1.5 8.2 2 8.5 2.5C9.2 2.2 10 2.5 10.3 3.2C10.8 3.5 11.2 4.2 11 5C11.5 5.5 11.5 6.3 11 7C11.2 7.7 11 8.5 10.3 9C10 9.5 9.5 9.8 8.8 9.8C8.5 10.5 7.8 11 7 11.2V7" stroke="#4d9de0" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 5C5 5.5 5.5 6 6.5 6.5" stroke="#4d9de0" stroke-width="0.7" stroke-linecap="round"/><path d="M8.5 5C8 5.5 7.5 6 6.5 6.5" stroke="#4d9de0" stroke-width="0.7" stroke-linecap="round"/></svg>';
/** Human (person) SVG for gutter icon (matches IntelliJ GutterHuman). */
const GUTTER_HUMAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4" r="2.5" stroke="#56a064" stroke-width="1.2" fill="none"/><path d="M3 13c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="#56a064" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
/** Neutral "detecting" SVG: a three-quarter amber ring (a static spinner) shown
 *  while an AI-likely insert awaits attribution, before it resolves to AI or Human. */
const GUTTER_PENDING_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 7a4 4 0 1 1-1.2-2.85" stroke="#e0a23d" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>';

function dataUriForSvg(svg: string): vscode.Uri {
    const encoded = encodeURIComponent(svg).replace(/'/g, '%27');
    return vscode.Uri.parse(`data:image/svg+xml,${encoded}`);
}

/** Hover for the neutral "detecting" gutter icon. */
const DETECTING_HOVER = (() => {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;
    md.supportThemeIcons = true;
    md.appendMarkdown('<span style="color:var(--vscode-charts-yellow);">$(sync) **Detecting authorship…**</span>\n\n');
    md.appendMarkdown('<span style="color:var(--vscode-descriptionForeground);">Resolving AI vs human</span>');
    return md;
})();

/**
 * Editor line decorations: gutter icon, ruler, optional background, and hover tooltips for AI & Human.
 * Shows one icon per line for blame rows in memory (IDE session + loaded .blame.json). Rows with
 * commitSha set still decorate — CLI snapshots record HEAD at trace end, so filtering only
 * uncommitted lines would hide them. DELETE rows are skipped (no stable line in the open doc).
 * Tooltip content matches IntelliJ BlameLineMarkerProvider.
 */
export class BlameDecorations implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private blameMap: BlameMap;

    private aiDecorationType: vscode.TextEditorDecorationType;
    private humanDecorationType: vscode.TextEditorDecorationType;
    private pendingDecorationType: vscode.TextEditorDecorationType;

    constructor(blameMap: BlameMap, cliData?: CliDataService) {
        this.blameMap = blameMap;

        this.aiDecorationType = vscode.window.createTextEditorDecorationType({
            overviewRulerColor: '#4a9eff',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            isWholeLine: true,
            gutterIconPath: dataUriForSvg(GUTTER_AI_SVG),
            gutterIconSize: 'auto',
        });

        this.humanDecorationType = vscode.window.createTextEditorDecorationType({
            overviewRulerColor: '#4ade80',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            isWholeLine: true,
            gutterIconPath: dataUriForSvg(GUTTER_HUMAN_SVG),
            gutterIconSize: 'auto',
        });

        this.pendingDecorationType = vscode.window.createTextEditorDecorationType({
            overviewRulerColor: '#e0a23d',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            isWholeLine: true,
            gutterIconPath: dataUriForSvg(GUTTER_PENDING_SVG),
            gutterIconSize: 'auto',
        });

        const editorChange = vscode.window.onDidChangeActiveTextEditor(() => this.updateDecorations());
        this.disposables.push(editorChange);

        const visibleChange = vscode.window.onDidChangeVisibleTextEditors(() => this.updateDecorations());
        this.disposables.push(visibleChange);

        const docChange = vscode.workspace.onDidChangeTextDocument(() => {
            this.updateDecorations();
        });
        this.disposables.push(docChange);

        const cfgChange = vscode.workspace.onDidChangeConfiguration(ev => {
            if (ev.affectsConfiguration('blamely')) {
                this.updateDecorations();
            }
        });
        this.disposables.push(cfgChange);

        if (cliData) {
            // Refresh events (pushImmediateBlame OR a completed data refresh) paint
            // immediately — no debounce. The data is already correct by the time
            // notify() fires, and delaying makes the Human→AI flash visible.
            this.disposables.push(cliData.onRefresh(() => this.applyDecorations()));
        }

        this.updateDecorations();
    }

    private debounceTimer: NodeJS.Timeout | null = null;

    // Debounced update — only used for raw VS Code document-change events where
    // we need to coalesce a burst of edits before re-reading the blame map.
    // pushImmediateBlame / refresh completions call applyDecorations() directly.
    updateDecorations(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.applyDecorations();
        }, 100);
    }

    private applyDecorations(): void {
        const config = vscode.workspace.getConfiguration('blamely');
        const show = config.get('showGutterDecorations', true);
        const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'file');

        if (!show) {
            for (const editor of editors) {
                this.clearEditorDecorations(editor);
            }
            return;
        }

        for (const editor of editors) {
            this.applyDecorationsForFileEditor(editor);
        }
    }

    private clearEditorDecorations(editor: vscode.TextEditor): void {
        try {
            editor.setDecorations(this.aiDecorationType, []);
            editor.setDecorations(this.humanDecorationType, []);
            editor.setDecorations(this.pendingDecorationType, []);
        } catch {
            /* ignore UI errors */
        }
    }

    private applyDecorationsForFileEditor(editor: vscode.TextEditor): void {
        const relativePath = blameFileKey(editor.document.uri);

        const rawEntries = this.blameMap.getBlame(relativePath).filter(e => e.changeType !== 'DELETE');
        const byLine = new Map<number, LineBlame>();
        for (const e of rawEntries) {
            const existing = byLine.get(e.lineNumber);
            if (!existing || e.aiChars + e.humanChars > existing.aiChars + existing.humanChars) {
                byLine.set(e.lineNumber, e);
            }
        }

        // Lines awaiting an AI-vs-Human decision (set on an agent apply). They
        // render as the neutral "detecting" icon UNLESS already resolved to AI.
        // Detecting overrides a default Human paint so the gutter never shows
        // Human-then-AI; it resolves to AI when the edit is recorded, or to Human
        // when the window expires (pruned in detectingLinesFor).
        const detecting = this.blameMap.detectingLinesFor(relativePath);

        // Candidate lines: every line with a blame entry, plus detecting lines
        // that have no entry yet (a fresh insert before the first data refresh).
        const candidateLines = new Set<number>([...byLine.keys(), ...detecting]);

        const aiRanges: vscode.DecorationOptions[] = [];
        const humanRanges: vscode.DecorationOptions[] = [];
        const pendingRanges: vscode.DecorationOptions[] = [];

        for (const lineNumber of [...candidateLines].sort((a, b) => a - b)) {
            const lineIndex = lineNumber - 1;
            if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;

            let lineText = '';
            try {
                lineText = editor.document.lineAt(lineIndex).text;
            } catch {
                continue;
            }
            if (isBlankLine(lineText)) continue;
            const lineLength = lineText.length;
            const range = lineLength === 0
                ? new vscode.Range(lineIndex, 0, lineIndex, 0)
                : new vscode.Range(lineIndex, 0, lineIndex, lineLength);

            const entry = byLine.get(lineNumber);
            if (entry?.authorType === 'AI') {
                // Resolved to AI — clear any detecting state and show the AI icon.
                this.blameMap.clearDetectingLine(relativePath, lineNumber);
                aiRanges.push({ range, hoverMessage: blameGutterHoverMessage(entry) });
            } else if (detecting.has(lineNumber)) {
                pendingRanges.push({ range, hoverMessage: DETECTING_HOVER });
            } else if (entry) {
                humanRanges.push({ range, hoverMessage: blameGutterHoverMessage(entry) });
            }
        }

        try {
            editor.setDecorations(this.aiDecorationType, aiRanges);
            editor.setDecorations(this.humanDecorationType, humanRanges);
            editor.setDecorations(this.pendingDecorationType, pendingRanges);
        } catch {
            /* ignore UI rendering errors */
        }
    }

    dispose(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.aiDecorationType.dispose();
        this.humanDecorationType.dispose();
        this.pendingDecorationType.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

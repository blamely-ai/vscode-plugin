import * as vscode from 'vscode';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { blameFileKey } from '../utils/WorkspacePaths';

/** Small brain SVG for AI gutter icon (matches IntelliJ GutterBrain). */
const GUTTER_AI_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 13 13" fill="none"><path d="M6.5 1.5C5.5 1.5 4.8 2 4.5 2.5C3.8 2.2 3 2.5 2.7 3.2C2.2 3.5 1.8 4.2 2 5C1.5 5.5 1.5 6.3 2 7C1.8 7.7 2 8.5 2.7 9C3 9.5 3.5 9.8 4.2 9.8C4.5 10.5 5.2 11 6 11.2V7" stroke="#4d9de0" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 1.5C7.5 1.5 8.2 2 8.5 2.5C9.2 2.2 10 2.5 10.3 3.2C10.8 3.5 11.2 4.2 11 5C11.5 5.5 11.5 6.3 11 7C11.2 7.7 11 8.5 10.3 9C10 9.5 9.5 9.8 8.8 9.8C8.5 10.5 7.8 11 7 11.2V7" stroke="#4d9de0" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 5C5 5.5 5.5 6 6.5 6.5" stroke="#4d9de0" stroke-width="0.7" stroke-linecap="round"/><path d="M8.5 5C8 5.5 7.5 6 6.5 6.5" stroke="#4d9de0" stroke-width="0.7" stroke-linecap="round"/></svg>';
/** Human (person) SVG for gutter icon (matches IntelliJ GutterHuman). */
const GUTTER_HUMAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4" r="2.5" stroke="#56a064" stroke-width="1.2" fill="none"/><path d="M3 13c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="#56a064" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';

function dataUriForSvg(svg: string): vscode.Uri {
    const encoded = encodeURIComponent(svg).replace(/'/g, '%27');
    return vscode.Uri.parse(`data:image/svg+xml,${encoded}`);
}

/**
 * Editor line decorations: gutter icon, ruler, optional background, and hover tooltips for AI & Human.
 * Shows on every changed and new line with uncommitted blame (commit_sha == null).
 * Tooltip content matches IntelliJ BlameLineMarkerProvider.
 */
export class BlameDecorations implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private blameMap: BlameMap;

    private aiDecorationType: vscode.TextEditorDecorationType;
    private humanDecorationType: vscode.TextEditorDecorationType;

    constructor(blameMap: BlameMap) {
        this.blameMap = blameMap;

        this.aiDecorationType = vscode.window.createTextEditorDecorationType({
            overviewRulerColor: '#4a9eff',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            isWholeLine: true,
            gutterIconPath: dataUriForSvg(GUTTER_AI_SVG),
            gutterIconSize: 'contain',
        });

        this.humanDecorationType = vscode.window.createTextEditorDecorationType({
            overviewRulerColor: '#4ade80',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            isWholeLine: true,
            gutterIconPath: dataUriForSvg(GUTTER_HUMAN_SVG),
            gutterIconSize: 'contain',
        });

        const editorChange = vscode.window.onDidChangeActiveTextEditor(
            () => this.updateDecorations()
        );
        this.disposables.push(editorChange);

        const docChange = vscode.workspace.onDidChangeTextDocument(() => {
            this.updateDecorations();
        });
        this.disposables.push(docChange);

        this.updateDecorations();
    }

    private debounceTimer: NodeJS.Timeout | null = null;

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
        if (!config.get('showGutterDecorations', true)) {
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }

        const relativePath = blameFileKey(editor.document.uri);

        const rawEntries = this.blameMap.getBlame(relativePath).filter(e => e.commitSha == null);
        // Same line can appear more than once in storage edge cases — one decoration + tooltip per line.
        const byLine = new Map<number, LineBlame>();
        for (const e of rawEntries) {
            const existing = byLine.get(e.lineNumber);
            if (!existing || e.aiChars + e.humanChars > existing.aiChars + existing.humanChars) {
                byLine.set(e.lineNumber, e);
            }
        }
        const entries = [...byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber);

        const aiRanges: vscode.DecorationOptions[] = [];
        const humanRanges: vscode.DecorationOptions[] = [];

        for (const entry of entries) {
            const lineIndex = entry.lineNumber - 1; // 0-indexed
            if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;

            let lineLength = 0;
            try {
                lineLength = editor.document.lineAt(lineIndex).text.length;
            } catch {
                continue;
            }
            // Empty line: use a zero-width range on that line only so we do not overlap the next line
            // (overlap caused duplicate 👤 Human Written hovers when gutter ranges stacked).
            const range = lineLength === 0
                ? new vscode.Range(lineIndex, 0, lineIndex, 0)
                : new vscode.Range(lineIndex, 0, lineIndex, lineLength);
            const hoverMessage = new vscode.MarkdownString();
            hoverMessage.isTrusted = false;

            if (entry.authorType === 'AI') {
                hoverMessage.appendMarkdown(`- **Author:** AI\n`);
                if (entry.model) {
                    hoverMessage.appendMarkdown(`- **Model:** \`${this.escapeMd(entry.model)}\`\n`);
                }
                if (entry.interactionType) {
                    hoverMessage.appendMarkdown(`- **Source:** \`${this.escapeMd(entry.interactionType)}\`\n`);
                }
                if (entry.prompt) {
                    hoverMessage.appendMarkdown(`- **Prompt:** ${this.quotePrompt(entry.prompt)}\n`);
                }
                hoverMessage.appendMarkdown(`- **Updated:** ${this.formatTimestamp(entry.timestamp)}\n`);
                if (entry.commitSha) {
                    hoverMessage.appendMarkdown(`- **Commit:** \`${entry.commitSha.slice(0, 8)}\`\n`);
                }
                aiRanges.push({ range, hoverMessage });
            } else {
                hoverMessage.appendMarkdown(`- **Author:** Human\n`);
                hoverMessage.appendMarkdown(`- **Updated:** ${this.formatTimestamp(entry.timestamp)}\n`);
                if (entry.commitSha) {
                    hoverMessage.appendMarkdown(`- **Commit:** \`${entry.commitSha.slice(0, 8)}\`\n`);
                }
                humanRanges.push({ range, hoverMessage });
            }
        }

        try {
            editor.setDecorations(this.aiDecorationType, aiRanges);
            editor.setDecorations(this.humanDecorationType, humanRanges);
        } catch (err) {
            // Ignore UI rendering errors (e.g., "Make sure the ref is set...")
        }
    }

    private formatTimestamp(raw: string): string {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return this.escapeMd(raw);
        return this.escapeMd(d.toLocaleString());
    }

    private quotePrompt(prompt: string): string {
        const clean = this.escapeMd(prompt).trim();
        const short = clean.length > 220 ? `${clean.slice(0, 220)}...` : clean;
        return `> ${short}`;
    }

    private escapeMd(value: string): string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\*/g, '\\*')
            .replace(/_/g, '\\_')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    dispose(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.aiDecorationType.dispose();
        this.humanDecorationType.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

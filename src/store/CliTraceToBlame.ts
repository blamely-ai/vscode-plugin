import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type CliTraceSession } from './CliTraceLoader';
import { BlameMap, type LineBlame } from '../blame/BlameMap';
import * as BlameSerializer from '../blame/BlameSerializer';
import * as GitUtils from '../git/GitUtils';
import * as Logger from '../utils/Logger';
import { normalizePath } from '../utils/Platform';
interface ReportFileEntry {
    path: string;
    aiLinesAdded: number;
    humanLinesAdded: number;
}

function parseReportYaml(content: string): ReportFileEntry[] {
    const entries: ReportFileEntry[] = [];
    let current: { path: string; aiLinesAdded: number; humanLinesAdded: number } | null = null;
    let inChanges = false;
    let pendingChange: { authorType: string | null; changeType: string | null } | null = null;

    function flushPending(): void {
        if (!pendingChange) {
            return;
        }
        const ct = (pendingChange.changeType ?? 'ADD').toUpperCase();
        const at = pendingChange.authorType?.toUpperCase() ?? '';
        if (ct === 'ADD' && current) {
            if (at === 'AI') {
                current.aiLinesAdded++;
            } else if (at === 'HUMAN') {
                current.humanLinesAdded++;
            }
        }
        pendingChange = null;
    }

    for (const line of content.split('\n')) {
        const pathMatch = /^\s+-\s+path:\s+"?([^"\n]+)"?\s*$/.exec(line);
        if (pathMatch) {
            flushPending();
            if (current) {
                entries.push(current);
            }
            current = { path: pathMatch[1].trim(), aiLinesAdded: 0, humanLinesAdded: 0 };
            inChanges = false;
            pendingChange = null;
            continue;
        }
        if (!current) {
            continue;
        }

        if (/^\s+changes:\s*\[\s*\]\s*$/.test(line)) {
            flushPending();
            inChanges = false;
            continue;
        }
        if (/^\s+changes:\s*$/.test(line)) {
            flushPending();
            inChanges = true;
            continue;
        }
        if (inChanges && /^\s+\[\s*\]\s*$/.test(line)) {
            flushPending();
            inChanges = false;
            continue;
        }

        if (inChanges) {
            if (/^\s+-\s+lineNumber:\s*\d+/.test(line)) {
                flushPending();
                pendingChange = { authorType: null, changeType: null };
                continue;
            }
            if (pendingChange) {
                const auth = /^\s+authorType:\s*"?([A-Za-z]+)"?\s*$/.exec(line);
                if (auth) {
                    pendingChange.authorType = auth[1];
                    continue;
                }
                const chg = /^\s+changeType:\s*"?([A-Za-z]+)"?\s*$/.exec(line);
                if (chg) {
                    pendingChange.changeType = chg[1];
                    continue;
                }
            }
            continue;
        }

        const aiAddMatch = /^\s+ai_lines_added:\s+(\d+)/.exec(line);
        if (aiAddMatch) {
            current.aiLinesAdded = parseInt(aiAddMatch[1], 10);
        }
        const humAddMatch = /^\s+human_lines_added:\s+(\d+)/.exec(line);
        if (humAddMatch) {
            current.humanLinesAdded = parseInt(humAddMatch[1], 10);
        }
    }
    flushPending();
    if (current) {
        entries.push(current);
    }
    return entries;
}

async function loadReportEntries(_repoRoot: string, _session: CliTraceSession): Promise<Map<string, ReportFileEntry>> {
    /* trace/report.yml under branches/.../trace/ is not used */
    return new Map();
}

/** Match Go bufio.ScanLines: \n-terminated lines, strip optional \r before \n; no extra row for trailing \n only. */
function lineCharCountsFromText(text: string): number[] {
    const counts: number[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\n') {
            continue;
        }
        let end = i;
        if (end > start && text[end - 1] === '\r') {
            end--;
        }
        const line = text.slice(start, end);
        const n = [...line].length;
        counts.push(n < 1 ? 1 : n);
        start = i + 1;
    }
    if (start < text.length) {
        let end = text.length;
        if (end > start && text[end - 1] === '\r') {
            end--;
        }
        const line = text.slice(start, end);
        const n = [...line].length;
        counts.push(n < 1 ? 1 : n);
    } else if (counts.length === 0) {
        counts.push(1);
    }
    return counts;
}

function blameKeyFromRepoRelPath(repoRelPath: string, repoRoot: string): string {
    const absPath = path.isAbsolute(repoRelPath)
        ? repoRelPath
        : path.join(repoRoot, repoRelPath);
    const uri = vscode.Uri.file(absPath);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        // Fallback: repo-relative path as-is (works for single-root where workspace == repo root)
        return normalizePath(repoRelPath);
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const relWithinFolder = normalizePath(path.relative(folder.uri.fsPath, absPath));
    if (folders.length <= 1) {
        return relWithinFolder;
    }
    return normalizePath(`${folder.name}/${relWithinFolder}`);
}

function buildLineBlameEntries(
    session: CliTraceSession,
    classification: 'ai' | 'mixed',
    charCounts: number[],
    report: ReportFileEntry | undefined
): LineBlame[] {
    const timestamp = session.ended_at;
    const commitSha = session.git?.head_after_trace ?? session.git?.head_at_start ?? null;
    const model = session.report_model ?? null;
    const lineCount = charCounts.length;

    let aiLineCount: number;
    if (classification === 'ai') {
        aiLineCount = lineCount;
    } else {
        const aiRatio = report && (report.aiLinesAdded + report.humanLinesAdded) > 0
            ? report.aiLinesAdded / (report.aiLinesAdded + report.humanLinesAdded)
            : 0.5;
        aiLineCount = Math.round(aiRatio * lineCount);
    }

    const entries: LineBlame[] = [];
    for (let i = 0; i < lineCount; i++) {
        const lineNum = i + 1;
        const ch = charCounts[i];
        const isAi = lineNum <= aiLineCount;
        entries.push({
            lineNumber: lineNum,
            newLineNumber: lineNum,
            oldLineNumber: null,
            authorType: isAi ? 'AI' : 'HUMAN',
            provider: null,
            timestamp,
            commitSha,
            model: isAi ? model : null,
            prompt: null,
            interactionType: isAi ? session.scope : null,
            ide: 'ai_cli',
            aiChars: isAi ? ch : 0,
            humanChars: isAi ? 0 : ch,
            changeType: 'ADD',
            codingType: 'BULK_INSERT',
        });
    }
    return entries;
}

/**
 * Translates CLI trace sessions into LineBlame[] entries and writes them to:
 *   - ~/.blamely/repos/<repoKey>/snapshots/<branch>/  (shared primary — via BlameSerializer.save)
 *
 * Sessions from other branches are skipped. Files that the BlameMap already has
 * entries for are skipped (IDE real-time tracking is more accurate).
 *
 * Note: the CLI's blamejson package now writes these files directly at trace time,
 * so this function mainly handles real-time updates when VS Code is already open.
 */
export async function populateBlameFromCliSessions(
    sessions: CliTraceSession[],
    blameMap: BlameMap,
    workspaceRoot: string
): Promise<void> {
    if (sessions.length === 0) { return; }

    const repoRoot = await GitUtils.getRepoRoot(workspaceRoot);
    if (!repoRoot) { return; }

    const currentBranch = await GitUtils.getBranch(workspaceRoot);
    let filesAttributed = 0;
    for (const session of sessions) {
        // Skip sessions from other branches (allow when either branch is unknown).
        if (session.git?.branch && currentBranch && session.git.branch !== currentBranch) {
            continue;
        }
        if (!session.files?.length) { continue; }

        const reportMap = await loadReportEntries(repoRoot, session);

        for (const fileEntry of session.files) {
            const repoRelPath = normalizePath(fileEntry.path);
            const blameKey = blameKeyFromRepoRelPath(repoRelPath, repoRoot);

            // IDE real-time tracking is more accurate — don't overwrite.
            if (blameMap.getBlame(blameKey).length > 0) { continue; }

            const absPath = path.isAbsolute(repoRelPath)
                ? repoRelPath
                : path.join(repoRoot, repoRelPath);

            let charCounts: number[];
            try {
                const content = await fs.promises.readFile(absPath, 'utf-8');
                charCounts = lineCharCountsFromText(content);
                if (charCounts.length === 0) { continue; }
            } catch {
                continue; // file doesn't exist on disk
            }

            const reportEntry = reportMap.get(repoRelPath.toLowerCase());
            const entries = buildLineBlameEntries(
                session,
                fileEntry.classification,
                charCounts,
                reportEntry
            );

            blameMap.setFileBlame(blameKey, entries);

            // Write to VS Code's primary snapshot location via BlameSerializer.
            const wsRoot = (() => {
                const folders = vscode.workspace.workspaceFolders ?? [];
                if (folders.length <= 1) { return workspaceRoot; }
                const absUri = vscode.Uri.file(absPath);
                const folder = vscode.workspace.getWorkspaceFolder(absUri);
                return folder?.uri.fsPath ?? workspaceRoot;
            })();
            await BlameSerializer.save(wsRoot, blameKey, entries);

            filesAttributed++;
        }
    }

    if (filesAttributed > 0) {
        Logger.info(`CLI traces: attributed ${filesAttributed} file(s) into shared blame snapshots`);
    }
}

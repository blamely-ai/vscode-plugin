import { BlameMap, LineBlame } from '../blame/BlameMap';
import { TraceStore } from '../store/TraceStore';
import { type CliTraceSession } from '../store/CliTraceLoader';
import * as GitUtils from '../git/GitUtils';
import * as Logger from '../utils/Logger';
import {
    buildFileEntries,
    totalsFromFileEntries,
    type HookTotals,
    type FileEntry,
} from './hookTotals';

export type { HookTotals } from './hookTotals';
export { totalsFromFileEntries, detectorHookPreamble, computeHookTotalsFromBlameSnapshot } from './hookTotals';

export interface ReportMetrics {
    firstStartCodingTimeMs: number;
    timeWaitingForAiMs: number;
}

const DETECTOR_VERSION = '0.1.2';

/**
 * Legacy two-line header (regex on # AI / # Human). Kept for tests; hookRunner aggregates `.blame.json` instead.
 */
export function legacyPreCommitDetectorPreamble(aiLines: number, humanLines: number): string {
    const added = aiLines + humanLines;
    const aiPct = added > 0 ? ((100 * aiLines) / added).toFixed(1) : '0.0';
    const humanPct = added > 0 ? ((100 * humanLines) / added).toFixed(1) : '0.0';
    return (
        `# AI-authored lines: ${aiLines} (${aiPct}%)\n` +
        `# Human-authored lines: ${humanLines} (${humanPct}%)\n\n`
    );
}

/**
 * DELETE rows are not stored in the live blame map (reindex drops them). Merge staged `git diff --cached`
 * deletions so hook totals / YAML match what will be committed; AI vs human uses {@link BlameMap.wasLineDeletedByAi}.
 */
async function mergeStagedDeletionsIntoSnapshot(
    blameSnapshot: Record<string, LineBlame[]>,
    blameMap: BlameMap,
    workspaceRoot: string,
    fileKeyPrefix: string | null | undefined,
    timestampIso: string
): Promise<void> {
    const repoRoot = await GitUtils.getRepoRoot(workspaceRoot);
    if (!repoRoot) return;

    const stagedFiles = await GitUtils.listStagedRepoRelativePaths(repoRoot);
    for (const repoRel of stagedFiles) {
        const stats = await GitUtils.getStagedDiffStats(repoRoot, repoRel);
        if (stats.deletedCount === 0) continue;

        const projRelMap = GitUtils.repoRelativeToProjectRelative(repoRoot, workspaceRoot, [repoRel]);
        const mapPath = (projRelMap.get(repoRel) ?? repoRel).replace(/^\/+/, '');
        const blameKey = fileKeyPrefix ? `${fileKeyPrefix}${mapPath}` : mapPath;

        if (fileKeyPrefix && !blameKey.startsWith(fileKeyPrefix)) continue;

        const deleteRows: LineBlame[] = [];
        for (const oldLine of [...stats.deletedLines].sort((a, b) => a - b)) {
            const deletedByAi = blameMap.wasLineDeletedByAi(blameKey, oldLine);
            deleteRows.push({
                lineNumber: oldLine,
                authorType: deletedByAi ? 'AI' : 'HUMAN',
                provider: null,
                timestamp: timestampIso,
                commitSha: null,
                model: deletedByAi ? 'unknown' : null,
                prompt: null,
                interactionType: null,
                ide: null,
                aiChars: deletedByAi ? 1 : 0,
                humanChars: deletedByAi ? 0 : 1,
                changeType: 'DELETE',
                newLineNumber: null,
                oldLineNumber: oldLine,
                codingType: 'TYPING',
            });
        }

        const prev =
            blameSnapshot[blameKey] ??
            blameMap.getBlame(blameKey).filter(e => e.commitSha == null);
        const seenOld = new Set(
            prev
                .filter(e => e.changeType === 'DELETE' && e.oldLineNumber != null)
                .map(e => e.oldLineNumber as number)
        );
        const merged = [...prev];
        for (const row of deleteRows) {
            if (row.oldLineNumber != null && !seenOld.has(row.oldLineNumber)) {
                merged.push(row);
                seenOld.add(row.oldLineNumber);
            }
        }
        blameSnapshot[blameKey] = merged;
    }
}

function escapeYamlString(s: string): string {
    return JSON.stringify(s);
}

function yamlStr(value: string | null): string {
    if (value === null || value === undefined) return 'null';
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `"${escaped}"`;
}

function buildCliTracesYaml(sessions: CliTraceSession[]): string {
    if (sessions.length === 0) { return ''; }
    const lines: string[] = ['', 'cli_traces:'];
    for (const s of sessions) {
        lines.push(`  - trace_id: ${escapeYamlString(s.trace_id)}`);
        lines.push(`    started_at: ${escapeYamlString(s.started_at)}`);
        lines.push(`    ended_at: ${escapeYamlString(s.ended_at)}`);
        lines.push(`    branch: ${escapeYamlString(s.git?.branch ?? 'unknown')}`);
        lines.push('    traced_command:');
        for (const arg of (s.traced_command?.argv ?? [])) {
            lines.push(`      - ${escapeYamlString(arg)}`);
        }
        if (s.report_model) {
            lines.push(`    report_model: ${escapeYamlString(s.report_model)}`);
        }
        lines.push('    files:');
        if (!s.files || s.files.length === 0) {
            lines.push('      []');
        } else {
            for (const f of s.files) {
                lines.push(`      - path: ${escapeYamlString(f.path)}`);
                lines.push(`        classification: ${escapeYamlString(f.classification)}`);
                lines.push(`        confidence: ${escapeYamlString(f.confidence)}`);
            }
        }
    }
    return lines.join('\n');
}

function emitChangeRows(fileEntries: LineBlame[]): string[] {
    const lines: string[] = [];
    const sorted = [...fileEntries].sort((a, b) => {
        const la = a.changeType === 'DELETE' ? (a.oldLineNumber ?? a.lineNumber) : (a.newLineNumber ?? a.lineNumber);
        const lb = b.changeType === 'DELETE' ? (b.oldLineNumber ?? b.lineNumber) : (b.newLineNumber ?? b.lineNumber);
        return la - lb;
    });
    for (const e of sorted) {
        const ln = e.changeType === 'DELETE' ? (e.oldLineNumber ?? e.lineNumber) : (e.newLineNumber ?? e.lineNumber);
        lines.push(`      - lineNumber: ${ln}`);
        lines.push(`        authorType: "${e.authorType}"`);
        lines.push(`        model: ${e.model != null && e.model !== '' ? escapeYamlString(e.model) : 'null'}`);
        lines.push(
            `        date: ${e.timestamp != null && e.timestamp.trim() !== '' ? escapeYamlString(e.timestamp) : 'null'}`
        );
        lines.push(
            `        interactionType: ${e.interactionType != null && e.interactionType !== '' ? escapeYamlString(e.interactionType) : 'null'}`
        );
        lines.push(`        changeType: "${e.changeType}"`);
        lines.push(`        codingType: "${e.codingType ?? 'TYPING'}"`);
    }
    return lines;
}

function collectIdesFromBlame(
    blameByFile: Record<string, LineBlame[]> | null | undefined,
    fallbackIde: string
): string[] {
    const s = new Set<string>();
    if (blameByFile) {
        for (const rows of Object.values(blameByFile)) {
            for (const e of rows) {
                const t = e.ide?.trim();
                if (t) {
                    s.add(t);
                }
            }
        }
    }
    const fb = fallbackIde.trim();
    if (fb && !s.has(fb)) {
        s.add(fb);
    }
    return [...s].sort();
}

function buildReportYaml(
    generatedAt: string,
    branch: string,
    finalCommitHash: string,
    commitMessage: string,
    fileEntries: FileEntry[],
    ideName: string,
    interactionTypesSet: Set<string>,
    metrics?: ReportMetrics | null,
    cliTraceSessions?: CliTraceSession[],
    blameByFile?: Record<string, LineBlame[]> | null
): string {
    const lines: string[] = [];
    lines.push(`scope: "this_commit"`);
    lines.push(`commitDate: "${generatedAt}"`);
    lines.push(`detector_version: "${DETECTOR_VERSION}"`);
    lines.push(`branch: "${branch}"`);
    lines.push(`commit_hash: "${finalCommitHash}"`);
    lines.push(`commit_message: ${escapeYamlString(commitMessage)}`);
    lines.push('');

    const totalAiAdded = fileEntries.reduce((s, e) => s + e.aiLinesAdded, 0);
    const totalHumanAdded = fileEntries.reduce((s, e) => s + e.humanLinesAdded, 0);
    const totalAiDeleted = fileEntries.reduce((s, e) => s + e.aiLinesDeleted, 0);
    const totalHumanDeleted = fileEntries.reduce((s, e) => s + e.humanLinesDeleted, 0);
    const totalDeleted = fileEntries.reduce((s, e) => s + e.linesDeleted, 0);
    const totalChanges = totalAiAdded + totalHumanAdded + totalDeleted;
    const aiMass = totalAiAdded + totalAiDeleted;
    const overallPct = totalChanges > 0 ? ((100 * aiMass) / totalChanges).toFixed(1) + '%' : '0.0%';

    const allModels = new Set<string>();
    for (const e of fileEntries) {
        if (e.model && e.model !== 'unknown') allModels.add(e.model);
    }
    const modelCount = allModels.size;

    lines.push('summary:');
    lines.push(`  total_files_changed: ${fileEntries.length}`);
    lines.push(`  total_lines_added: ${totalAiAdded + totalHumanAdded}`);
    lines.push(`  total_lines_deleted: ${totalDeleted}`);
    lines.push(`  total_changes: ${totalChanges}`);
    lines.push(`  ai_lines_added: ${totalAiAdded}`);
    lines.push(`  ai_lines_deleted: ${totalAiDeleted}`);
    lines.push(`  human_lines_added: ${totalHumanAdded}`);
    lines.push(`  human_lines_deleted: ${totalHumanDeleted}`);
    lines.push(`  ai_percentage: "${overallPct}"`);
    lines.push(`  model_count: ${modelCount}`);
    lines.push('');

    const m = metrics ?? { firstStartCodingTimeMs: 0, timeWaitingForAiMs: 0 };
    lines.push('metrics:');
    const firstStart = m.firstStartCodingTimeMs > 0
        ? new Date(m.firstStartCodingTimeMs).toISOString()
        : null;
    lines.push(`  first_start_coding_time: ${firstStart != null ? `"${firstStart}"` : 'null'}`);
    lines.push(`  time_waiting_for_ai_ms: ${m.timeWaitingForAiMs}`);
    lines.push('');

    lines.push('agent_info:');
    const ideList = collectIdesFromBlame(blameByFile, ideName);
    lines.push('  ide:');
    if (ideList.length === 0) {
        lines.push('    []');
    } else {
        for (const id of ideList) {
            lines.push(`    - ${escapeYamlString(id)}`);
        }
    }
    lines.push('  models:');
    if (allModels.size === 0) {
        lines.push('    []');
    } else {
        for (const model of allModels) {
            lines.push(`    - "${model}"`);
        }
    }
    lines.push('  interaction_types:');
    if (interactionTypesSet.size === 0) {
        lines.push('    []');
    } else {
        for (const t of interactionTypesSet) {
            lines.push(`    - ${t}`);
        }
    }

    lines.push('');
    lines.push('files:');
    if (fileEntries.length === 0) {
        lines.push('  []');
    } else {
        for (const entry of fileEntries) {
            lines.push(`  - path: ${escapeYamlString(entry.path)}`);
            lines.push('    changes:');
            const blameRows =
                blameByFile && Object.prototype.hasOwnProperty.call(blameByFile, entry.path)
                    ? blameByFile[entry.path]!
                    : [];
            if (blameRows.length === 0) {
                lines.push('      []');
            } else {
                lines.push(...emitChangeRows(blameRows));
            }
        }
    }

    if (cliTraceSessions && cliTraceSessions.length > 0) {
        lines.push(buildCliTracesYaml(cliTraceSessions));
    }

    return lines.join('\n') + '\n';
}

/** Serialize blame snapshot in YAML format matching IntelliJ blameSnapshotToYaml. */
export function blameSnapshotToYamlForReport(entireBlame: Record<string, LineBlame[]>): string {
    const lines: string[] = [];
    for (const [filePath, entries] of Object.entries(entireBlame)) {
        const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`  "${escapedPath}":`);
        if (entries.length === 0) {
            lines.push('    []');
            continue;
        }
        for (const e of entries) {
            lines.push(`    - lineNumber: ${e.newLineNumber ?? e.lineNumber}`);
            lines.push(`      authorType: "${e.authorType}"`);
            lines.push(`      model: ${yamlStr(e.model)}`);
            lines.push(`      date: ${e.timestamp?.trim() ? yamlStr(e.timestamp) : 'null'}`);
            if (e.prompt) lines.push(`      prompt: ${yamlStr(e.prompt)}`);
            if (e.interactionType) lines.push(`      interactionType: ${yamlStr(e.interactionType)}`);
            lines.push(`      changeType: "${e.changeType}"`);
            lines.push(`      codingType: "${e.codingType ?? 'TYPING'}"`);
        }
    }
    return lines.join('\n');
}

/** Build report from a pre-built blame snapshot (used by CommitListener after building snapshot from diff). */
export async function generateFromBlameSnapshot(
    workspaceRoot: string,
    entireBlame: Record<string, LineBlame[]>,
    _traceStore: TraceStore,
    commitHash?: string | null,
    ideName: string = 'unknown',
    metrics?: ReportMetrics | null
): Promise<string> {
    try {
        const generatedAt = new Date().toISOString();
        const branch = (await GitUtils.getBranch(workspaceRoot)) || 'unknown';
        const finalCommitHash = commitHash || (await GitUtils.getLatestCommitSha(workspaceRoot)) || 'unknown';
        const commitMessage = (await GitUtils.getCommitMessage(workspaceRoot)) || 'N/A';

        const interactionTypesFromBlame = new Set<string>();
        const fileEntries = buildFileEntries(entireBlame, interactionTypesFromBlame);

        return buildReportYaml(
            generatedAt,
            branch,
            finalCommitHash,
            commitMessage,
            fileEntries,
            ideName,
            interactionTypesFromBlame,
            metrics ?? null,
            undefined,
            entireBlame
        );
    } catch (err) {
        Logger.error('Failed to generate ReportYaml from snapshot', err);
        return '';
    }
}

async function buildYamlPayload(
    workspaceRoot: string,
    blameMap: BlameMap,
    _traceStore: TraceStore,
    commitHash?: string,
    ideName: string = 'unknown',
    metrics?: ReportMetrics | null,
    /** If set (multi-root), only include blame keys starting with this prefix (e.g. `my-app/`). */
    fileKeyPrefix?: string | null,
    cliTraceSessions?: CliTraceSession[]
): Promise<{ yaml: string; hookTotals: HookTotals }> {
    const generatedAt = new Date().toISOString();
    const branch = (await GitUtils.getBranch(workspaceRoot)) || 'unknown';
    const finalCommitHash = commitHash || (await GitUtils.getLatestCommitSha(workspaceRoot)) || 'unknown';
    const commitMessage = (await GitUtils.getCommitMessage(workspaceRoot)) || 'N/A';

    const interactionTypesFromBlame = new Set<string>();
    const blameSnapshot: Record<string, LineBlame[]> = {};

    for (const filePath of blameMap.getTrackedFiles()) {
        if (fileKeyPrefix && !filePath.startsWith(fileKeyPrefix)) {
            continue;
        }
        let entries = blameMap.getBlame(filePath);
        if (commitHash != null && commitHash !== '' && commitHash !== 'unknown') {
            entries = entries.filter(e => e.commitSha === commitHash);
        } else {
            entries = entries.filter(e => e.commitSha == null);
        }
        if (entries.length === 0) continue;
        blameSnapshot[filePath] = entries;
    }

    await mergeStagedDeletionsIntoSnapshot(blameSnapshot, blameMap, workspaceRoot, fileKeyPrefix, generatedAt);

    const fileEntries = buildFileEntries(blameSnapshot, interactionTypesFromBlame);

    const metricsFromMap: ReportMetrics = metrics ?? {
        firstStartCodingTimeMs: blameMap.firstStartCodingTimeMs,
        timeWaitingForAiMs: blameMap.totalTimeWaitingForAiMs,
    };

    const yaml = buildReportYaml(
        generatedAt,
        branch,
        finalCommitHash,
        commitMessage,
        fileEntries,
        ideName,
        interactionTypesFromBlame,
        metricsFromMap,
        cliTraceSessions,
        blameSnapshot
    );
    return { yaml, hookTotals: totalsFromFileEntries(fileEntries) };
}

export async function generateContent(
    workspaceRoot: string,
    blameMap: BlameMap,
    traceStore: TraceStore,
    commitHash?: string,
    ideName: string = 'unknown',
    metrics?: ReportMetrics | null,
    /** If set (multi-root), only include blame keys starting with this prefix (e.g. `my-app/`). */
    fileKeyPrefix?: string | null,
    cliTraceSessions?: CliTraceSession[]
): Promise<string> {
    const { yaml } = await buildYamlPayload(
        workspaceRoot,
        blameMap,
        traceStore,
        commitHash,
        ideName,
        metrics,
        fileKeyPrefix,
        cliTraceSessions
    );
    return yaml;
}

/** Same as {@link generateContent}, plus {@link HookTotals} for callers that need aggregated line counts. */
export async function generateYamlAndHookTotals(
    workspaceRoot: string,
    blameMap: BlameMap,
    traceStore: TraceStore,
    commitHash?: string,
    ideName: string = 'unknown',
    metrics?: ReportMetrics | null,
    fileKeyPrefix?: string | null,
    cliTraceSessions?: CliTraceSession[]
): Promise<{ yaml: string; hookTotals: HookTotals } | null> {
    try {
        return await buildYamlPayload(
            workspaceRoot,
            blameMap,
            traceStore,
            commitHash,
            ideName,
            metrics,
            fileKeyPrefix,
            cliTraceSessions
        );
    } catch (err) {
        console.error('[blamely] FAILED to generate ReportYaml payload:', err);
        Logger.error('Failed to generate ReportYaml payload', err);
        return null;
    }
}

export async function generate(
    workspaceRoot: string,
    blameMap: BlameMap,
    traceStore: TraceStore,
    commitHash?: string,
    ideName: string = 'unknown',
    metrics?: ReportMetrics | null,
    fileKeyPrefix?: string | null,
    cliTraceSessions?: CliTraceSession[]
): Promise<string> {
    try {
        return await generateContent(workspaceRoot, blameMap, traceStore, commitHash, ideName, metrics, fileKeyPrefix, cliTraceSessions);
    } catch (err) {
        console.error('[blamely] FAILED to generate ReportYaml string:', err);
        Logger.error('Failed to generate ReportYaml string', err);
        return '';
    }
}

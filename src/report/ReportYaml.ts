import { BlameMap, LineBlame } from '../blame/BlameMap';
import { TraceStore } from '../store/TraceStore';
import * as GitUtils from '../git/GitUtils';
import * as Logger from '../utils/Logger';
import { sanitizeModelForReport } from '../utils/AiContextExtractor';

export interface ReportMetrics {
    firstStartCodingTimeMs: number;
    timeWaitingForAiMs: number;
}

interface FileEntry {
    path: string;
    source: string;
    model: string;
    aiLinesAdded: number;
    humanLinesAdded: number;
    linesDeleted: number;
    totalEntries: number;
    percentage: string;
    prompts: string[];
}

const DETECTOR_VERSION = '1.0.0';

/**
 * Two-line header read by `hookRunner.js` pre-commit (regex on # AI / # Human lines).
 * Prepended to `<git-dir>/blamely/blamely-detector.ai` when reports are generated.
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

function escapeYamlString(s: string): string {
    return JSON.stringify(s);
}

function yamlStr(value: string | null): string {
    if (value === null || value === undefined) return 'null';
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `"${escaped}"`;
}

function buildReportYaml(
    generatedAt: string,
    branch: string,
    finalCommitHash: string,
    commitMessage: string,
    fileEntries: FileEntry[],
    ideName: string,
    interactionTypesSet: Set<string>,
    metrics?: ReportMetrics | null
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
    const totalDeleted = fileEntries.reduce((s, e) => s + e.linesDeleted, 0);
    const totalChanges = totalAiAdded + totalHumanAdded + totalDeleted;
    const overallPct = totalChanges > 0 ? ((100 * totalAiAdded) / totalChanges).toFixed(1) + '%' : '0.0%';

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
    lines.push(`  human_lines_added: ${totalHumanAdded}`);
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
    lines.push(`  ide: "${ideName}"`);
    lines.push('  models:');
    if (allModels.size === 0) {
        lines.push('    - unknown');
    } else {
        for (const model of allModels) {
            lines.push(`    - "${model}"`);
        }
    }
    lines.push('  interaction_types:');
    if (interactionTypesSet.size === 0) {
        lines.push('    - unknown');
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
            lines.push(`    source: "${entry.source}"`);
            lines.push(`    model: "${entry.model}"`);
            lines.push(`    ai_lines_added: ${entry.aiLinesAdded}`);
            lines.push(`    human_lines_added: ${entry.humanLinesAdded}`);
            lines.push(`    lines_deleted: ${entry.linesDeleted}`);
            lines.push(`    total_changes: ${entry.aiLinesAdded + entry.humanLinesAdded + entry.linesDeleted}`);
            lines.push(`    ai_percentage: "${entry.percentage}"`);
            lines.push('    prompts:');
            if (entry.prompts.length === 0) {
                lines.push('      []');
            } else {
                for (const p of entry.prompts) {
                    lines.push(`      - ${escapeYamlString(p)}`);
                }
            }
        }
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
            lines.push(`      provider: ${yamlStr(e.provider)}`);
            lines.push(`      model: ${yamlStr(e.model)}`);
            if (e.prompt) lines.push(`      prompt: ${yamlStr(e.prompt)}`);
            if (e.interactionType) lines.push(`      interactionType: ${yamlStr(e.interactionType)}`);
            lines.push(`      changeType: "${e.changeType}"`);
            lines.push(`      codingType: "${e.codingType ?? 'TYPING'}"`);
        }
    }
    return lines.join('\n');
}

function buildFileEntries(
    entireBlame: Record<string, LineBlame[]>,
    interactionTypesFromBlame: Set<string>
): FileEntry[] {
    const fileEntries: FileEntry[] = [];
    for (const [filePath, entries] of Object.entries(entireBlame)) {
        if (entries.length === 0) continue;
        const addedEntries = entries.filter(e => (e.changeType ?? 'ADD') === 'ADD');
        const deletedCount = entries.filter(e => e.changeType === 'DELETE').length;

        let aiLines = 0;
        let humanLines = 0;
        const sources = new Set<string>();
        const modelsSet = new Set<string>();
        const promptsSet = new Set<string>();

        for (const e of addedEntries) {
            if (e.authorType === 'AI') {
                aiLines++;
                if (e.provider) sources.add(e.provider);
                const sanitized = sanitizeModelForReport(e.model);
                if (sanitized) modelsSet.add(sanitized);
                if (e.prompt) promptsSet.add(e.prompt);
                if (e.interactionType?.trim()) interactionTypesFromBlame.add(e.interactionType);
            } else {
                humanLines++;
            }
        }

        const totalAdded = aiLines + humanLines;
        const totalAll = totalAdded + deletedCount;
        const pct = totalAll > 0 ? ((100 * aiLines) / totalAll).toFixed(1) + '%' : '0.0%';
        const modelDisplay = modelsSet.size === 0 ? 'unknown'
            : modelsSet.size === 1 ? [...modelsSet][0]
            : 'multiple';

        fileEntries.push({
            path: filePath,
            source: sources.size === 1 ? [...sources][0] : 'multiple',
            model: modelDisplay,
            aiLinesAdded: aiLines,
            humanLinesAdded: humanLines,
            linesDeleted: deletedCount,
            totalEntries: totalAll,
            percentage: pct,
            prompts: [...promptsSet],
        });
    }
    return fileEntries;
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
            metrics ?? null
        );
    } catch (err) {
        Logger.error('Failed to generate ReportYaml from snapshot', err);
        return '';
    }
}

export async function generateContent(
    workspaceRoot: string,
    blameMap: BlameMap,
    _traceStore: TraceStore,
    commitHash?: string,
    ideName: string = 'unknown',
    metrics?: ReportMetrics | null,
    /** If set (multi-root), only include blame keys starting with this prefix (e.g. `my-app/`). */
    fileKeyPrefix?: string | null
): Promise<string> {
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
        if (finalCommitHash && finalCommitHash !== 'unknown') {
            entries = entries.filter(e => e.commitSha === finalCommitHash);
        }
        if (entries.length === 0) continue;
        blameSnapshot[filePath] = entries;
    }

    const fileEntries = buildFileEntries(blameSnapshot, interactionTypesFromBlame);

    const metricsFromMap: ReportMetrics = metrics ?? {
        firstStartCodingTimeMs: blameMap.firstStartCodingTimeMs,
        timeWaitingForAiMs: blameMap.totalTimeWaitingForAiMs,
    };

    return buildReportYaml(
        generatedAt,
        branch,
        finalCommitHash,
        commitMessage,
        fileEntries,
        ideName,
        interactionTypesFromBlame,
        metricsFromMap
    );
}

export async function generate(
    workspaceRoot: string,
    blameMap: BlameMap,
    traceStore: TraceStore,
    commitHash?: string,
    ideName: string = 'unknown',
    metrics?: ReportMetrics | null,
    fileKeyPrefix?: string | null
): Promise<string> {
    try {
        return await generateContent(workspaceRoot, blameMap, traceStore, commitHash, ideName, metrics, fileKeyPrefix);
    } catch (err) {
        console.error('[blamely] FAILED to generate ReportYaml string:', err);
        Logger.error('Failed to generate ReportYaml string', err);
        return '';
    }
}

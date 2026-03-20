import * as vscode from 'vscode';
import { BlameMap, LineBlame } from '../blame/BlameMap';
import { TraceStore } from '../store/TraceStore';
import * as ReportYaml from '../report/ReportYaml';
import * as BlameSerializer from '../blame/BlameSerializer';
import * as GitUtils from './GitUtils';
import {
    getLatestCommitSha,
    getRepoRoot,
    getFilesChangedInCommit,
    getDiffStats,
    repoRelativeToProjectRelative,
} from './GitUtils';
import * as Logger from '../utils/Logger';

export class CommitListener implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private blameMap: BlameMap;
    private traceStore: TraceStore;
    private workspaceRoot: string;
    private lastKnownSha: string | null = null;
    private pollInterval: NodeJS.Timeout | null = null;
    private onCommitCompleted: () => void;
    private processing = false;

    constructor(
        blameMap: BlameMap,
        traceStore: TraceStore,
        workspaceRoot: string,
        onCommitCompleted: () => void
    ) {
        this.blameMap = blameMap;
        this.traceStore = traceStore;
        this.workspaceRoot = workspaceRoot;
        this.onCommitCompleted = onCommitCompleted;
        this.start();
    }

    private async start(): Promise<void> {
        this.lastKnownSha = await getLatestCommitSha(this.workspaceRoot);

        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            try {
                const git = gitExtension.isActive
                    ? gitExtension.exports
                    : await gitExtension.activate();
                const api = git.getAPI(1);
                if (api && api.repositories.length > 0) {
                    const repo = api.repositories[0];
                    repo.state.onDidChange(() => {
                        this.checkForNewCommit();
                    });
                    Logger.info('Listening for commits via Git extension API');
                    return;
                }
            } catch (err) {
                Logger.warn('Could not use Git extension API, falling back to polling');
            }
        }

        this.pollInterval = setInterval(() => {
            this.checkForNewCommit();
        }, 5000);
        Logger.info('Listening for commits via polling (5s interval)');
    }

    private async checkForNewCommit(): Promise<void> {
        if (this.processing) return;
        try {
            const currentSha = await getLatestCommitSha(this.workspaceRoot);
            if (currentSha && currentSha !== this.lastKnownSha) {
                this.processing = true;
                this.lastKnownSha = currentSha;
                Logger.info(`New commit detected: ${currentSha.slice(0, 8)}`);
                await this.handlePostCommit(currentSha);
                this.processing = false;
            }
        } catch (err) {
            this.processing = false;
            Logger.error('Error checking for new commit', err);
        }
    }

    private async handlePostCommit(commitSha: string): Promise<void> {
        const repoRoot = await getRepoRoot(this.workspaceRoot);
        if (!repoRoot) {
            Logger.warn('CommitListener: no git repo root, clearing blame anyway');
            this.blameMap.clear();
            await BlameSerializer.clearCurrentBranchSnapshots(this.workspaceRoot);
            this.onCommitCompleted();
            this.openHistoryView();
            return;
        }

        try {
            let changedRepoRelative = await getFilesChangedInCommit(repoRoot, commitSha);
            if (changedRepoRelative.length === 0) {
                await new Promise(r => setTimeout(r, 300));
                changedRepoRelative = await getFilesChangedInCommit(repoRoot, commitSha);
            }

            const repoToProject = repoRelativeToProjectRelative(
                repoRoot,
                this.workspaceRoot,
                changedRepoRelative
            );

            const entireBlame: Record<string, LineBlame[]> = {};
            const ts = new Date().toISOString();

            for (const repoRel of changedRepoRelative) {
                const projectRel = repoToProject.get(repoRel) ?? repoRel;
                const stats = await GitUtils.getDiffStats(repoRoot, commitSha, repoRel);
                if (stats.addedCount === 0 && stats.deletedCount === 0) continue;

                const trackerBlame = this.blameMap.getBlame(projectRel);
                const trackerByLine = new Map(trackerBlame.map(e => [e.lineNumber, e]));
                const entries: LineBlame[] = [];

                for (const line of stats.addedLines.sort((a, b) => a - b)) {
                    const tracked = trackerByLine.get(line);
                    const authorType = tracked?.authorType ?? 'HUMAN';
                    const provider = authorType === 'AI' ? (tracked?.provider ?? 'unknown') : null;
                    const model = authorType === 'AI' ? (tracked?.model ?? null) : null;
                    const prompt = authorType === 'AI' ? (tracked?.prompt ?? null) : null;
                    entries.push({
                        lineNumber: line,
                        authorType: authorType,
                        provider,
                        timestamp: ts,
                        commitSha: commitSha,
                        model,
                        prompt,
                        interactionType: null,
                        aiChars: authorType === 'AI' ? 1 : 0,
                        humanChars: authorType === 'HUMAN' ? 1 : 0,
                        changeType: 'ADD',
                        newLineNumber: line,
                        oldLineNumber: null,
                        codingType: tracked?.codingType ?? 'TYPING',
                    });
                }

                for (const oldLine of stats.deletedLines.sort((a, b) => a - b)) {
                    const deletedByAi = this.blameMap.wasLineDeletedByAi(projectRel, oldLine);
                    const authorType = deletedByAi ? 'AI' : 'HUMAN';
                    entries.push({
                        lineNumber: oldLine,
                        authorType: authorType,
                        provider: deletedByAi ? 'github-copilot' : null,
                        timestamp: ts,
                        commitSha: commitSha,
                        model: deletedByAi ? 'unknown' : null,
                        prompt: null,
                        interactionType: null,
                        aiChars: deletedByAi ? 1 : 0,
                        humanChars: deletedByAi ? 0 : 1,
                        changeType: 'DELETE',
                        newLineNumber: null,
                        oldLineNumber: oldLine,
                        codingType: 'TYPING',
                    });
                }

                if (entries.length > 0) {
                    entries.sort((a, b) => (a.newLineNumber ?? a.oldLineNumber ?? 0) - (b.newLineNumber ?? b.oldLineNumber ?? 0));
                    entireBlame[repoRel] = entries;
                }
            }

            const reportMetrics: ReportYaml.ReportMetrics = {
                firstStartCodingTimeMs: this.blameMap.firstStartCodingTimeMs,
                timeWaitingForAiMs: this.blameMap.totalTimeWaitingForAiMs,
            };
            const yamlReport = await ReportYaml.generateFromBlameSnapshot(
                this.workspaceRoot,
                entireBlame,
                this.traceStore,
                commitSha,
                vscode.env.appName,
                reportMetrics
            );
            const snapshotYaml = ReportYaml.blameSnapshotToYamlForReport(entireBlame);
            const noteContent = `${yamlReport}\n---\nblames:\n${snapshotYaml}`;

            try {
                await GitUtils.addGitNote(commitSha, noteContent, this.workspaceRoot);
                await GitUtils.pushGitNotes(this.workspaceRoot);
                Logger.info(`Attached and pushed ai-trace git note for commit ${commitSha}`);
            } catch (err) {
                Logger.error(`Failed to handle git notes for commit ${commitSha}`, err);
            }
        } catch (err) {
            Logger.error(`Error building report for commit ${commitSha}`, err);
        } finally {
            this.blameMap.clear();
            await BlameSerializer.clearCurrentBranchSnapshots(this.workspaceRoot);
            this.onCommitCompleted();
            Logger.info('Post-commit: blame cleared and UI refreshed');
            this.openHistoryView();
        }
    }

    /** Open Source Control and focus the Blamely History view after commit (status bar reset). */
    private openHistoryView(): void {
        void vscode.commands.executeCommand('workbench.view.scm').then(() => {
            setTimeout(() => {
                void vscode.commands.executeCommand('aiTraceHistory.focus');
            }, 100);
        });
    }

    async prepareForCommit(): Promise<void> {
        try {
            Logger.info('Nothing to stage pre-commit for Git Notes architecture.');
        } catch (err) {
            Logger.error('Failed to prepare for commit', err);
        }
    }

    dispose(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

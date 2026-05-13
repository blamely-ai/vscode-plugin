import * as path from 'path';
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
} from './GitUtils';
import * as Logger from '../utils/Logger';
import { blameFileKey, blameKeyBelongsToRepo, workspaceFoldersUnderRepo } from '../utils/WorkspacePaths';

/** Optional UI hook after post-commit cleanup (e.g. suppress History webview, clear trace files when a git note was saved). */
export type PostCommitUiCallback = (opts: { repoRoot: string; gitNoteWritten: boolean }) => void;

export class CommitListener implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private blameMap: BlameMap;
    private traceStore: TraceStore;
    private lastKnownShaByRepo = new Map<string, string>();
    private pollInterval: NodeJS.Timeout | null = null;
    private onCommitCompleted: () => void;
    private onPostCommitUi?: PostCommitUiCallback;
    private processing = false;

    constructor(
        blameMap: BlameMap,
        traceStore: TraceStore,
        onCommitCompleted: () => void,
        onPostCommitUi?: PostCommitUiCallback
    ) {
        this.blameMap = blameMap;
        this.traceStore = traceStore;
        this.onCommitCompleted = onCommitCompleted;
        this.onPostCommitUi = onPostCommitUi;
        this.start();
    }

    private async start(): Promise<void> {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            try {
                const git = gitExtension.isActive
                    ? gitExtension.exports
                    : await gitExtension.activate();
                const api = git.getAPI(1);
                if (api && api.repositories.length > 0) {
                    for (const repo of api.repositories) {
                        const root = repo.rootUri.fsPath;
                        const sha = await getLatestCommitSha(root);
                        this.lastKnownShaByRepo.set(root, sha ?? '');
                        const sub = repo.state.onDidChange(() => {
                            void this.checkForNewCommitForRepo(root);
                        });
                        this.disposables.push(sub);
                    }
                    Logger.info('Listening for commits via Git extension API');
                    return;
                }
            } catch (err) {
                Logger.warn('Could not use Git extension API, falling back to polling');
            }
        }

        await this.initPollingRoots();
        this.pollInterval = setInterval(() => {
            void this.pollAllRepos();
        }, 5000);
        Logger.info('Listening for commits via polling (5s interval)');
    }

    private async initPollingRoots(): Promise<void> {
        const seen = new Set<string>();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const rr = await getRepoRoot(folder.uri.fsPath);
            if (!rr || seen.has(rr)) {
                continue;
            }
            seen.add(rr);
            const sha = await getLatestCommitSha(rr);
            this.lastKnownShaByRepo.set(rr, sha ?? '');
        }
    }

    private async pollAllRepos(): Promise<void> {
        for (const root of this.lastKnownShaByRepo.keys()) {
            await this.checkForNewCommitForRepo(root);
        }
    }

    private async checkForNewCommitForRepo(repoRoot: string): Promise<void> {
        if (this.processing) {
            return;
        }
        try {
            const currentSha = await getLatestCommitSha(repoRoot);
            const lastSha = this.lastKnownShaByRepo.get(repoRoot);
            if (currentSha && currentSha !== lastSha) {
                this.processing = true;
                this.lastKnownShaByRepo.set(repoRoot, currentSha);
                Logger.info(`New commit detected: ${currentSha.slice(0, 8)} in ${repoRoot}`);
                await this.handlePostCommit(repoRoot, currentSha);
                this.processing = false;
            }
        } catch (err) {
            this.processing = false;
            Logger.error('Error checking for new commit', err);
        }
    }

    private async handlePostCommit(repoRoot: string, commitSha: string): Promise<void> {
        const resolvedRoot = (await getRepoRoot(repoRoot)) ?? repoRoot;
        let gitNoteWritten = false;

        try {
            let changedRepoRelative = await getFilesChangedInCommit(resolvedRoot, commitSha);
            if (changedRepoRelative.length === 0) {
                await new Promise(r => setTimeout(r, 300));
                changedRepoRelative = await getFilesChangedInCommit(resolvedRoot, commitSha);
            }

            const entireBlame: Record<string, LineBlame[]> = {};
            const ts = new Date().toISOString();

            for (const repoRel of changedRepoRelative) {
                const absPath = path.normalize(path.join(resolvedRoot, repoRel));
                const uri = vscode.Uri.file(absPath);
                const projectRel = blameFileKey(uri);
                const stats = await GitUtils.getDiffStats(resolvedRoot, commitSha, repoRel);
                if (stats.addedCount === 0 && stats.deletedCount === 0) {
                    continue;
                }

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
                resolvedRoot,
                entireBlame,
                this.traceStore,
                commitSha,
                vscode.env.appName,
                reportMetrics
            );
            const snapshotYaml = ReportYaml.blameSnapshotToYamlForReport(entireBlame);
            const noteContent = `${yamlReport}\n---\nblames:\n${snapshotYaml}`;

            try {
                gitNoteWritten = await GitUtils.addGitNote(commitSha, noteContent, resolvedRoot);
                await GitUtils.pushGitNotes(resolvedRoot);
                if (gitNoteWritten) {
                    Logger.info(`Attached and pushed blamely git note for commit ${commitSha}`);
                }
            } catch (err) {
                Logger.error(`Failed to handle git notes for commit ${commitSha}`, err);
            }
        } catch (err) {
            Logger.error(`Error building report for commit ${commitSha}`, err);
        } finally {
            const keysToRemove: string[] = [];
            for (const k of this.blameMap.getTrackedFiles()) {
                if (blameKeyBelongsToRepo(resolvedRoot, k)) {
                    keysToRemove.push(k);
                }
            }
            this.blameMap.removeFiles(keysToRemove);
            this.traceStore.removeSuggestionsForBlameKeys(new Set(keysToRemove));

            for (const folder of workspaceFoldersUnderRepo(resolvedRoot)) {
                await BlameSerializer.clearCurrentBranchSnapshots(folder.uri.fsPath);
            }
            this.onCommitCompleted();
            Logger.info(`Post-commit: cleared ${keysToRemove.length} tracked file(s) for repo, UI refreshed`);
            this.onPostCommitUi?.({ repoRoot: resolvedRoot, gitNoteWritten });
        }
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

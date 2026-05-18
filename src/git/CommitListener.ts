import * as fs from 'fs';
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
import { countAiHumanLineDeltas, formatPostCommitAttributionBar } from '../utils/attributionBarText';
import {
    blameFileKey,
    blameKeyBelongsToRepo,
    normalizeLoadedBlameKey,
    workspaceFoldersUnderRepo,
} from '../utils/WorkspacePaths';
import * as BlamelyRepoPaths from '../store/BlamelyRepoPaths';

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
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Blamely',
                    cancellable: false,
                },
                async progress => {
                    const br = await GitUtils.getBranch(resolvedRoot);
                    progress.report({ message: 'Post-commit: archiving blame snapshots…' });
                    await BlamelyRepoPaths.archiveBranchBlameSnapshotsToClosed(resolvedRoot, br, commitSha);
                    const archivedSnapshotsDir = BlamelyRepoPaths.closedCommitSnapshotsDir(
                        resolvedRoot,
                        br,
                        commitSha
                    );
                    const legacyArchivedDir = BlamelyRepoPaths.legacyClosedCommitSnapshotsDir(
                        resolvedRoot,
                        br,
                        commitSha
                    );

                    progress.report({ message: 'Post-commit: building report from blame.json…' });
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

                        const diskByLine = new Map<number, LineBlame>();
                        let jsonPath = BlameSerializer.resolveArchivedBlameSnapshotPath(
                            archivedSnapshotsDir,
                            repoRel,
                            projectRel
                        );
                        if (!jsonPath && legacyArchivedDir) {
                            jsonPath = BlameSerializer.resolveArchivedBlameSnapshotPath(
                                legacyArchivedDir,
                                repoRel,
                                projectRel
                            );
                        }
                        if (jsonPath) {
                            const diskRows = await BlameSerializer.loadBlameFromSnapshotFile(jsonPath);
                            for (const row of diskRows) {
                                if ((row.changeType ?? 'ADD') === 'ADD') {
                                    diskByLine.set(row.lineNumber, row);
                                }
                            }
                        }

                        for (const line of stats.addedLines.sort((a, b) => a - b)) {
                            const disk = diskByLine.get(line);
                            const tracked = trackerByLine.get(line);
                            const authorType = disk?.authorType ?? tracked?.authorType ?? 'HUMAN';
                            const model =
                                authorType === 'AI'
                                    ? (disk?.model ?? tracked?.model ?? null)
                                    : null;
                            const prompt =
                                authorType === 'AI' ? (disk?.prompt ?? tracked?.prompt ?? null) : null;
                            const interaction =
                                authorType === 'AI'
                                    ? (disk?.interactionType ?? tracked?.interactionType ?? null)
                                    : null;
                            const aiC =
                                authorType === 'AI' ? (disk?.aiChars ?? tracked?.aiChars ?? 1) : 0;
                            const humC =
                                authorType === 'HUMAN'
                                    ? (disk?.humanChars ?? tracked?.humanChars ?? 1)
                                    : 0;
                            entries.push({
                                lineNumber: line,
                                authorType: authorType,
                                provider: null,
                                timestamp: ts,
                                commitSha: commitSha,
                                model,
                                prompt,
                                interactionType: interaction,
                                ide: disk?.ide ?? tracked?.ide ?? null,
                                aiChars: aiC,
                                humanChars: humC,
                                changeType: 'ADD',
                                newLineNumber: line,
                                oldLineNumber: null,
                                codingType: disk?.codingType ?? tracked?.codingType ?? 'TYPING',
                            });
                        }

                        for (const oldLine of stats.deletedLines.sort((a, b) => a - b)) {
                            const deletedByAi = this.blameMap.wasLineDeletedByAi(projectRel, oldLine);
                            const authorType = deletedByAi ? 'AI' : 'HUMAN';
                            entries.push({
                                lineNumber: oldLine,
                                authorType: authorType,
                                provider: null,
                                timestamp: ts,
                                commitSha: commitSha,
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

                        if (entries.length > 0) {
                            entries.sort(
                                (a, b) =>
                                    (a.newLineNumber ?? a.oldLineNumber ?? 0) -
                                    (b.newLineNumber ?? b.oldLineNumber ?? 0)
                            );
                            entireBlame[repoRel] = entries;
                        }
                    }

                    progress.report({ message: 'Post-commit: git note & report…' });
                    const reportMetrics: ReportYaml.ReportMetrics = {
                        firstStartCodingTimeMs: this.blameMap.firstStartCodingTimeMs,
                        timeWaitingForAiMs: this.blameMap.totalTimeWaitingForAiMs,
                    };
                    /** Full YAML for this commit (always written under logs/commits/<sha>/report.yml). */
                    const generatedReport = await ReportYaml.generateFromBlameSnapshot(
                        resolvedRoot,
                        entireBlame,
                        this.traceStore,
                        commitSha,
                        vscode.env.appName,
                        reportMetrics
                    );
                    /** Git note body: prefer existing per-branch report.yml so user edits are not overwritten on disk. */
                    let noteYamlPrefix = generatedReport.trimEnd();
                    try {
                        const branchReportPath = await BlamelyRepoPaths.reportYamlPath(resolvedRoot, br);
                        if (branchReportPath && fs.existsSync(branchReportPath)) {
                            const existing = await fs.promises.readFile(branchReportPath, 'utf-8');
                            if (existing.trim().length > 0) {
                                noteYamlPrefix = existing.replace(/\s+$/, '');
                            }
                        }
                    } catch {
                        /* use generatedReport */
                    }
                    try {
                        const reportPath = BlamelyRepoPaths.commitLogReportPath(resolvedRoot, commitSha);
                        if (reportPath) {
                            await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
                            await fs.promises.writeFile(reportPath, generatedReport, 'utf-8');
                        }
                    } catch (err) {
                        Logger.warn(`Blamely: commit log report.yml: ${err}`);
                    }
                    const snapshotYaml = ReportYaml.blameSnapshotToYamlForReport(entireBlame);
                    const noteContent = `${noteYamlPrefix}\n---\nblames:\n${snapshotYaml}`;

                    try {
                        gitNoteWritten = await GitUtils.addGitNote(
                            commitSha,
                            noteContent,
                            resolvedRoot
                        );
                        await GitUtils.pushGitNotes(resolvedRoot);
                        if (gitNoteWritten) {
                            Logger.info(`Attached and pushed blamely git note for commit ${commitSha}`);
                        }
                    } catch (err) {
                        Logger.error(`Failed to handle git notes for commit ${commitSha}`, err);
                    }

                    try {
                        if (
                            vscode.workspace
                                .getConfiguration('blamely')
                                .get<boolean>('showPostCommitAttributionInOutput', true)
                        ) {
                            const { ai, human } = countAiHumanLineDeltas(entireBlame);
                            Logger.appendPlainBlock('');
                            Logger.appendPlainBlock(formatPostCommitAttributionBar(ai, human, 42));
                            Logger.show();
                        }
                    } catch {
                        /* ignore output channel failures */
                    }
                }
            );
        } catch (err) {
            Logger.error(`Error building report for commit ${commitSha}`, err);
        } finally {
            let branchForPersistence: string | null | undefined;
            try {
                branchForPersistence = await GitUtils.getBranch(resolvedRoot);
                await BlamelyRepoPaths.archiveBranchTraceToClosed(
                    resolvedRoot,
                    branchForPersistence,
                    commitSha
                );
            } catch (archErr) {
                Logger.warn(`archive branch trace: ${archErr}`);
            }
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
            /**
             * Git notes / report.yml only record commit diff hunks, but archived blame under
             * logs/commits/<sha>/snapshots/ has full per-file line maps. Copy them back to the
             * branch snapshots dir and reload so gutters still show AI vs human on unchanged lines.
             */
            try {
                if (!branchForPersistence) {
                    branchForPersistence = await GitUtils.getBranch(resolvedRoot);
                }
                const restored = await BlamelyRepoPaths.restoreCommitSnapshotsToBranchDir(
                    resolvedRoot,
                    branchForPersistence,
                    commitSha
                );
                if (restored) {
                    for (const folder of workspaceFoldersUnderRepo(resolvedRoot)) {
                        const saved = await BlameSerializer.loadAll(folder.uri.fsPath);
                        for (const [file, entries] of saved) {
                            const key = normalizeLoadedBlameKey(file, folder);
                            if (blameKeyBelongsToRepo(resolvedRoot, key) && entries.length > 0) {
                                this.blameMap.setFileBlame(key, entries);
                            }
                        }
                    }
                    for (const ed of vscode.window.visibleTextEditors) {
                        if (ed.document.uri.scheme !== 'file') {
                            continue;
                        }
                        const bk = blameFileKey(ed.document.uri);
                        if (!blameKeyBelongsToRepo(resolvedRoot, bk)) {
                            continue;
                        }
                        this.blameMap.clipLinesToDocumentLength(bk, ed.document.lineCount);
                    }
                    Logger.info(
                        `Post-commit: restored full-file blame snapshots from commit ${commitSha.slice(0, 8)}`
                    );
                }
            } catch (restoreErr) {
                Logger.warn(`Post-commit: restore branch blame snapshots: ${restoreErr}`);
            }
            this.onCommitCompleted();
            Logger.info(
                `Post-commit: repo blame refresh complete (${keysToRemove.length} key(s) reset; snapshots restored when archive existed)`
            );
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

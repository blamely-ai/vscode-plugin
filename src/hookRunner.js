/**
 * hookRunner.js — Executed by the Git pre-commit hook.
 * (Deprecated: Used to stage detector.ai and ai-trace-report.md)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();

function run(cmd) {
    try {
        return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
    } catch (err) {
        console.error(`[ai-trace hook] Command failed: ${cmd}`);
        console.error(err.message);
        return null;
    }
}

function main() {
    console.log('[ai-trace] Pre-commit hook running...');

    // Check if detector.ai exists (extension is active and has generated data)
    const detectorPath = path.join(cwd, 'detector.ai');

    if (!fs.existsSync(detectorPath)) {
        console.log('[ai-trace] No detector.ai found — skipping');
        process.exit(0);
    }

    // Stage the files
    if (fs.existsSync(detectorPath)) {
        run('git add detector.ai');
    }

    // Read summary from detector.ai to get AI %
    try {
        if (fs.existsSync(detectorPath)) {
            const content = fs.readFileSync(detectorPath, 'utf-8');
            const aiMatch = content.match(/# AI-authored lines:\s+(\d+)\s+\((\d+\.\d+)%\)/);
            const humanMatch = content.match(/# Human-authored lines:\s+(\d+)\s+\((\d+\.\d+)%\)/);

            if (aiMatch && humanMatch) {
                const aiPercent = aiMatch[2];
                const humanPercent = humanMatch[2];

                // Try to get short SHA
                const sha = run('git rev-parse --short=8 HEAD') || '00000000';

                // Write to COMMIT_EDITMSG if available (for prepare-commit-msg)
                const commitMsgPath = process.argv[2];
                if (commitMsgPath && fs.existsSync(commitMsgPath)) {
                    const existingMsg = fs.readFileSync(commitMsgPath, 'utf-8');
                    const suffix = `\n\n[ai-trace: ${sha} — AI: ${aiPercent}%, Human: ${humanPercent}%]`;
                    fs.writeFileSync(commitMsgPath, existingMsg.trimEnd() + suffix + '\n');
                    console.log(`[ai-trace] Appended summary to commit message`);
                }

                console.log(`[ai-trace] AI: ${aiPercent}%, Human: ${humanPercent}%`);
            }
        }
    } catch (err) {
        console.error('[ai-trace] Error reading detector.ai:', err.message);
    }

    console.log('[ai-trace] Pre-commit hook complete');
}

main();

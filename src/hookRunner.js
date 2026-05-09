/**
 * hookRunner.js — Executed by the Git pre-commit hook.
 * Reads `<git-dir>/blamely/blamely-detector.ai` when present (written by the extension; same YAML as `report.yml`,
 * plus a two-line # AI / # Human summary header for optional commit-message suffix). Not staged — lives under .git.
 *
 * One line: `[blamely] AI  N lines · P%  ████…  M lines · Q%  Human` (counts at bar edges).
 * Respects NO_COLOR / dumb TERM (plain ASCII only).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();

function colorsEnabled() {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
        return false;
    }
    if (process.env.FORCE_COLOR === '0') {
        return false;
    }
    const fc = String(process.env.FORCE_COLOR ?? '');
    if (fc === '1' || fc === '2' || fc === '3' || fc === 'true') {
        return true;
    }
    return process.stdout.isTTY === true;
}

const useColor = colorsEnabled();

/** Wrap segment with SGR code (no-op when colors off). */
function paint(code, text) {
    if (!useColor) {
        return text;
    }
    return `\x1b[${code}m${text}\x1b[0m`;
}

function run(cmd) {
    try {
        return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
    } catch (err) {
        console.error(`[blamely] Command failed: ${cmd}`);
        console.error(err.message);
        return null;
    }
}

function gitDirAbsolute() {
    const gd = run('git rev-parse --git-dir');
    if (!gd) {
        return null;
    }
    return path.isAbsolute(gd) ? path.normalize(gd) : path.resolve(cwd, gd);
}

function fmtPct(s) {
    const n = parseFloat(String(s), 10);
    return Number.isFinite(n) ? n.toFixed(1) : String(s);
}

/**
 * Bar length `width`: green blocks = AI line share, blue blocks = Human line share.
 */
function attributionShareBar(aiLines, humanLines, width = 36) {
    const total = aiLines + humanLines;
    if (total <= 0) {
        return paint('90', '░'.repeat(width));
    }
    let aiBlocks = Math.round((aiLines / total) * width);
    if (aiLines > 0 && aiBlocks === 0) {
        aiBlocks = 1;
    }
    if (humanLines > 0 && aiBlocks === width) {
        aiBlocks = width - 1;
    }
    const humanBlocks = width - aiBlocks;
    const greenSeg = paint('92', '█'.repeat(aiBlocks));
    const blueSeg = paint('94', '█'.repeat(humanBlocks));
    return greenSeg + blueSeg;
}

function main() {
    const absGitDir = gitDirAbsolute();
    if (!absGitDir) {
        console.log('[blamely] Git dir not resolved — skipping');
        process.exit(0);
    }

    const detectorPath = path.join(absGitDir, 'blamely', 'blamely-detector.ai');

    if (!fs.existsSync(detectorPath)) {
        console.log('[blamely] No blamely-detector.ai — skipping');
        process.exit(0);
    }

    try {
        const content = fs.readFileSync(detectorPath, 'utf-8');
        const aiMatch = content.match(/# AI-authored lines:\s+(\d+)\s+\(([\d.]+)%\)/);
        const humanMatch = content.match(/# Human-authored lines:\s+(\d+)\s+\(([\d.]+)%\)/);

        if (!aiMatch || !humanMatch) {
            console.log('[blamely] Detector missing AI/Human summary header — regenerate report');
            process.exit(0);
        }

        const aiLines = parseInt(aiMatch[1], 10);
        const humanLines = parseInt(humanMatch[1], 10);
        const aiPct = fmtPct(aiMatch[2]);
        const humanPct = fmtPct(humanMatch[2]);

        const bar = attributionShareBar(aiLines, humanLines, 36);
        const aiLabel = useColor ? paint('92', 'AI') : 'AI';
        const humanLabel = useColor ? paint('94', 'Human') : 'Human';
        const aiStats = useColor ? paint('92', `${aiLines} lines · ${aiPct}%`) : `${aiLines} lines · ${aiPct}%`;
        const humanStats = useColor ? paint('94', `${humanLines} lines · ${humanPct}%`) : `${humanLines} lines · ${humanPct}%`;

        console.log(`[blamely] ${aiLabel}  ${aiStats}  ${bar}  ${humanStats}  ${humanLabel}`);

        const sha = run('git rev-parse --short=8 HEAD') || '00000000';
        const commitMsgPath = process.argv[2];
        if (commitMsgPath && fs.existsSync(commitMsgPath)) {
            const existingMsg = fs.readFileSync(commitMsgPath, 'utf-8');
            const suffix = `\n\n[blamely: ${sha} — AI: ${aiPct}%, Human: ${humanPct}%]`;
            fs.writeFileSync(commitMsgPath, existingMsg.trimEnd() + suffix + '\n');
        }
    } catch (err) {
        console.error('[blamely] Error reading detector:', err.message);
        process.exit(0);
    }
}

main();

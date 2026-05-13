/**
 * hookRunner.js — Executed by the Git pre-commit hook.
 * Reads `<git-dir>/blamely/blamely-detector.ai` when present (written by the extension).
 *
 * Shows AI vs Human **additions** (green / blue) and **deletions** (red) with a four-segment bar:
 *   AI added | AI deleted | Human added | Human deleted
 *
 * Legacy files without `# ai_lines_added:` lines fall back to totals-only (deletions shown as 0).
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
 * Largest-remainder allocation so segment widths sum exactly to `width`.
 */
function allocateSegments(counts, width) {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total <= 0) {
        return counts.map(() => 0);
    }
    const exact = counts.map((c) => (c * width) / total);
    const base = exact.map((x) => Math.floor(x));
    let rem = width - base.reduce((a, b) => a + b, 0);
    const frac = exact.map((x, i) => ({ i, r: x - base[i] }));
    frac.sort((a, b) => b.r - a.r);
    for (let k = 0; k < rem; k++) {
        base[frac[k % frac.length].i]++;
    }
    return base;
}

/**
 * Four-part bar: AI add (green 92), AI del (red 91), Human add (blue 94), Human del (red 91).
 */
function contributionBar(aiAdded, aiDeleted, humanAdded, humanDeleted, width = 40) {
    const counts = [aiAdded, aiDeleted, humanAdded, humanDeleted];
    const codes = ['92', '91', '94', '91'];
    const blocks = allocateSegments(counts, width);
    let out = '';
    for (let i = 0; i < 4; i++) {
        const piece = '█'.repeat(blocks[i]);
        out += piece.length > 0 ? paint(codes[i], piece) : '';
    }
    const joined = out.length > 0 ? out : paint('90', '░'.repeat(width));
    return joined;
}

function parseDetectorTotals(content) {
    const ma = /^#\s*ai_lines_added:\s*(\d+)/m.exec(content);
    const md = /^#\s*ai_lines_deleted:\s*(\d+)/m.exec(content);
    const mh = /^#\s*human_lines_added:\s*(\d+)/m.exec(content);
    const mhd = /^#\s*human_lines_deleted:\s*(\d+)/m.exec(content);
    if (ma && md && mh && mhd) {
        return {
            aiAdded: parseInt(ma[1], 10),
            aiDeleted: parseInt(md[1], 10),
            humanAdded: parseInt(mh[1], 10),
            humanDeleted: parseInt(mhd[1], 10),
        };
    }
    const aiMatch = content.match(/# AI-authored lines:\s+(\d+)\s+\(([\d.]+)%\)/);
    const humanMatch = content.match(/# Human-authored lines:\s+(\d+)\s+\(([\d.]+)%\)/);
    if (aiMatch && humanMatch) {
        const aiLines = parseInt(aiMatch[1], 10);
        const humanLines = parseInt(humanMatch[1], 10);
        return {
            aiAdded: aiLines,
            aiDeleted: 0,
            humanAdded: humanLines,
            humanDeleted: 0,
            legacyAiPct: fmtPct(aiMatch[2]),
            legacyHumanPct: fmtPct(humanMatch[2]),
        };
    }
    return null;
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
        const t = parseDetectorTotals(content);

        if (!t) {
            console.log('[blamely] Detector missing AI/Human summary header — regenerate report');
            process.exit(0);
        }

        const aiAdded = t.aiAdded;
        const aiDeleted = t.aiDeleted;
        const humanAdded = t.humanAdded;
        const humanDeleted = t.humanDeleted;

        const aiMass = aiAdded + aiDeleted;
        const humanMass = humanAdded + humanDeleted;
        const all = aiMass + humanMass;

        const aiPct =
            t.legacyAiPct !== undefined
                ? t.legacyAiPct
                : all > 0
                  ? ((100 * aiMass) / all).toFixed(1)
                  : '0.0';
        const humanPct =
            t.legacyHumanPct !== undefined
                ? t.legacyHumanPct
                : all > 0
                  ? ((100 * humanMass) / all).toFixed(1)
                  : '0.0';

        const bar = contributionBar(aiAdded, aiDeleted, humanAdded, humanDeleted, 40);

        const aiLabel = paint('92', 'AI');
        const humanLabel = paint('94', 'Human');

        const aiAdds = paint('92', `+${aiAdded}`);
        const aiDels = aiDeleted > 0 ? ` ${paint('91', `−${aiDeleted}`)}` : '';
        const humAdds = paint('94', `+${humanAdded}`);
        const humDels = humanDeleted > 0 ? ` ${paint('91', `−${humanDeleted}`)}` : '';

        const aiShare = paint('92', `${aiPct}%`);
        const humanShare = paint('94', `${humanPct}%`);

        console.log(
            `[blamely] ${aiLabel}  ${aiAdds}${aiDels}  (${aiShare})  ${bar}  (${humanShare})  ${humAdds}${humDels}  ${humanLabel}`
        );

        const sha = run('git rev-parse --short=8 HEAD') || '00000000';
        const commitMsgPath = process.argv[2];
        if (commitMsgPath && fs.existsSync(commitMsgPath)) {
            const existingMsg = fs.readFileSync(commitMsgPath, 'utf-8');
            const suffix = `\n\n[blamely: ${sha} — AI +${aiAdded}/−${aiDeleted} (${aiPct}%), Human +${humanAdded}/−${humanDeleted} (${humanPct}%)]`;
            fs.writeFileSync(commitMsgPath, existingMsg.trimEnd() + suffix + '\n');
        }
    } catch (err) {
        console.error('[blamely] Error reading detector:', err.message);
        process.exit(0);
    }
}

main();

/**
 * hookRunner.js — Executed by the Git pre-commit hook.
 *
 * **Canonical source:** `intellij-plugin/src/main/resources/blamely/hookRunner.js`.
 * **VS Code** copies this file in `npm run compile` via `scripts/sync-hook-runner.cjs`
 * so both extensions ship the same script.
 *
 * **Data source:** aggregates `~/.blamely/repos/<repoBucket>/snapshots/<sanitized-branch>/*.blame.json`
 * (same layout as `hookRunner.js` sidecar: `__dirname` is the repo bucket). Legacy `blamely-detector.ai`
 * is no longer written by the editors; blame snapshots are canonical.
 *
 * Output is **AI vs Human share only**: two percentages and a single bar (**green** = AI left,
 * **blue** = Human right).
 *
 * When blamely-cli’s managed **post-commit** block is present, skips printing this bar
 * (post-commit prints its own); still appends the short commit-message suffix when given a path.
 *
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

/**
 * Returns true when blamely-cli's managed post-commit block is present.
 * In that case hookRunner.js skips printing its own bar (the post-commit hook
 * will print a single combined bar), but still appends the commit-message suffix.
 */
function blamelyCliPostCommitInstalled(absGitDir) {
    try {
        const hookPath = path.join(absGitDir, 'hooks', 'post-commit');
        const content = fs.readFileSync(hookPath, 'utf-8');
        return content.includes('### blamely-cli hook (managed) begin ###');
    } catch {
        return false;
    }
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
 * Two-part bar: AI share on the **left** (green 92), Human share on the **right** (blue 94).
 */
function aiHumanShareBar(aiMass, humanMass, width = 40) {
    const total = aiMass + humanMass;
    if (total <= 0) {
        return paint('90', '░'.repeat(width));
    }
    const [aiW, humW] = allocateSegments([aiMass, humanMass], width);
    let out = '';
    if (aiW > 0) {
        out += paint('92', '█'.repeat(aiW));
    }
    if (humW > 0) {
        out += paint('94', '█'.repeat(humW));
    }
    return out.length > 0 ? out : paint('90', '░'.repeat(width));
}

/** Matches VS Code / IntelliJ `sanitizedBranchDirName`. */
function sanitizedBranchDirName(branch) {
    let b = String(branch ?? 'HEAD').trim();
    b = b
        .replace(/\//g, '-')
        .replace(/\\/g, '-')
        .replace(/:/g, '-')
        .replace(/\*/g, '-')
        .replace(/\?/g, '-')
        .replace(/"/g, '-')
        .replace(/</g, '-')
        .replace(/>/g, '-')
        .replace(/\|/g, '-');
    if (!b || b === '.' || b === '..') {
        return 'HEAD';
    }
    return b;
}

function isAiAuthor(row) {
    const raw = row.authorType ?? row.author_type ?? '';
    return String(raw).toUpperCase() === 'AI';
}

/**
 * @returns {{ aiAdded: number, aiDeleted: number, humanAdded: number, humanDeleted: number } | null}
 */
function totalsFromBlameSnapshots(repoBucketAbs, sanitizedBranch) {
    const snapDir = path.join(repoBucketAbs, 'snapshots', sanitizedBranch);
    if (!fs.existsSync(snapDir) || !fs.statSync(snapDir).isDirectory()) {
        return null;
    }
    let aiAdded = 0;
    let humanAdded = 0;
    let aiDeleted = 0;
    let humanDeleted = 0;
    const names = fs.readdirSync(snapDir);
    for (const name of names) {
        if (!name.endsWith('.blame.json')) {
            continue;
        }
        let rows;
        try {
            rows = JSON.parse(fs.readFileSync(path.join(snapDir, name), 'utf8'));
        } catch {
            continue;
        }
        if (!Array.isArray(rows)) {
            continue;
        }
        for (const row of rows) {
            const ch = row.changeType ?? row.change_type ?? 'ADD';
            const del = ch === 'DELETE' || ch === 'delete';
            const ai = isAiAuthor(row);
            if (del) {
                if (ai) {
                    aiDeleted++;
                } else {
                    humanDeleted++;
                }
            } else {
                if (ai) {
                    aiAdded++;
                } else {
                    humanAdded++;
                }
            }
        }
    }
    const sum = aiAdded + humanAdded + aiDeleted + humanDeleted;
    if (sum <= 0) {
        return null;
    }
    return { aiAdded, aiDeleted, humanAdded, humanDeleted: humanDeleted };
}

/** When hookRunner lives in ~/.blamely/repos/<bucket>/, that dir contains `snapshots/`. */
function repoBucketDirFromHookLocation() {
    const snap = path.join(__dirname, 'snapshots');
    if (fs.existsSync(snap) && fs.statSync(snap).isDirectory()) {
        return __dirname;
    }
    return null;
}

function main() {
    const absGitDir = gitDirAbsolute();
    if (!absGitDir) {
        console.log('[blamely] Git dir not resolved — skipping');
        process.exit(0);
    }

    const branch = run('git rev-parse --abbrev-ref HEAD') || 'HEAD';
    const safe = sanitizedBranchDirName(branch);
    const bucket = repoBucketDirFromHookLocation();

    let t = null;
    if (bucket) {
        t = totalsFromBlameSnapshots(bucket, safe);
    }

    if (!t) {
        console.log('[blamely] No blame snapshot totals — skipping (expected ~/.blamely/repos/<repo>/snapshots/<branch>/*.blame.json)');
        process.exit(0);
    }

    try {
        const aiMass = t.aiAdded + t.aiDeleted;
        const humanMass = t.humanAdded + t.humanDeleted;
        const all = aiMass + humanMass;

        const aiPct = all > 0 ? ((100 * aiMass) / all).toFixed(1) : '0.0';
        const humanPct = all > 0 ? ((100 * humanMass) / all).toFixed(1) : '0.0';

        const bar = aiHumanShareBar(aiMass, humanMass, 40);

        const aiLabel = paint('92', 'AI');
        const humanLabel = paint('94', 'Human');
        const aiShare = paint('92', `${aiPct}%`);
        const humanShare = paint('94', `${humanPct}%`);

        if (!blamelyCliPostCommitInstalled(absGitDir)) {
            console.log(`[blamely] ${aiLabel} ${aiShare}  ${bar}  ${humanShare} ${humanLabel}`);
        }

        const sha = run('git rev-parse --short=8 HEAD') || '00000000';
        const commitMsgPath = process.argv[2];
        if (commitMsgPath && fs.existsSync(commitMsgPath)) {
            const existingMsg = fs.readFileSync(commitMsgPath, 'utf-8');
            const suffix = `\n\n[blamely: ${sha} — AI ${aiPct}%, Human ${humanPct}%]`;
            fs.writeFileSync(commitMsgPath, existingMsg.trimEnd() + suffix + '\n');
        }
    } catch (err) {
        console.error('[blamely] Error aggregating blame snapshots:', err.message);
        process.exit(0);
    }
}

main();

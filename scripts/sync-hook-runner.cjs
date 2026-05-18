#!/usr/bin/env node
/**
 * Single source of truth: intellij-plugin/src/main/resources/blamely/hookRunner.js
 * Copies into vscode-plugin/src/hookRunner.js so both bundles stay byte-identical.
 */
const fs = require('fs');
const path = require('path');

const vscodeRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(vscodeRoot, '..');
const canonical = path.join(
    repoRoot,
    'intellij-plugin',
    'src',
    'main',
    'resources',
    'blamely',
    'hookRunner.js'
);
const dest = path.join(vscodeRoot, 'src', 'hookRunner.js');

if (!fs.existsSync(canonical)) {
    console.error('[blamely] sync-hook-runner: canonical file missing:', canonical);
    process.exit(1);
}
fs.copyFileSync(canonical, dest);
console.log('[blamely] sync-hook-runner:', path.relative(repoRoot, dest), '<=', path.relative(repoRoot, canonical));

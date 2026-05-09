#!/usr/bin/env node
/**
 * Obfuscates compiled JS under out/ for VSIX packaging.
 * Skips hookRunner.js (hook helper copied to user repos; keep readable).
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SKIP = new Set(['hookRunner.js']);

const obfuscatorOptions = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.35,
    deadCodeInjection: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 4,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayIndexesType: ['hexadecimal-number'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 1,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
};

function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            walk(full);
            continue;
        }
        if (!ent.name.endsWith('.js')) {
            continue;
        }
        if (SKIP.has(ent.name)) {
            continue;
        }

        const code = fs.readFileSync(full, 'utf8');
        const result = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions);
        fs.writeFileSync(full, result.getObfuscatedCode(), 'utf8');
    }
}

const outDir = path.join(__dirname, '..', 'out');
if (!fs.existsSync(outDir)) {
    console.error('obfuscate-out: out/ not found; run compile:release first');
    process.exit(1);
}
walk(outDir);
console.log('obfuscate-out: done');

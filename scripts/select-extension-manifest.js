const fs = require('node:fs');
const path = require('node:path');

const TARGETS = new Set(['chrome', 'firefox']);
const target = process.argv[2];

if (!TARGETS.has(target)) {
    console.error('Usage: node scripts/select-extension-manifest.js <chrome|firefox>');
    process.exit(1);
}

const extensionDir = path.resolve(__dirname, '..', 'extension', 'magic-file-code-injector');
const sourceFile = path.join(extensionDir, `manifest.${target}.json`);
const destinationFile = path.join(extensionDir, 'manifest.json');

fs.copyFileSync(sourceFile, destinationFile);
console.log(`[mfci] Selected ${target} extension manifest.`);

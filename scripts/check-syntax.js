const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHECK_ROOTS = [
    'src',
    'bin',
    'scripts',
    'extension/magic-file-code-injector/js',
];
const CHECK_EXTENSIONS = new Set(['.js', '.cjs']);

/**
 * Recursively collect syntax-checkable files from one directory.
 * @param {string} directoryPath - Root directory to scan.
 * @param {string[]} files - Mutable file list.
 * @returns {string[]} Collected files.
 */
function collectCheckFiles(directoryPath, files = []) {
    if (!fs.existsSync(directoryPath)) {
        return files;
    }

    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            collectCheckFiles(entryPath, files);
            continue;
        }

        if (entry.isFile() && CHECK_EXTENSIONS.has(path.extname(entry.name))) {
            files.push(entryPath);
        }
    }

    return files;
}

const files = CHECK_ROOTS.flatMap((root) => collectCheckFiles(root)).sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
    console.log('No JavaScript files found for syntax check.');
    process.exit(0);
}

console.log(`Checking syntax for ${files.length} file(s).`);

for (const filePath of files) {
    const result = spawnSync(process.execPath, ['--check', filePath], { stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

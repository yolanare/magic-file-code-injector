const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const TARGETS = ['chrome', 'firefox'];
const EXTENSION_DIR = path.resolve(__dirname, '..', 'extension', 'magic-file-code-injector');
const DIST_DIR = path.resolve(__dirname, '..', 'extension', 'dist');
const PACKAGE_NAME = 'magic-file-code-injector';

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    CRC_TABLE[index] = value >>> 0;
}

/**
 * Compute CRC32 for one ZIP entry payload.
 * @param {Buffer} buffer - Entry payload.
 * @returns {number} Unsigned CRC32.
 */
function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Convert a date to DOS timestamp fields used by ZIP headers.
 * @param {Date} date - File modification date.
 * @returns {{time:number,date:number}} DOS time/date fields.
 */
function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/**
 * Return whether a source file should be copied into packaged extension archives.
 * @param {string} relativePath - Extension-relative POSIX path.
 * @returns {boolean} True when the file belongs in extension packages.
 */
function shouldPackageFile(relativePath) {
    return (
        !relativePath.startsWith('dist/') &&
        !relativePath.startsWith('.') &&
        relativePath !== 'manifest.json' &&
        relativePath !== 'manifest.chrome.json' &&
        relativePath !== 'manifest.firefox.json'
    );
}

/**
 * Recursively collect extension files in deterministic ZIP order.
 * @param {string} directoryPath - Directory to walk.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function collectFiles(directoryPath) {
    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const absolutePath = path.resolve(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(absolutePath)));
            continue;
        }

        if (entry.isFile()) {
            files.push(absolutePath);
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Build one ZIP archive buffer from in-memory entries.
 * @param {Array<{name:string,content:Buffer,mtime:Date}>} entries - Archive entries.
 * @returns {Buffer} ZIP archive content.
 */
function createZipBuffer(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuffer = Buffer.from(entry.name, 'utf8');
        const compressed = zlib.deflateRawSync(entry.content, { level: 9 });
        const checksum = crc32(entry.content);
        const { time, date } = toDosDateTime(entry.mtime);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(8, 8);
        localHeader.writeUInt16LE(time, 10);
        localHeader.writeUInt16LE(date, 12);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(compressed.length, 18);
        localHeader.writeUInt32LE(entry.content.length, 22);
        localHeader.writeUInt16LE(nameBuffer.length, 26);
        localHeader.writeUInt16LE(0, 28);

        localParts.push(localHeader, nameBuffer, compressed);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(0x0314, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(8, 10);
        centralHeader.writeUInt16LE(time, 12);
        centralHeader.writeUInt16LE(date, 14);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(compressed.length, 20);
        centralHeader.writeUInt32LE(entry.content.length, 24);
        centralHeader.writeUInt16LE(nameBuffer.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        centralHeader.writeUInt32LE(offset, 42);
        centralParts.push(centralHeader, nameBuffer);

        offset += localHeader.length + nameBuffer.length + compressed.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(entries.length, 8);
    endRecord.writeUInt16LE(entries.length, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(offset, 16);
    endRecord.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

/**
 * Build one browser-specific extension package.
 * @param {"chrome"|"firefox"} target - Browser target.
 * @param {string[]} sourceFiles - Absolute packageable source files.
 * @returns {Promise<string>} Written ZIP path.
 */
async function buildPackage(target, sourceFiles) {
    const targetDir = path.resolve(DIST_DIR, target);
    const manifestPath = path.resolve(EXTENSION_DIR, `manifest.${target}.json`);
    const zipPath = path.resolve(targetDir, `${PACKAGE_NAME}-${target}.zip`);
    const manifestStat = await fsPromises.stat(manifestPath);

    const entries = [
        {
            name: 'manifest.json',
            content: await fsPromises.readFile(manifestPath),
            mtime: manifestStat.mtime,
        },
    ];

    for (const filePath of sourceFiles) {
        const relativePath = path.relative(EXTENSION_DIR, filePath).split(path.sep).join('/');
        if (!shouldPackageFile(relativePath)) {
            continue;
        }

        const stat = await fsPromises.stat(filePath);
        entries.push({
            name: relativePath,
            content: await fsPromises.readFile(filePath),
            mtime: stat.mtime,
        });
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    await fsPromises.rm(targetDir, { recursive: true, force: true });
    await fsPromises.mkdir(targetDir, { recursive: true });
    await fsPromises.writeFile(zipPath, createZipBuffer(entries));
    return zipPath;
}

/**
 * Build all browser extension packages and restore the Chrome manifest for unpacked installs.
 * @returns {Promise<void>} Completes after all ZIP archives are written.
 */
async function main() {
    const sourceFiles = await collectFiles(EXTENSION_DIR);

    try {
        for (const target of TARGETS) {
            const zipPath = await buildPackage(target, sourceFiles);
            console.log(`[mfci] Built ${target} extension package: ${path.relative(process.cwd(), zipPath)}`);
        }
    } finally {
        await fsPromises.copyFile(path.resolve(EXTENSION_DIR, 'manifest.chrome.json'), path.resolve(EXTENSION_DIR, 'manifest.json'));
        console.log('[mfci] Selected chrome extension manifest.');
    }
}

main().catch((error) => {
    console.error(`[mfci] Extension package build failed: ${error.message}`);
    process.exit(1);
});

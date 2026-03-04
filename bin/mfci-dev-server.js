#!/usr/bin/env node

const { runCli } = require('../src/cli');

try {
    runCli(process.argv.slice(2), { cwd: process.cwd() });
} catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error(`[mfci] ${message}`);
    process.exit(1);
}

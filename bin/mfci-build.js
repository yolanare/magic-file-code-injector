#!/usr/bin/env node

const { runBuildCli } = require('../src/build-cli');

runBuildCli(process.argv.slice(2), { cwd: process.cwd() }).catch((error) => {
    const message = String(error?.message || error);
    console.error(`[mfci-build] ${message}`);
    process.exit(1);
});

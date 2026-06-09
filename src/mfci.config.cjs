/**
 * Default MFCI configuration template used as the baseline for both `mfci-dev-server` and `mfci-build`.
 */
module.exports = {
    host: '127.0.0.1',
    port: 35888,
    rootDir: 'dev-mfci',
    build: {
        clean: false,
        copy: [],
        ignoreDotFiles: true,
        exportHtml: {
            enabled: true,
            mergeSameName: true,
        },
        languages: {
            html: {
                enabled: true,
                extensions: ['.html'],
            },
            sass: {
                enabled: true,
                extensions: ['.scss', '.sass', '.css'],
                settings: {
                    style: 'expanded',
                    sourceMap: false,
                    loadPaths: [],
                },
            },
            js: {
                enabled: true,
                extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
                settings: {
                    bundle: false,
                    minify: false,
                    sourcemap: false,
                    target: 'es2020',
                    format: 'esm',
                    platform: 'browser',
                },
            },
        },
    },
};

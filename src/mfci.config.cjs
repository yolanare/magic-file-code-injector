/**
 * Default MFCI configuration template used as the baseline for both `mfci-dev-server` and `mfci-build`.
 */
module.exports = {
    host: '127.0.0.1',
    port: 35888,
    files: [
        {
            type: 'html',
            rootDir: 'html',
            publicDir: 'html/public',
            extensions: ['.html'],
        },
        {
            type: 'css',
            rootDir: 'css',
            publicDir: 'css/public',
            extensions: ['.css'],
        },
        {
            type: 'js',
            rootDir: 'js',
            publicDir: 'js/public',
            extensions: ['.js', '.mjs'],
        },
    ],
    build: {
        clean: false,
        exportHtml: {
            html: false,
            css: false,
            js: false,
            srcDir: 'public',
            outDir: 'html',
            mergeSameName: true,
            mergeSameNameDir: 'html-merge',
            mergeSameNameIgnorePath: true,
        },
        html: {
            enabled: true,
            srcDir: 'html/dev',
            outDir: 'html/public/build',
            extensions: ['.html'],
        },
        sass: {
            enabled: true,
            srcDir: 'css/dev',
            outDir: 'css/public/build',
            extensions: ['.scss', '.sass', '.css'],
            style: 'expanded',
            sourceMap: false,
            loadPaths: [],
        },
        js: {
            enabled: true,
            srcDir: 'js/dev',
            outDir: 'js/public/build',
            extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
            bundle: false,
            minify: false,
            sourcemap: false,
            target: 'es2020',
            format: 'esm',
            platform: 'browser',
        },
        copy: [],
    },
};

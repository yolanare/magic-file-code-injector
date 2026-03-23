/**
 * Default MFCI configuration template used as the baseline for both `mfci-dev-server` and `mfci-build`.
 */
module.exports = {
    host: '127.0.0.1',
    port: 35888,
    files: [
        {
            type: 'css',
            dir: 'css/public',
            urlPrefix: '/css',
            extensions: ['.css'],
        },
        {
            type: 'js',
            dir: 'js/public',
            urlPrefix: '/js',
            extensions: ['.js', '.mjs'],
        },
    ],
    watch: ['css', 'js'],
    build: {
        clean: false,
        exportHtml: {
            css: false,
            js: false,
            dirName: 'html',
        },
        sass: {
            enabled: true,
            srcDir: 'css/dev',
            outDir: 'css/public',
            extensions: ['.scss', '.sass', '.css'],
            style: 'expanded',
            sourceMap: false,
            loadPaths: [],
        },
        js: {
            enabled: true,
            srcDir: 'js/dev',
            outDir: 'js/public',
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

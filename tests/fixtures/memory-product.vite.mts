import { defineConfig, mergeConfig, type Plugin } from 'vite';
import path from 'node:path';
import config from '../../vite.config.mts';
import { productQualificationPlugin } from './memory-product-instrument';
import { build as bundle } from 'esbuild';
import { productExportWorker } from './memory-product-export-build';
import { createPrivateViewerQualification } from './memory-product-viewer-transform';

export default defineConfig((env) => {
    const out = process.env.HUB_PRODUCT_BUILD_OUT;
    if (!out || !path.isAbsolute(out))
        throw Error('Private product build needs an absolute isolated output.');
    const inherited = typeof config === 'function' ? config(env) : config;
    const viewer = createPrivateViewerQualification({
        sourceRoot: path.resolve(import.meta.dirname, '../..'),
        purpose: 'private-product-qualification',
    });
    return mergeConfig(inherited, {
        define: {
            __MEMORY_PRODUCT_COLD_START__: JSON.stringify(
                process.env.HUB_PRODUCT_AGGREGATE_COLD_START === '1',
            ),
        },
        plugins: [
            viewer.renderer,
            productQualificationPlugin(),
            {
                name: 'private-actual-product-entry',
                transformIndexHtml: {
                    order: 'pre',
                    handler(html: string) {
                        const needle = 'src="/src/main.tsx"';
                        if (html.split(needle).length !== 2)
                            throw Error('Actual product HTML entry changed.');
                        return html
                            .replace(needle, 'src="/tests/fixtures/memory-product-app.tsx"')
                            .replace(
                                '</head>',
                                '<script src="/memory-product-ledger.js"></script></head>',
                            );
                    },
                },
                async generateBundle(_options, output) {
                    const ledger = await bundle({
                        entryPoints: [
                            path.resolve(import.meta.dirname, 'memory-product-ledger-entry.ts'),
                        ],
                        bundle: true,
                        platform: 'browser',
                        format: 'iife',
                        write: false,
                        target: 'es2022',
                    });
                    this.emitFile({
                        type: 'asset',
                        fileName: 'memory-product-ledger.js',
                        source: ledger.outputFiles[0].contents,
                    });
                    if (env.mode === 'web') {
                        const worker = output['capture-download-sw.js'];
                        if (!worker || worker.type !== 'asset')
                            throw Error(
                                'Shipping export worker asset missing before private instrumentation.',
                            );
                        worker.source = await productExportWorker(
                            path.resolve(import.meta.dirname, '../..'),
                        );
                    }
                    viewer.assertComplete();
                    this.emitFile({
                        type: 'asset',
                        fileName: 'memory-product-viewer-transform.json',
                        source: JSON.stringify(viewer.snapshot(), null, 2),
                    });
                },
            } satisfies Plugin,
        ],
        worker: {
            ...inherited.worker,
            plugins: () => [...viewer.workerPlugins(), ...(inherited.worker?.plugins?.() ?? [])],
        },
        base: '/',
        build: {
            outDir: out,
            emptyOutDir: false,
            rollupOptions: { input: path.resolve(import.meta.dirname, '../../index.html') },
        },
    });
});

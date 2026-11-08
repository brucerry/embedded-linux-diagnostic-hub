import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { build as bundle } from 'esbuild';
import { fileURLToPath } from 'node:url';

const captureEntries = {
    'capture-download-sw.js': './src/features/automation/capture/capture-download-worker.ts',
    'capture-download-frame.js': './src/features/automation/capture/capture-download-frame.ts',
};
async function captureScript(entry: string) {
    const result = await bundle({
        entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        write: false,
    });
    return result.outputFiles[0].contents;
}

export function webBase(repository?: string, override?: string) {
    if (override) return override.endsWith('/') ? override : `${override}/`;
    const name = repository?.split('/')[1];
    return !name || name.endsWith('.github.io') ? '/' : `/${name}/`;
}

export default defineConfig(({ mode }) => ({
    plugins: [
        react(),
        {
            name: 'capture-export-workers',
            async generateBundle() {
                if (mode !== 'web') return;
                for (const [fileName, entry] of Object.entries(captureEntries))
                    this.emitFile({ type: 'asset', fileName, source: await captureScript(entry) });
            },
            configureServer(server) {
                server.middlewares.use(async (req, res, next) => {
                    const name = req.url?.split('?')[0].split('/').at(-1),
                        entry = captureEntries[name as keyof typeof captureEntries];
                    if (!entry) return next();
                    try {
                        res.setHeader('Content-Type', 'application/javascript');
                        res.setHeader('Cache-Control', 'no-store');
                        res.end(await captureScript(entry));
                    } catch (error) {
                        next(error as Error);
                    }
                });
            },
        },
        {
            name: 'development-csp',
            transformIndexHtml(html, context) {
                // Vite's React refresh preamble is inline, and is present only during development.
                if (context.server)
                    return html
                        .replace("frame-src 'none'", "frame-src 'self'")
                        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
                        .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
                        .replace("connect-src 'none'", "connect-src 'self' ws://127.0.0.1:5173")
                        .replace(
                            "connect-src 'self'",
                            "connect-src 'self' https: http://127.0.0.1:*",
                        );
                return mode === 'web'
                    ? html
                          .replace("connect-src 'self'", "connect-src 'self' https:")
                          .replace("frame-src 'none'", "frame-src 'self'")
                    : html;
            },
        },
    ],
    base: mode === 'web' ? webBase(process.env.GITHUB_REPOSITORY, process.env.WEB_BASE_PATH) : './',
    experimental: {
        // Resolve workers beside the importing bundle on app://, Pages and nested web hosts.
        // The shared renderer assets stay identical regardless of the HTML deployment base.
        renderBuiltUrl(_filename, { hostType }) {
            if (hostType === 'js') return { relative: true };
        },
    },
    build: { outDir: mode === 'web' ? 'dist-web' : 'dist' },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));

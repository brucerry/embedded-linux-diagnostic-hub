import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export function webBase(repository?: string, override?: string) {
    if (override) return override.endsWith('/') ? override : `${override}/`;
    const name = repository?.split('/')[1];
    return !name || name.endsWith('.github.io') ? '/' : `/${name}/`;
}

export default defineConfig(({ mode }) => ({
    plugins: [
        react(),
        {
            name: 'development-csp',
            transformIndexHtml(html, context) {
                // Vite's React refresh preamble is inline, and is present only during development.
                if (context.server)
                    return html
                        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
                        .replace(
                            "connect-src 'self'",
                            "connect-src 'self' https: http://127.0.0.1:*",
                        );
                return mode === 'web'
                    ? html.replace("connect-src 'self'", "connect-src 'self' https:")
                    : html;
            },
        },
    ],
    base: mode === 'web' ? webBase(process.env.GITHUB_REPOSITORY, process.env.WEB_BASE_PATH) : './',
    build: { outDir: mode === 'web' ? 'dist-web' : 'dist' },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));

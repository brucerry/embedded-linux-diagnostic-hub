/**
 * Build a standalone browser script without loading the outer Vite config again.
 * @param {typeof import('vite').build} build
 * @param {string} entry
 */
export async function bundleCaptureWorker(build, entry) {
    const result = await build({
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: 'silent',
        build: {
            lib: { entry, name: 'DiagnosticHubCapture', formats: ['iife'] },
            target: 'es2022',
            minify: false,
            write: false,
            sourcemap: false,
            rolldownOptions: { output: { inlineDynamicImports: true } },
        },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const [output] = outputs;
    if (outputs.length !== 1 || !output || !('output' in output) || output.output.length !== 1) {
        throw new Error('Capture build must emit exactly one standalone JavaScript chunk');
    }
    const [chunk] = output.output;
    if (chunk.type !== 'chunk' || !chunk.isEntry || !chunk.code ||
        chunk.imports.length || chunk.dynamicImports.length) {
        throw new Error('Capture build emitted a non-standalone script');
    }
    return Buffer.from(chunk.code, 'utf8');
}

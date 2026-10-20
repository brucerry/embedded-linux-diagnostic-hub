// Start the one owner clock before dynamic module loading or prerequisite effects.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { requirePreinstalledQueryRuntime } from './lib/security-query-job-admission.mjs';
import { ownerStdioCapture } from './lib/security-query-owner-stdio.mjs';
export const entryStartedAt = Number(process.hrtime.bigint() / 1000000n);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] !== '--leaf') {
        try {
            requirePreinstalledQueryRuntime();
        } catch (error) {
            console.error(
                JSON.stringify({
                    kind: 'query-runtime-not-admitted',
                    error: String(error).slice(0, 1024),
                }),
            );
            process.exitCode = 1;
        }
        if (!process.exitCode) ownerStdioCapture().install();
    }
    if (!process.exitCode)
        void import('./lib/security-query-diagnostic-runtime.mjs')
            .then(({ queryOwner, queryLeaf }) =>
                process.argv[2] === '--leaf'
                    ? queryLeaf(process.argv.slice(3))
                    : queryOwner({ startedAt: entryStartedAt }),
            )
            .catch((error) => {
                console.error(
                    JSON.stringify({
                        kind: 'query-only-entry-failure',
                        error: String(error).slice(0, 1024),
                    }),
                );
                process.exitCode = 1;
            });
}

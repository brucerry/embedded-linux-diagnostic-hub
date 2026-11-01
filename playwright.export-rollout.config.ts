import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { existsSync } from 'node:fs';

// This config creates no resources. A later exact command/owned-close review is mandatory.
if (process.env.HUB_EXPORT_ROLLOUT_EXECUTE !== 'reviewed-new-runtime-only')
    throw Error('Export rollout execution is not opted in; existing browser holds remain.');
for (const name of ['HUB_ROLLOUT_RETAINED_ROOT', 'HUB_ROLLOUT_RUNTIME_ROOT', 'TMPDIR', 'HUB_ROLLOUT_OWNER_RECEIPT', 'HUB_ROLLOUT_ASSETS']) {
    if (!process.env[name] || !path.isAbsolute(process.env[name]!)) throw Error('Missing absolute ' + name);
}
const runtime = process.env.HUB_ROLLOUT_RUNTIME_ROOT!, retained = process.env.HUB_ROLLOUT_RETAINED_ROOT!;
if (runtime === retained || retained.startsWith(runtime + path.sep) || runtime.startsWith(retained + path.sep))
    throw Error('Evidence and runtime scopes must be disjoint.');
if (!process.env.TMPDIR!.startsWith(runtime + path.sep)) throw Error('Playwright temporary files must be owned and disposable.');
if (!process.env.HUB_ROLLOUT_CDP_ENDPOINT) throw Error('Separately admitted browser owner/endpoint required; this driver never launches one.');
for (const name of ['HUB_ROLLOUT_OWNER_RECEIPT_SHA256', 'HUB_ROLLOUT_ASSETS_SHA256'])
    if (!/^[a-f0-9]{64}$/.test(process.env[name] ?? '')) throw Error('Exact reviewed metadata hash required: ' + name);
const outputDir = path.join(retained, 'playwright-output');
if (existsSync(outputDir)) throw Error('Refusing an existing Playwright output directory; prior evidence must be preserved.');
export default defineConfig({
    // The stock runner otherwise enables Git commit/diff subprocesses in CI.
    captureGitInfo: { commit: false, diff: false },
    testDir: './tests/ui', testMatch: 'capture-export-rollout.spec.ts',
    workers: 1, retries: 0, fullyParallel: false,
    timeout: 30000, expect: { timeout: 10000 },
    outputDir,
    preserveOutput: 'always', reporter: 'list',
    projects: [{ name: 'private-export-rollout' }],
    // No webServer, default browser fixture, package scripts or reused application origin.
});

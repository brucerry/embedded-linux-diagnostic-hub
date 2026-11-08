import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { median, argumentsOf } from './memory-resource-core';
import { calibrationProfile, validateCalibrationMeasurement } from './memory-resource-policy';
import { requireObservedClosure } from '../../scripts/lib/owned-child.mjs';
import { resourceJob, observeResourceOwner } from '../../scripts/lib/resource-owner.mjs';

async function main() {
    const args = argumentsOf(process.argv.slice(2));
    const out = args.get('out');
    const { profile } = calibrationProfile(args.get('profile'));
    assert.ok(out, 'Provide --out=<private evidence directory>.');
    await fs.mkdir(out, { recursive: true });
    const runRoot = await fs.mkdtemp(path.join(path.resolve(out), 'calibration-'));
    const hashes: string[] = [],
        unsampledReceiptSHA256s: string[] = [],
        maxima = { heapUsed: [] as number[], arrayBuffers: [] as number[] };
    const observer: { sampled: number[]; unsampled: number[] } = { sampled: [], unsampled: [] };
    let identity = '';
    // Ten clean matched pairs quantify observer overhead. Never start concurrent measurements.
    for (let i = 0; i < 10; i++)
        for (const noSampler of [false, true]) {
            const run = path.join(runRoot, `${i}-${noSampler ? 'no-sampler' : 'sampled'}`);
            await fs.mkdir(run);
            const started = performance.now();
            const job = resourceJob(profile);
            const lifecycle = await (async () => {
                const child = spawn(
                    process.execPath,
                    [
                        ...process.execArgv,
                        fileURLToPath(new URL('./memory-resource-regression.ts', import.meta.url)),
                        '--profile=' + profile,
                        '--diagnostic=1',
                        `--out=${run}`,
                        ...(noSampler ? ['--no-sampler=1'] : []),
                    ],
                    {
                        windowsHide: true,
                        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                        env: { ...process.env, HUB_MEMORY_JOB: JSON.stringify(job) },
                    },
                );
                return observeResourceOwner(child, job).outcome;
            })();
            requireObservedClosure(lifecycle);
            assert.equal(
                lifecycle.code,
                0,
                `Preserved first failing calibration run ${run}; no automatic retries/budget changes.`,
            );
            observer[noSampler ? 'unsampled' : 'sampled'].push(performance.now() - started);
            const [folder] = await fs.readdir(run),
                receiptPath = path.join(run, folder, 'measurement.json');
            const bytes = await fs.readFile(receiptPath),
                receipt = JSON.parse(bytes.toString());
            const parent = JSON.parse(
                await fs.readFile(path.join(run, folder, 'receipt.json'), 'utf8'),
            );
            validateCalibrationMeasurement(receipt, parent, profile, !noSampler);
            const key = JSON.stringify({
                node: receipt.config.node,
                platform: receipt.config.platform,
                arch: receipt.config.arch,
                sourceSHA256: receipt.config.sourceSHA256,
                profile: receipt.config.profile,
                payloadBytes: receipt.config.payloadBytes,
                gcMode: receipt.config.gcMode,
                runtimeIdentity: receipt.config.runtimeIdentity,
                // Only this declared matched-control axis differs; validator checked each run's actual observer.
                contract: { ...receipt.config.contract, observer: 'sampled' },
            });
            if (identity)
                assert.equal(key, identity, 'Mixed source/runtime calibration is invalid.');
            else identity = key;
            if (noSampler)
                unsampledReceiptSHA256s.push(createHash('sha256').update(bytes).digest('hex'));
            if (!noSampler) {
                hashes.push(createHash('sha256').update(bytes).digest('hex'));
                for (const metric of ['heapUsed', 'arrayBuffers'] as const)
                    maxima[metric].push(receipt.summary[metric].maxDelta);
            }
        }
    const config = JSON.parse(identity);
    await fs.writeFile(
        path.join(runRoot, 'policy-review.json'),
        JSON.stringify(
            {
                reviewed: false,
                status: 'unreviewed-component-calibration-collection',
                runtime: `${config.platform}/${config.arch}/${config.node}`,
                sourceSHA256: config.sourceSHA256,
                profile: config.profile,
                runtimeIdentity: config.runtimeIdentity,
                contract: config.contract,
                observerMode: 'sampled',
                gcMode: config.gcMode,
                payloadBytes: config.payloadBytes,
                cleanRuns: hashes,
                unsampledReceiptSHA256s,
                observations: maxima,
                observerMilliseconds: {
                    ...observer,
                    sampledMedian: median(observer.sampled),
                    unsampledMedian: median(observer.unsampled),
                },
                ceilings: null,
                instruction:
                    'Review all ten receipts, noise/ranges, slopes, sampler overhead and negative controls. Supply justified byte ceilings explicitly; do not automatically promote maxima or raise budgets. This draft cannot enforce a gate.',
            },
            null,
            2,
        ),
        { flag: 'wx' },
    );
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

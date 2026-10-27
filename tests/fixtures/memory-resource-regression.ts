import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createHook } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { NativeCaptureStore } from '../../electron/capture-store';
import { nativeCycle, turn } from './memory-resource-cycle';
import { Owners, provisional, retained, type Memory } from './memory-resource-core';
import { sourceFingerprint, nodeRuntimeIdentity } from './memory-resource-identity';
import { childTermination, QualificationBlocked } from './memory-resource-verdict';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import { parseFastPolicy } from './memory-resource-policy';
import { fastIdentity, fastProtocol } from './memory-fast-identity';
import { validateFastCollection } from './memory-fast-receipt';
import { resourceJob, resourceOwner } from '../../scripts/lib/resource-owner.mjs';
import { readEvidence, syncCloseEvidence, writeDurableEvidence } from './memory-resource-evidence';

const options = new Map(
    process.argv.slice(2).map((arg) => {
        const [key, ...value] = arg.replace(/^--/, '').split('=');
        return [key, value.join('=')];
    }),
);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const control = options.get('negative') ?? 'none';
assert.ok(
    ['none', 'js', 'buffer', 'listener', 'timer', 'pin'].includes(control),
    'Unknown negative control.',
);
const profileName = options.get('profile') ?? 'fast';
assert.ok(['fast', 'scale'].includes(profileName));
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function configForRun() {
    const observerMode = options.has('no-sampler') ? 'disabled' : 'sampled';
    return {
        warmup: fastProtocol.warmup,
        measured: fastProtocol.measured,
        payloadBytes: profileName === 'fast' ? 1024 ** 2 : 64 * 1024 ** 2,
        profile: profileName,
        control,
        sourceSHA256: await sourceFingerprint(root),
        node: process.version,
        versions: process.versions,
        platform: process.platform,
        arch: process.arch,
        runtimeIdentity: await nodeRuntimeIdentity(),
        observerMode,
        gcMode: 'forced-diagnostic',
        gc: 'forced diagnostic plus unforced checkpoints',
        contract: await fastIdentity(root, observerMode, await sshQualificationProfile()),
    };
}

async function child() {
    assert.ok(global.gc, 'Use node --expose-gc --import tsx.');
    const output = process.env.HUB_MEMORY_OUTPUT!;
    const timeline = await fs.open(path.join(output, 'timeline.jsonl'), 'wx');
    const emit = async (stage: string, data?: unknown) => {
        await timeline.write(JSON.stringify({ time: Date.now(), stage, data }) + '\n');
    };
    const memory = async (stage: string, cycle = -1) => {
        await turn();
        await turn();
        const unforced = process.memoryUsage();
        await emit(stage, {
            cycle,
            gc: 'unforced',
            ...unforced,
            resources: process.getActiveResourcesInfo(),
        });
        global.gc!();
        await turn();
        await emit(stage, { cycle, gc: 'forced-first', ...process.memoryUsage() });
        global.gc!();
        await turn();
        const forced = process.memoryUsage();
        await emit(stage, { cycle, gc: 'forced-second', ...forced });
        return forced;
    };
    const temp = await fs.mkdtemp(path.join(output, 'profile-'));
    const leaked: unknown[] = [];
    const owners = new Owners();
    const timers = new Map<number, string>();
    const hook = createHook({
        init(id, type) {
            if (type === 'Timeout') {
                if (timers.size >= 256) throw Error('Timer diagnostic bound exceeded.');
                timers.set(id, new Error().stack?.slice(0, 800) ?? '');
            }
        },
        destroy(id) {
            timers.delete(id);
        },
    });
    let failure: unknown;
    let policySHA256: string | null = null,
        contractSHA256: string | null = null;
    try {
        const config = await configForRun();
        contractSHA256 = digest(JSON.stringify(config.contract));
        const policyPath = options.get('policy');
        let ceilings = provisional;
        if (!policyPath && !options.has('diagnostic'))
            throw new QualificationBlocked(
                'Reviewed policy required; use --diagnostic=1 only for unqualified diagnostics/calibration.',
            );
        if (policyPath) {
            const checked = parseFastPolicy(
                await fs.readFile(policyPath, 'utf8'),
                options.get('policy-sha256') ?? process.env.HUB_MEMORY_POLICY_SHA256 ?? '',
                config,
            );
            policySHA256 = checked.policySHA256;
            ceilings = checked.ceilings;
        }
        await emit('identity', {
            ...config,
            configSHA256: digest(JSON.stringify(config)),
            provisionalPolicySHA256: digest(JSON.stringify(provisional)),
        });
        await memory('startup');
        hook.enable();
        const cycleSample =
            (phase: string, cycle: number) => async (stage: string, data?: unknown) => {
                await emit(stage, {
                    phase,
                    cycle,
                    detail: data,
                    gc: 'unforced',
                    ...process.memoryUsage(),
                });
                if (['before-store-close', 'after-store-close', 'after-teardown'].includes(stage))
                    await memory(`${phase}-${stage}`, cycle);
            };
        for (let i = 0; i < config.warmup; i++)
            await nativeCycle(temp, config.payloadBytes, cycleSample('warmup', i));
        await turn();
        await turn();
        assert.equal(timers.size, 0, `Warmup timer owners: ${JSON.stringify([...timers])}`);
        const baseline = await memory('warmed-baseline');
        const samples: Memory[] = [];
        for (let i = 0; i < config.measured; i++) {
            await nativeCycle(temp, config.payloadBytes, cycleSample('measured', i));
            if (control === 'js') leaked.push(new Array(131072).fill(i + 0.5));
            if (control === 'buffer') leaked.push(Buffer.alloc(512 * 1024, i));
            if (control === 'listener') {
                const emitter = new EventEmitter();
                emitter.on('data', () => {});
                leaked.push(emitter);
                owners.take('listener', `intentionally omitted unsubscribe cycle ${i}`);
            }
            if (control === 'pin') {
                const negativeProfile = path.join(temp, `negative-${i}`);
                await fs.mkdir(negativeProfile);
                const store = await NativeCaptureStore.open(negativeProfile, {
                    profileOwned: true,
                });
                leaked.push(store, await store.pin());
                owners.take('pin', `intentionally omitted release cycle ${i}`);
            }
            if (control === 'timer') {
                const timer = setInterval(() => {}, 60000);
                timer.unref();
                leaked.push(timer);
            }
            await turn();
            await turn();
            owners.empty(`cycle ${i}`);
            assert.equal(timers.size, 0, `Unreleased timer owners: ${JSON.stringify([...timers])}`);
            samples.push(await memory('closed-cycle', i));
        }
        hook.disable();
        const summary = retained(baseline, samples, ceilings);
        assert.equal(
            leaked.length,
            0,
            'Negative control allocation survived but evaded the selected budget.',
        );
        await writeDurableEvidence(
            path.join(output, 'measurement.json'),
            JSON.stringify(
                {
                    config,
                    baseline,
                    samples,
                    summary,
                    policySHA256,
                    status: policyPath ? 'passed-reviewed-policy' : 'passed-provisional-diagnostic',
                    ceilings,
                    limitations: [
                        'external and RSS diagnostic only',
                        'arrayBuffers overlaps external',
                        'native Serial and synthetic loopback SSH components; no whole-product/UI claim',
                        'smaller leaks may escape detection',
                    ],
                },
                null,
                2,
            ),
        );
    } catch (error) {
        failure = error;
        await emit('failure', { message: String(error) });
    } finally {
        hook.disable();
        // Negative controls deliberately stay reachable until natural process exit.
        try {
            await emit('finished', {
                failure: failure ? String(failure) : null,
                retainedControls: leaked.length,
                policySHA256,
                contractSHA256,
            });
        } finally {
            const errors = await syncCloseEvidence([timeline]);
            if (errors.length) throw errors[0];
        }
        await writeDurableEvidence(
            path.join(output, 'child-evidence.json'),
            JSON.stringify({
                timelineClosed: true,
                timelineSynced: true,
                policySHA256,
                contractSHA256,
            }),
        );
    }
    if (failure) throw failure;
}

/** OS sampler is external to the measured child, serialized, and never retains its timeline. */
async function rss(pid: number): Promise<number | null> {
    if (process.platform === 'linux') {
        try {
            const text = await fs.readFile(`/proc/${pid}/status`, 'utf8');
            const match = /^VmRSS:\s+(\d+) kB$/m.exec(text);
            return match ? Number(match[1]) * 1024 : null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }
    const executable = process.platform === 'win32' ? 'powershell.exe' : 'ps';
    const args =
        process.platform === 'win32'
            ? [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
              ]
            : ['-o', 'rss=', '-p', String(pid)];
    return new Promise((resolve, reject) =>
        execFile(executable, args, { windowsHide: true, timeout: 3000 }, (error, stdout) => {
            if (error && !stdout) {
                resolve(null);
                return;
            }
            const value = Number(stdout.trim());
            if (!Number.isFinite(value)) reject(Error('Invalid OS RSS sample.'));
            else resolve(stdout.trim() ? value * (process.platform === 'win32' ? 1 : 1024) : null);
        }),
    );
}
async function parent() {
    const job = resourceJob(profileName, process.env.HUB_MEMORY_JOB);
    const supervisor = resourceOwner(job);
    const collectorHandles: Awaited<ReturnType<typeof fs.open>>[] = [];
    let collectorClosureAttempted = false;
    try {
        const base = options.get('out') ?? path.join(root, 'validation/memory');
        await fs.mkdir(base, { recursive: true });
        const output = await fs.mkdtemp(path.join(path.resolve(base), `${control}-`));
        let expectedConfig: Awaited<ReturnType<typeof configForRun>>;
        let policySHA256: string | null = null;
        let ceilings = provisional;
        try {
            if (!options.has('policy') && !options.has('diagnostic'))
                throw new QualificationBlocked(
                    'Reviewed policy required for the fast gate. Explicit --diagnostic=1 never qualifies a release.',
                );
            const sshRuntime = await sshQualificationProfile();
            expectedConfig = await configForRun();
            if (options.has('policy')) {
                const checked = parseFastPolicy(
                    await fs.readFile(options.get('policy')!, 'utf8'),
                    options.get('policy-sha256') ?? process.env.HUB_MEMORY_POLICY_SHA256 ?? '',
                    expectedConfig,
                );
                policySHA256 = checked.policySHA256;
                ceilings = checked.ceilings;
            }
            await fs.writeFile(
                path.join(output, 'runtime.json'),
                JSON.stringify(
                    {
                        node: process.execPath,
                        version: process.version,
                        resourceJob: job,
                        ...sshRuntime,
                    },
                    null,
                    2,
                ),
                { flag: 'wx' },
            );
        } catch (error) {
            await fs.writeFile(
                path.join(output, 'receipt.json'),
                JSON.stringify(
                    {
                        status: error instanceof QualificationBlocked ? 'blocked' : 'failed',
                        stage: 'runtime-preflight',
                        firstFailure: String(error).slice(0, 4096),
                        childStarted: false,
                        resourceJob: job,
                        output,
                    },
                    null,
                    2,
                ),
                { flag: 'wx' },
            );
            throw error;
        }
        const peakFile = await fs.open(path.join(output, 'rss.jsonl'), 'wx');
        collectorHandles.push(peakFile);
        const log = await fs.open(path.join(output, 'child.log'), 'wx');
        collectorHandles.push(log);
        const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--out='));
        supervisor.assertAdmissible();
        const target = spawn(
            process.execPath,
            [...process.execArgv, fileURLToPath(import.meta.url), ...args, '--child=1'],
            {
                cwd: root,
                windowsHide: true,
                env: { ...process.env, HUB_MEMORY_OUTPUT: output },
                stdio: ['ignore', log.fd, log.fd],
            },
        );
        let exited = false,
            sampleFailure: unknown;
        const owned = supervisor.observe(target);
        target.once('exit', () => {
            exited = true;
        });
        target.once('error', () => {
            exited = true;
        });
        const sampling = (async () => {
            if (options.has('no-sampler')) return;
            if (!target.pid) throw Error('Measured fixture child did not start.');
            let attempts = 0;
            while (!exited) {
                assert.ok(++attempts <= 4096, 'RSS attempt bound exceeded.');
                const time = Date.now(),
                    startedMs = performance.now();
                const bytes = await rss(target.pid!);
                const completedMs = performance.now();
                await peakFile.write(
                    JSON.stringify({
                        time,
                        startedMs,
                        completedMs,
                        latencyMs: completedMs - startedMs,
                        pid: target.pid,
                        launched: target.spawnfile,
                        rssBytes: bytes,
                        unavailable: bytes === null,
                    }) + '\n',
                );
                if (!exited)
                    await new Promise((resolve) =>
                        setTimeout(resolve, Math.max(0, 250 - (Date.now() - time))),
                    );
            }
        })().catch((error) => {
            sampleFailure = error;
            exited = true;
            owned.abort(error);
        });
        const lifecycle = await owned.outcome;
        exited = true;
        await sampling;
        collectorClosureAttempted = true;
        const closeErrors = await syncCloseEvidence(collectorHandles);
        const evidenceClosed = closeErrors.length === 0;
        sampleFailure ??= closeErrors[0];
        let childLog = '';
        let verdict = 'INVALID_COLLECTION',
            rssEvidence: any = null,
            eligibilityError: unknown;
        try {
            const readBounded = async (file: string, maximumRows: number) => {
                const text = await readEvidence(path.join(output, file), 2 * 1024 ** 2);
                if (!text) return [];
                assert.ok(text.endsWith('\n'), 'Partial evidence row.');
                const rows = text
                    .trimEnd()
                    .split('\n')
                    .map((row) => JSON.parse(row));
                assert.ok(rows.length <= maximumRows);
                return rows;
            };
            assert.deepEqual(
                await configForRun(),
                expectedConfig!,
                'Source/profile/runtime postflight changed.',
            );
            if (options.has('policy'))
                assert.equal(digest(await fs.readFile(options.get('policy')!)), policySHA256);
            let measurement;
            childLog = await readEvidence(path.join(output, 'child.log'), 65536);
            if (lifecycle.code === 0)
                measurement = JSON.parse(
                    await readEvidence(path.join(output, 'measurement.json'), 65536),
                );
            supervisor.assertCollected();
            const checked = validateFastCollection({
                lifecycle,
                config: expectedConfig!,
                policySHA256,
                rows: await readBounded('timeline.jsonl', 345),
                rss: await readBounded('rss.jsonl', 4096),
                evidenceClosed,
                samplerFailure: sampleFailure ? String(sampleFailure) : null,
                measurement,
                ceilings,
                childEvidence: JSON.parse(
                    await readEvidence(path.join(output, 'child-evidence.json'), 4096),
                ),
                childLog,
            });
            verdict = checked.verdict;
            rssEvidence = checked.sampler;
        } catch (error) {
            eligibilityError = error;
        }
        const outcome = { code: lifecycle.code, signal: lifecycle.signal };
        const timedOut = lifecycle.timedOut;
        const receipt = {
            status:
                verdict === 'INVALID_COLLECTION'
                    ? 'invalid-collection'
                    : outcome.code !== 0
                      ? 'failed'
                      : options.has('policy')
                        ? 'passed-reviewed-policy'
                        : 'collected-provisional-diagnostic',
            ...outcome,
            timedOut,
            resourceJob: job,
            samplerFailure: sampleFailure ? String(sampleFailure) : null,
            observedPeakRSSBytes: rssEvidence?.peak ?? null,
            rssEvidence,
            lifecycle,
            evidenceClosed,
            verdict,
            policySHA256,
            contractSHA256: digest(JSON.stringify(expectedConfig!.contract)),
            eligibilityError: eligibilityError ? String(eligibilityError).slice(0, 4096) : null,
            observedPeakIsSamplingLowerBound: true,
            sampler: options.has('no-sampler')
                ? 'disabled-matched-observer-control'
                : 'external-250ms-target; OS-call latency recorded by timestamps',
            childExit: childTermination({ ...outcome, timedOut }),
            output,
            firstFailure: eligibilityError
                ? String(eligibilityError).slice(0, 4096)
                : outcome.code === 0
                  ? null
                  : childLog.slice(0, 4096),
            qualification: 'component diagnostic; final combined qualification remains separate',
        };
        await writeDurableEvidence(
            path.join(output, 'receipt.json'),
            JSON.stringify(receipt, null, 2),
        );
        console.log(JSON.stringify(receipt));
        if (
            !['passed-reviewed-policy', 'collected-provisional-diagnostic'].includes(receipt.status)
        )
            process.exitCode = 1;
    } catch (error) {
        supervisor.cancel(error);
        throw error;
    } finally {
        if (!collectorClosureAttempted) {
            const errors = await syncCloseEvidence(collectorHandles);
            if (errors.length) supervisor.cancel(errors[0]);
        }
        supervisor.finish();
    }
}
void (options.has('child') ? child() : parent()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

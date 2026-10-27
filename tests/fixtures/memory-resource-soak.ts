import { ProductShutdownObserver } from './memory-product-shutdown';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { productJob, ProductRunOwner, observeProductOwner } from './memory-product-owner';
import { syncCloseEvidence } from './memory-resource-evidence';
import { fileURLToPath } from 'node:url';
import {
    soakCoverage,
    viewerCoverage,
    ownerKinds,
    viewerOwnerKinds,
    argumentsOf,
    type QualificationDriver,
} from './memory-resource-core';
import { soakAssessmentConfig, validateDeclaredMemoryScope } from './memory-resource-policy';
import { sourceFingerprint, nodeRuntimeIdentity, sha256 } from './memory-resource-identity';
import {
    requirements,
    QualificationBlocked,
    MemoryAssessment,
    validateMemoryPolicy,
    validateProcessSample,
    type MemoryPolicy,
    type ProcessSample,
} from './memory-resource-verdict';

async function main(owner: ProductRunOwner) {
    owner.assertAdmissible();
    const args = argumentsOf(process.argv.slice(2));
    const calibrating = args.has('calibration');
    if (calibrating) {
        assert.equal(args.get('calibration'), '1', 'Use --calibration=1 explicitly.');
        assert.ok(
            args.get('driver'),
            'Product calibration requires an explicit reviewed product adapter module.',
        );
        assert.ok(
            !args.has('component') && !args.has('memory-policy'),
            'Product calibration requires full product mode and no enforcement policy.',
        );
    }
    const lane = args.get('lane'),
        gcMode = args.get('gc') ?? 'normal',
        adapter =
            args.get('driver') ??
            fileURLToPath(new URL('./memory-resource-platform.ts', import.meta.url)),
        destination = args.get('out');
    assert.ok(
        ['desktop', 'browser', 'gateway'].includes(lane ?? ''),
        'Provide --lane=desktop|browser|gateway.',
    );
    assert.ok(['normal', 'forced'].includes(gcMode));
    assert.ok(
        adapter && destination,
        'Provide --driver=<test integration module> and --out=<private evidence directory>.',
    );
    const adapterPath = path.resolve(adapter);
    const adapterHash = createHash('sha256')
        .update(await fs.readFile(adapterPath))
        .digest('hex');
    const sourceSHA256 = args.get('source-sha256');
    assert.match(sourceSHA256 ?? '', /^[a-f0-9]{64}$/, 'Pin the composed source manifest hash.');
    assert.equal(
        sourceSHA256,
        await sourceFingerprint(fileURLToPath(new URL('../..', import.meta.url))),
        'Composed source fingerprint mismatch.',
    );
    await fs.mkdir(destination, { recursive: true });
    const output = await fs.mkdtemp(path.join(path.resolve(destination), `${lane}-${gcMode}-`));
    const timeline = await fs.open(path.join(output, 'timeline.jsonl'), 'wx');
    let writes = Promise.resolve();
    const emit = async (stage: string, data: unknown) => {
        const line = JSON.stringify({ time: Date.now(), stage, data }) + '\n';
        writes = writes.then(async () => {
            await timeline.write(line);
        });
        await writes;
    };
    const { createQualificationDriver } = await import(pathToFileURL(adapterPath).href);
    let driver: QualificationDriver;
    let stop = false;
    let sampling: Promise<void> = Promise.resolve();
    let inFlight: Promise<ProcessSample[]> | undefined;
    const peaks = new Map<string, number>();
    const recordPeaks = (processes: ProcessSample[]) => {
        assert.ok(processes.length, 'Missing owned process history.');
        processes.forEach(validateProcessSample);
        for (const process of processes)
            if (process.state === 'running' && process.rssBytes !== null) {
                const key = `${process.pid}/${process.created}/${process.role}`;
                peaks.set(key, Math.max(peaks.get(key) ?? 0, process.rssBytes));
                assert.ok(peaks.size <= 256, 'Unbounded process churn in soak.');
            }
    };
    const shutdown = new ProductShutdownObserver(
        () => {
            if (!driver.sampleShutdownProcesses)
                throw new QualificationBlocked(
                    'Driver lacks independent shutdown process-history observation.',
                );
            return driver.sampleShutdownProcesses();
        },
        (read) => owner.observe(read),
        emit,
        recordPeaks,
    );
    try {
        driver = await owner.run(() =>
            createQualificationDriver({
                lane,
                gcMode,
                viewer: args.has('viewer'),
                component: args.has('component'),
                profile: path.join(output, 'profile'),
                emit,
                signal: owner.signal,
                workDeadlineMs: owner.job.deadlineMs - owner.job.reserveMs,
            }),
        );
        owner.bind(driver, async () => {
            // Admit OS observation before shutdown; join the old CDP sample before inspection retirement.
            shutdown.start();
            stop = true;
            await sampling;
            await inFlight;
        });
    } catch (error) {
        await emit('receipt', {
            status: 'failed',
            stage: 'driver-startup',
            sourceSHA256,
            adapterHash,
            failure: String(error).slice(0, 4096),
        });
        const errors = await syncCloseEvidence([timeline]);
        if (errors.length)
            throw new AggregateError(
                [error, ...errors],
                'Product startup evidence closure failed.',
            );
        throw error;
    }
    const required = requirements(
        args.has('component'),
        driver.capabilities.supported,
        args.has('viewer'),
    );
    let assessment: MemoryAssessment | undefined,
        assessmentIdentity: string | null = null,
        policySHA256: string | null = null;
    let memoryResult: unknown = {
        status: 'unqualified-no-reviewed-policy',
        unsupported: driver.memoryScope?.unsupported ?? {
            memory: 'Driver did not declare a memory scope.',
        },
    };
    const coverage = new Set<string>();
    let samplerFailure: unknown,
        failure: unknown,
        cycles = 0,
        warmupCycles = 0;
    let achievedWarmupMs = 0,
        achievedMeasuredMs = 0;
    const started = performance.now();
    const checkOwners = async (stage: string) => {
        const counts = await driver.snapshotOwners(stage);
        assert.ok(Object.keys(counts).length, 'Missing owner instrumentation.');
        for (const kind of required.owners)
            assert.ok(Number.isSafeInteger(counts[kind]), `Missing exact owner probe ${kind}`);
        for (const [owner, count] of Object.entries(counts))
            assert.equal(count, 0, `${stage}: abandoned owner ${owner}`);
        await emit('owners', { stage, counts });
    };
    const collect = async (quiescent = false) => {
        const processes = await owner.run(() =>
            driver.sampleProcesses({
                quiescent,
                forceGc: quiescent && gcMode === 'forced',
            }),
        );
        assert.ok(
            processes.length,
            'A process exiting is terminated, never an empty/zero memory sample.',
        );
        recordPeaks(processes);
        await emit('processes', processes);
        return processes;
    };
    const sample = () => {
        inFlight ??= collect().finally(() => {
            inFlight = undefined;
        });
        return inFlight;
    };
    const checkpoint = async () => {
        await inFlight;
        inFlight = collect(true).finally(() => {
            inFlight = undefined;
        });
        return inFlight;
    };
    const sampleContinuously = async () => {
        if (args.has('no-sampler')) return;
        while (!stop && !owner.signal.aborted) {
            const begin = performance.now();
            await sample();
            if (!stop && !owner.signal.aborted)
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.max(0, 250 - (performance.now() - begin))),
                );
        }
    };
    try {
        await emit('identity', {
            lane,
            gcMode,
            sourceSHA256,
            adapterHash,
            versions: driver.versions,
            productJob: owner.job,
            capabilities: driver.capabilities,
            observer: args.has('no-sampler')
                ? 'disabled-matched-control'
                : 'serialized-250ms-target',
            viewer: args.has('viewer'),
        });
        for (const item of required.coverage)
            assert.ok(
                driver.capabilities.supported.includes(item),
                `Unsupported qualification case ${item}: ${driver.capabilities.unsupported[item] ?? 'no implementation'}`,
            );
        assert.ok(
            driver.sampleShutdownProcesses,
            'Driver must provide independent OS shutdown history.',
        );
        await checkOwners('preflight');
        const policyPath = args.get('memory-policy');
        if (!policyPath && !args.has('component') && !calibrating)
            throw new QualificationBlocked(
                'Product memory qualification requires --memory-policy=<reviewed policy>; lifecycle collection is not a memory pass.',
            );
        if (policyPath || calibrating) {
            const scope = validateDeclaredMemoryScope(driver.memoryScope);
            const assessmentContext = {
                sourceSHA256,
                adapterHash,
                versions: driver.versions,
                scope,
                harness: await nodeRuntimeIdentity(),
                config: soakAssessmentConfig({
                    lane: lane!,
                    gcMode,
                    observer: args.has('no-sampler') ? 'disabled' : '250ms',
                    viewer: args.has('viewer'),
                    component: args.has('component'),
                    requirements: required,
                }),
            };
            assessmentIdentity = sha256(JSON.stringify(assessmentContext));
            await emit('assessment-context', {
                assessmentIdentity,
                context: assessmentContext,
                mode: calibrating
                    ? 'unreviewed-product-calibration'
                    : 'reviewed-policy-enforcement',
            });
            if (calibrating)
                memoryResult = {
                    status: 'unreviewed-product-calibration',
                    assessmentIdentity,
                    policySupplied: false,
                    thresholdsSelected: false,
                };
            else {
                assert.ok(policyPath);
                const bytes = await fs.readFile(policyPath),
                    policy: MemoryPolicy = JSON.parse(bytes.toString());
                policySHA256 = sha256(bytes);
                validateMemoryPolicy(policy, assessmentIdentity, scope.roles);
                assessment = new MemoryAssessment(policy);
                memoryResult = { status: 'assessment-pending', assessmentIdentity, policySHA256 };
            }
        }
        sampling = sampleContinuously().catch((error) => {
            samplerFailure = error;
        });
        const warmStart = performance.now();
        while (performance.now() - warmStart < 300000) {
            const catalogMode = warmupCycles % 2 ? 'growing' : 'constant';
            const result = await owner.run(() =>
                driver.cycle({
                    phase: 'warmup',
                    ordinal: warmupCycles++,
                    payloadBytes: 33 * 1024 ** 2,
                    catalogMode,
                }),
            );
            await checkOwners('warmup-cycle');
            const samples = await checkpoint();
            assessment?.warm(samples, `${catalogMode}/${result.diskRecords}`);
            await emit('quiescent-checkpoint', {
                phase: 'warmup',
                ordinal: warmupCycles - 1,
                stateKey: `${catalogMode}/${result.diskRecords}`,
                diskBytes: result.diskBytes,
                cache: result.cache,
                processes: samples,
            });
            await emit('warmup-cycle', result);
            if (samplerFailure) throw samplerFailure;
        }
        achievedWarmupMs = performance.now() - warmStart;
        const measuredStart = performance.now();
        while (performance.now() - measuredStart < 1500000 || cycles < 100) {
            assert.ok(
                performance.now() - measuredStart < 1800000,
                'Measured deadline exceeded before minimum cycle coverage.',
            );
            const catalogMode = cycles % 2 ? 'growing' : 'constant';
            const result = await owner.run(() =>
                driver.cycle({
                    phase: 'measured',
                    ordinal: cycles,
                    payloadBytes: 33 * 1024 ** 2,
                    catalogMode,
                }),
            );
            assert.ok(
                result.diskRecords <= 500 &&
                    (result.diskBytes === null
                        ? args.has('component')
                        : result.diskBytes <= 64 * 1024 ** 2),
                'Declared catalog fixture budget exceeded.',
            );
            for (const id of result.coverage) {
                assert.ok(required.coverage.includes(id), `Unknown coverage ${id}`);
                coverage.add(id);
            }
            await checkOwners('closed-cycle');
            const samples = await checkpoint();
            assessment?.observe(samples, `${catalogMode}/${result.diskRecords}`);
            await emit('quiescent-checkpoint', {
                phase: 'measured',
                ordinal: cycles,
                stateKey: `${catalogMode}/${result.diskRecords}`,
                diskBytes: result.diskBytes,
                cache: result.cache,
                processes: samples,
            });
            await emit('measured-cycle', { ordinal: cycles++, ...result });
            if (samplerFailure) throw samplerFailure;
        }
        achievedMeasuredMs = performance.now() - measuredStart;
        for (const item of required.coverage)
            assert.ok(
                coverage.has(item),
                `Unqualified lifecycle case: ${item}; ${driver.capabilities.unsupported[item] ?? 'not exercised'}`,
            );
        if (assessment)
            memoryResult = {
                status: 'passed-reviewed-metrics',
                assessmentIdentity,
                policySHA256,
                metrics: assessment.finish(),
                unqualifiedMetrics: assessment.unqualifiedMetrics(),
                rssExternal: 'Diagnostic unless explicitly calibrated per role in the policy.',
            };
    } catch (error) {
        failure = error;
        if (assessment)
            memoryResult = {
                status:
                    error instanceof QualificationBlocked
                        ? 'unqualified-assessment'
                        : 'failed-reviewed-assessment',
                reason: String(error).slice(0, 4096),
                assessmentIdentity,
                policySHA256,
            };
    } finally {
        let ownershipJoined = false;
        try {
            const errors: unknown[] = [];
            try {
                await owner.join();
            } catch (error) {
                errors.push(error);
            }
            try {
                await shutdown.finish();
                owner.closeObservations();
            } catch (error) {
                errors.push(error);
            }
            if (errors.length)
                throw new AggregateError(errors, 'Product shutdown or final observation failed.');
            await checkOwners('full-teardown');
            ownershipJoined = true;
        } catch (error) {
            failure ??= error;
            owner.hold(error);
        }
        failure ??= samplerFailure;
        if (owner.signal.aborted) failure ??= owner.signal.reason;
        try {
            await emit('receipt', {
                status: failure
                    ? failure instanceof QualificationBlocked
                        ? 'blocked'
                        : 'failed'
                    : assessment
                      ? args.has('component')
                          ? 'passed-component-reviewed-memory'
                          : 'passed-reviewed-memory-scope'
                      : calibrating
                        ? 'collected-product-calibration-evidence'
                        : 'collected-component-lifecycle-evidence',
                failure: failure ? String(failure) : null,
                lane,
                gcMode,
                sourceSHA256,
                adapterHash,
                warmupCycles,
                cycles,
                achievedWarmupMs,
                achievedMeasuredMs,
                totalMs: performance.now() - started,
                coverage: [...coverage],
                missing: required.coverage.filter((id) => !coverage.has(id)),
                memory: memoryResult,
                assessmentIdentity,
                policySHA256,
                observedPeakRSSBytes: Object.fromEntries(peaks),
                peakIsSamplingLowerBound: true,
                limitation:
                    'A pass covers only these synthetic cases and platform/runtime identity; normal and forced runs are separate. Disk/cache accounting is intentional retained state.',
            });
        } finally {
            const errors = await syncCloseEvidence([timeline]);
            if (errors.length) {
                owner.hold('Product timeline sync/close failed.');
                throw new AggregateError(errors, 'Product timeline sync/close failed.');
            }
        }
        if (ownershipJoined) owner.finish(true);
    }
    if (failure) throw failure;
}
async function supervise() {
    const job = productJob();
    const child = spawn(
        process.execPath,
        [
            ...process.execArgv,
            fileURLToPath(import.meta.url),
            ...process.argv.slice(2),
            '--child=1',
            '--product-job=' + JSON.stringify(job),
        ],
        { windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] },
    );
    const observed = observeProductOwner(child, job);
    const cancel = (reason: string) => observed.abort(reason);
    const term = () => cancel('Product supervisor received SIGTERM.');
    const interrupt = () => cancel('Product supervisor received SIGINT.');
    process.on('SIGTERM', term);
    process.on('SIGINT', interrupt);
    const release = () => {
        process.off('SIGTERM', term);
        process.off('SIGINT', interrupt);
    };
    child.once('close', release);
    const row = await observed.outcome;
    // An exit does not establish inherited-stream closure. Unknown retains the child/IPC/listeners.
    if (
        !row.spawnObserved ||
        !row.exitObserved ||
        !row.closeObserved ||
        row.error ||
        row.timedOut ||
        row.code !== row.closeCode ||
        row.signal !== row.closeSignal ||
        row.code !== 0 ||
        row.signal !== null
    )
        process.exitCode = 1;
    if (!row.closeObserved)
        console.error('INVALID: product owner actual closure unknown; ownership remains attached.');
}
async function runChild() {
    assert.equal(process.connected, true, 'Direct product child requires its reviewed IPC owner.');
    const raw = argumentsOf(process.argv.slice(2)).get('product-job');
    assert.ok(raw, 'Direct product child requires the shared product job identity.');
    const owner = new ProductRunOwner(productJob(raw));
    try {
        await main(owner);
    } catch (error) {
        if (!owner.snapshot().completed) owner.hold(error);
        throw error;
    }
}
void (process.argv.includes('--child=1') ? runChild() : supervise()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

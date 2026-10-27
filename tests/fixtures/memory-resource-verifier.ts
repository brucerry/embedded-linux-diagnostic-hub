/** Bounded source-verifier fixture: virtual clocks/metrics only; no child, socket or OS query. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { mockLife } from './memory-fast-test-input';
const root = path.resolve(import.meta.dirname, '../..');
const realRequire = createRequire(import.meta.url);
type Options = {
    component?: boolean;
    viewer?: boolean;
    attachedViewer?: boolean;
    viewerOwners?: boolean;
    growth?: boolean;
    policy?: boolean;
    unsupportedScope?: boolean;
    calibration?: boolean;
    missingOwners?: boolean;
};
export async function verifySoak(options: Options = {}) {
    let clock = 0,
        running = true,
        samples = 0,
        cycles = 0,
        policyIdentity = '';
    let receipt: any, assessmentContext: any;
    let checkpoints = 0,
        shutdownSamples = 0,
        finalShutdownSamples = 0;
    let complete!: () => void, reject!: (error: unknown) => void;
    const done = new Promise<void>((resolve, fail) => {
        complete = resolve;
        reject = fail;
    });
    const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    let timerSequence = 0;
    const virtualTimers = new Map<number, () => void>();
    let evidenceSynced = false,
        evidenceClosed = false;
    const virtualProcess = Object.assign(new EventEmitter(), {
        argv: [] as string[],
        exitCode: 0,
        connected: true,
        hrtime: { bigint: () => BigInt(clock) * 1000000n },
        disconnect() {
            this.connected = false;
            if (receipt && evidenceSynced && evidenceClosed) complete();
            else reject(Error('Virtual owner released without durable receipt.'));
        },
    });
    const context = vm.createContext({
        Buffer,
        URL,
        AbortController,
        AggregateError,
        performance: { now: () => clock },
        process: virtualProcess,
        console: {
            error: (error: unknown) => {
                if (!receipt || !evidenceSynced || !evidenceClosed) reject(error);
                else complete(); // A failed/held virtual owner is an invalid verdict, not a live OS process.
            },
        },
        setTimeout: (callback: () => void) => {
            const id = ++timerSequence;
            virtualTimers.set(id, callback);
            return id;
        },
        clearTimeout: (id: number) => virtualTimers.delete(id),
    });
    const cache = new Map<string, { exports: any }>();
    const scope = {
        roles: ['gateway'],
        runtimeIdentity: {
            gateway: {
                executablePath: 'C:/mock/node.exe',
                executableSHA256: 'b'.repeat(64),
                launch: { gc: 'normal' },
            },
        },
        unsupported: options.unsupportedScope
            ? { gatewayNode: 'unmeasured shared observer host' }
            : {},
    };
    const driver = {
        versions: { node: 'mock' },
        memoryScope: scope,
        capabilities: { supported: [] as string[], unsupported: {} },
        async cycle(input: { phase: string; payloadBytes: number }) {
            cycles++;
            clock += input.phase === 'warmup' ? 50000 : 15000;
            return {
                coverage: driver.capabilities.supported,
                capturedBytes: input.payloadBytes,
                exportedBytes: input.payloadBytes,
                diskBytes: 0,
                diskRecords: 0,
                cache: {},
            };
        },
        async snapshotOwners() {
            const core = load(path.join(root, 'tests/fixtures/memory-resource-core.ts'));
            return Object.fromEntries(
                [
                    ...core.ownerKinds,
                    ...(options.viewerOwners !== false ? core.viewerOwnerKinds : []),
                ]
                    .filter((key: string) => !options.missingOwners || key !== 'producer')
                    .map((key: string) => [key, 0]),
            );
        },
        async sampleProcesses() {
            samples++;
            const bytes = options.growth ? samples * 256 * 1024 ** 2 : 1024 ** 2;
            return [
                {
                    pid: 123,
                    created: 'fixture-A',
                    role: 'gateway',
                    state: running ? 'running' : 'terminated',
                    rssBytes: running ? bytes : null,
                    heapUsedBytes: running ? bytes : null,
                    arrayBuffersBytes: running ? bytes : null,
                    externalBytes: running ? bytes : null,
                    unsupported: [],
                },
            ];
        },
        async sampleShutdownProcesses() {
            return (await driver.sampleProcesses()).map((row) => ({
                ...row,
                heapUsedBytes: null,
                externalBytes: null,
                arrayBuffersBytes: null,
                unsupported: ['Virtual OS-history fixture; no real process was queried.'],
            }));
        },
        async teardown() {
            running = false;
        },
        async assertDescendantsExited() {},
    };
    const fakeFs = {
        async readFile(file: string) {
            if (String(file).endsWith('reviewed-policy.json')) {
                const budget = {
                    maxDeltaBytes: 8 * 1024 ** 2,
                    maxSlopeBytesPerCycle: 1,
                    calibrationRuns: Array.from({ length: 10 }, (_, i) =>
                        i.toString(16).padStart(64, '0'),
                    ),
                };
                return Buffer.from(
                    JSON.stringify({
                        reviewed: true,
                        identitySHA256: policyIdentity,
                        roles: { gateway: { heapUsedBytes: budget, arrayBuffersBytes: budget } },
                    }),
                );
            }
            return Buffer.from('mock driver identity');
        },
        async mkdir() {},
        async mkdtemp() {
            return 'C:/virtual-output';
        },
        async open() {
            return {
                async write(line: string) {
                    const item = JSON.parse(line);
                    if (item.stage === 'receipt') receipt = item.data;
                    if (item.stage === 'assessment-context') assessmentContext = item.data;
                    if (item.stage === 'quiescent-checkpoint') checkpoints++;
                    if (item.stage === 'shutdown-processes') {
                        shutdownSamples++;
                        if (item.data.phase === 'final-joined') finalShutdownSamples++;
                    }
                },
                async sync() {
                    evidenceSynced = true;
                },
                async close() {
                    evidenceClosed = true;
                    if (!receipt) reject(Error('Verifier closed without a receipt.'));
                },
            };
        },
    };
    function load(file: string): any {
        file = path.resolve(file);
        const existing = cache.get(file);
        if (existing) return existing.exports;
        const module = { exports: {} };
        cache.set(file, module);
        const source = fs
            .readFileSync(file, 'utf8')
            .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href));
        const compiled = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText;
        const require = (id: string): any => {
            if (id === 'node:fs/promises') return fakeFs;
            if (id === 'node:child_process')
                return {
                    spawn() {
                        throw Error('Verifier attempted a child process.');
                    },
                };
            if (id === './memory-resource-identity')
                return {
                    sourceFingerprint: async () => 'a'.repeat(64),
                    nodeRuntimeIdentity: async () => ({
                        executableSHA256: 'c'.repeat(64),
                        launch: [],
                    }),
                    sha256(bytes: string | Uint8Array) {
                        const value = hash(bytes);
                        if (typeof bytes === 'string' && bytes.includes('"checkpointGrouping"'))
                            policyIdentity = value;
                        return value;
                    },
                };
            if (id.startsWith('file:')) return { createQualificationDriver: async () => driver };
            if (id.endsWith('.mjs')) return realRequire(path.resolve(path.dirname(file), id));
            if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
            return realRequire(id);
        };
        const execute = vm.runInContext(
            `(function(require,module,exports){${compiled}\n})`,
            context,
        );
        execute(require, module, module.exports);
        return module.exports;
    }
    const core = load(path.join(root, 'tests/fixtures/memory-resource-core.ts'));
    driver.capabilities.supported = [
        ...core.soakCoverage,
        ...(options.attachedViewer ? core.viewerCoverage : []),
    ];
    context.process.argv = [
        'node',
        path.join(root, 'tests/fixtures/memory-resource-soak.ts'),
        '--child=1',
        '--product-job=' +
            JSON.stringify(
                load(path.join(root, 'tests/fixtures/memory-product-owner.ts')).productJob(),
            ),
        '--lane=gateway',
        '--gc=normal',
        '--driver=C:/virtual-driver.ts',
        '--out=C:/virtual-output',
        '--source-sha256=' + 'a'.repeat(64),
        '--no-sampler=1',
        ...(options.component ? ['--component=1'] : []),
        ...(options.calibration ? ['--calibration=1'] : []),
        ...(options.viewer ? ['--viewer=1'] : []),
        ...(options.policy ? ['--memory-policy=C:/reviewed-policy.json'] : []),
    ];
    load(path.join(root, 'tests/fixtures/memory-resource-soak.ts'));
    await done;
    return {
        receipt,
        assessmentContext,
        checkpoints,
        cycles,
        samples,
        shutdownSamples,
        finalShutdownSamples,
        virtualIPCClosed: !virtualProcess.connected,
        virtualTimersRemaining: virtualTimers.size,
        evidenceSynced,
        evidenceClosed,
        realProcessesQueried: 0,
        realCycles: 0,
        realGrowthAllocated: 0,
    };
}

export async function verifyNegativeWrapper(
    signal: string | null,
    code: number | null,
    withPolicy = false,
    policyPath = 'C:/reviewed-policy.json',
) {
    const policyBytes = 'impossible-fixture-policy-bytes';
    const policyHash = createHash('sha256').update(policyBytes).digest('hex');
    let childArgs: string[] = [];
    let accepted = false,
        failure: unknown;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
        complete = resolve;
    });
    const file = path.join(root, 'tests/fixtures/memory-resource-negative.ts');
    const source = ts.transpileModule(
        fs
            .readFileSync(file, 'utf8')
            .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        },
    ).outputText;
    const context = vm.createContext({
        Buffer,
        URL,
        process: {
            argv: [
                'node',
                file,
                '--controls=js',
                '--out=C:/virtual',
                ...(withPolicy ? ['--policy=' + policyPath, '--policy-sha256=' + policyHash] : []),
            ],
            execArgv: [],
            execPath: 'mock',
            exitCode: 0,
        },
        console: {
            error(error: unknown) {
                failure = error;
                complete();
            },
        },
    });
    const fakeFs = {
        async mkdir() {},
        async mkdtemp() {
            return 'C:/virtual';
        },
        async readdir() {
            return ['run'];
        },
        async readFile(name: string) {
            if (name === policyPath) return Buffer.from(policyBytes);
            return String(name).endsWith('receipt.json')
                ? JSON.stringify({
                      code,
                      signal,
                      timedOut: false,
                      samplerFailure: null,
                      childExit: 'normal-failure',
                      lifecycle: { ...mockLife(code ?? 1), signal, closeSignal: signal },
                      evidenceClosed: true,
                      verdict: 'EXPECTED_NEGATIVE_DETECTED',
                      policySHA256: withPolicy ? policyHash : null,
                  })
                : 'retained-heapUsed';
        },
        async writeFile() {
            accepted = true;
            complete();
        },
    };
    const execute = vm.runInContext(`(function(require,module,exports){${source}\n})`, context);
    execute(
        (id: string) =>
            id === 'node:fs/promises'
                ? fakeFs
                : id === 'node:child_process'
                  ? {
                        spawn: (_exe: string, args: string[], options: any) => {
                            assert.equal(
                                JSON.stringify(options.stdio),
                                JSON.stringify(['ignore', 'inherit', 'inherit', 'ipc']),
                            );
                            const job = JSON.parse(options.env.HUB_MEMORY_JOB);
                            assert.equal(job.budgetMs, 120000);
                            assert.equal(job.reserveMs, 1000);
                            childArgs = args;
                            const child = Object.assign(new EventEmitter(), { pid: 42 });
                            queueMicrotask(() => {
                                child.emit('spawn');
                                child.emit('exit', 1, null);
                                child.emit('close', 1, null);
                            });
                            return child;
                        },
                    }
                  : id.startsWith('./memory-resource-')
                    ? realRequire(path.join(root, 'tests/fixtures', id + '.ts'))
                    : realRequire(id),
        { exports: {} },
        {},
    );
    await done;
    return {
        accepted,
        failure: failure ? String(failure) : null,
        realChildrenStarted: 0,
        childArgs,
    };
}
import assert from 'node:assert/strict';

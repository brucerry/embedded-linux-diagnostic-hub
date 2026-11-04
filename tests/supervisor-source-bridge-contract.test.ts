import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createHarnessObserver,
    createSourceBinding,
    harnessObserverSHA256,
    sourceBindingFromArguments,
    sourceBindingTimeline,
    sourceBridgePinsFromArguments,
    validateClosedChild,
    validateCollectedSupervisor,
    validateCollectedSupervisorHeader,
    validateSourceBinding,
    validateSupervisorSourceBridge,
    SUPERVISOR_SOURCE_BRIDGE_LIMIT,
} from '../scripts/lib/product-supervisor-contract.mjs';

// Synthetic contract facts only. No producer, Git object or real qualification is asserted.
function fixture() {
    const observer = createHarnessObserver({
        executablePath: '/synthetic/node',
        executableSHA256: 'a'.repeat(64),
        node: 'v24.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24.1.0' },
        execArgv: [],
        nodeOptions: null,
    });
    const sourceContext = {
        expected: { sourceCommit: 'b'.repeat(40), sourceTree: 'c'.repeat(40) },
        reference: { name: 'source-bridge.json', bytes: 123, sha256: 'd'.repeat(64) },
        provider: { synthetic: true },
    };
    const input = {
        sourceSHA256: 'e'.repeat(64),
        ...sourceContext.expected,
        sourceBridgeSHA256: sourceContext.reference.sha256,
        jobNonce: '11111111-1111-1111-1111-111111111111',
        adapterSHA256: 'f'.repeat(64),
        observerSHA256: harnessObserverSHA256(observer),
        lane: 'gateway',
        gcMode: 'normal',
        viewer: false,
        component: false,
        calibration: false,
    };
    const binding = createSourceBinding(input);
    const args = new Map([
        ['source-commit', input.sourceCommit],
        ['source-tree', input.sourceTree],
        ['source-sha256', input.sourceSHA256],
        ['lane', input.lane],
    ]);
    const raw = [...args].map(([name, value]) => '--' + name + '=' + value);
    const job = {
        schema: 1,
        nonce: input.jobNonce,
        budgetMs: 2400000,
        reserveMs: 60000,
        deadlineMs: 2500000,
    };
    const timeline = { name: 'timeline.jsonl', bytes: 456, sha256: '1'.repeat(64) };
    const childReference = { name: 'child-evidence.json', bytes: 789, sha256: '2'.repeat(64) };
    const lifecycle = {
        pid: 123,
        spawnObserved: true,
        exitObserved: true,
        closeObserved: true,
        code: 0,
        closeCode: 0,
        signal: null,
        closeSignal: null,
        error: null,
        timedOut: false,
        terminationRequested: false,
        killErrors: [],
        elapsedMs: 1,
    };
    const child = {
        schemaVersion: 4,
        kind: 'product-child-closed-timeline',
        qualification: false,
        nonce: job.nonce,
        binding,
        observer,
        timeline,
        sourceBridge: sourceContext.reference,
        ownerCompletion: 'not-asserted',
    };
    const parent = {
        schemaVersion: 4,
        kind: 'product-supervisor-observation',
        qualification: false,
        releaseAcceptance: false,
        status: 'collected-non-qualifying-supervisor-evidence',
        job,
        binding,
        observer,
        lifecycle,
        childEvidence: childReference,
        timeline,
        sourceBridge: sourceContext.reference,
        failures: [],
        scope: 'Observed supervisor lifecycle and closed child evidence only; no product or release verdict.',
    };
    const expected = {
        job,
        binding,
        observer,
        timeline,
        childReference,
        sourceBridge: sourceContext.reference,
    };
    const records = [
        { time: 0, stage: 'supervisor-source-binding', data: binding },
        { time: 1, stage: 'supervisor-harness-observer', data: observer },
        {
            time: 2,
            stage: 'supervisor-source-bridge',
            data: { ...sourceContext.expected, reference: sourceContext.reference },
        },
        {
            time: 3,
            stage: 'identity',
            data: {
                productJob: job,
                lane: binding.lane,
                gcMode: binding.gcMode,
                sourceSHA256: binding.sourceSHA256,
                viewer: binding.viewer,
                adapterHash: binding.adapterSHA256,
            },
        },
    ];
    return { observer, sourceContext, input, binding, args, raw, child, parent, expected, records };
}
function parseTimeline(f: ReturnType<typeof fixture>, records: unknown[]) {
    const parser = sourceBindingTimeline(f.binding, f.observer, f.sourceContext.reference);
    const bytes = Buffer.from(records.map((row) => JSON.stringify(row) + '\n').join(''));
    for (let i = 0; i < bytes.length; i += 17) parser.push(bytes.subarray(i, i + 17));
    parser.finish();
}

test('source binding v3 requires immutable pins and retained bridge hash without a legacy fallback', () => {
    const f = fixture();
    assert.equal(f.binding.schemaVersion, 3);
    assert.equal(f.binding.qualification, false);
    assert.equal(Object.isFrozen(f.binding), true);
    assert.equal(validateSourceBinding(f.binding), f.binding);
    for (const field of ['sourceCommit', 'sourceTree', 'sourceBridgeSHA256']) {
        const absent: any = { ...f.input };
        delete absent[field];
        assert.throws(() => createSourceBinding(absent));
        assert.throws(() => validateSourceBinding({ ...f.binding, [field]: 'invalid' }));
        assert.throws(() =>
            validateSourceBinding(
                { ...f.binding, [field]: '0'.repeat(field === 'sourceBridgeSHA256' ? 64 : 40) },
                f.binding,
            ),
        );
    }
    assert.throws(() => validateSourceBinding({ ...f.binding, schemaVersion: 2 }));
    assert.throws(() => validateSourceBinding({ ...f.binding, qualification: true }));
});

test('raw source pins are mandatory, single, explicit, parsed exactly and immutable', () => {
    const f = fixture(),
        expected = sourceBridgePinsFromArguments(f.raw, f.args);
    assert.deepEqual(expected, f.sourceContext.expected);
    assert.equal(Object.isFrozen(expected), true);
    for (const field of ['source-commit', 'source-tree', 'source-sha256']) {
        const remaining = f.raw.filter((arg) => !arg.startsWith('--' + field + '='));
        for (const raw of [
            remaining,
            [...remaining, '--' + field],
            [...f.raw, '--' + field + '=' + f.args.get(field)],
            [...remaining, '--' + field + '=wrong'],
            [...f.raw, field + '=' + f.args.get(field)],
            [...remaining, field + '=' + f.args.get(field)],
            [field + '=' + f.args.get(field), ...f.raw],
        ])
            assert.throws(() => sourceBridgePinsFromArguments(raw, f.args));
        const args = new Map(f.args);
        args.set(field, '0'.repeat(field === 'source-sha256' ? 64 : 40));
        assert.throws(() => sourceBridgePinsFromArguments(f.raw, args));
    }
});

test('argument binding checks independent source context and explicit pins', () => {
    const f = fixture();
    const bind = (args = f.args, context: any = f.sourceContext) =>
        sourceBindingFromArguments(
            args,
            f.input.sourceSHA256,
            f.input.adapterSHA256,
            f.input.jobNonce,
            f.observer,
            context,
        );
    assert.deepEqual(bind(), f.binding);
    assert.throws(() =>
        sourceBindingFromArguments(
            f.args,
            f.input.sourceSHA256,
            f.input.adapterSHA256,
            f.input.jobNonce,
            f.observer,
            undefined,
        ),
    );
    assert.throws(() => bind(f.args, {}));
    for (const field of ['source-commit', 'source-tree', 'source-sha256']) {
        const args = new Map(f.args);
        args.delete(field);
        assert.throws(() => bind(args));
        args.set(field, '0'.repeat(field === 'source-sha256' ? 64 : 40));
        assert.throws(() => bind(args));
    }
    assert.throws(() =>
        bind(f.args, {
            ...f.sourceContext,
            expected: { ...f.sourceContext.expected, sourceTree: '0'.repeat(40) },
        }),
    );
    assert.throws(() =>
        bind(f.args, {
            ...f.sourceContext,
            reference: { ...f.sourceContext.reference, name: 'foreign.json' },
        }),
    );
});

test('parent and child v4 bind the same independently retained bridge reference', () => {
    const f = fixture();
    assert.equal(validateClosedChild(f.child, f.expected), f.child);
    assert.equal(validateCollectedSupervisorHeader(f.parent, f.expected), f.parent);
    assert.equal(validateCollectedSupervisor(f.parent, f.child, f.expected), f.parent);
    for (const sourceBridge of [
        undefined,
        { ...f.sourceContext.reference, name: 'foreign.json' },
        { ...f.sourceContext.reference, bytes: 0 },
        { ...f.sourceContext.reference, bytes: SUPERVISOR_SOURCE_BRIDGE_LIMIT + 1 },
        { ...f.sourceContext.reference, sha256: '0'.repeat(64) },
    ]) {
        assert.throws(() => validateSupervisorSourceBridge(f.binding, sourceBridge));
        assert.throws(() => validateClosedChild(f.child, { ...f.expected, sourceBridge }));
        assert.throws(() =>
            validateCollectedSupervisorHeader(f.parent, { ...f.expected, sourceBridge }),
        );
    }
    for (const sourceBridge of [
        undefined,
        { ...f.sourceContext.reference, bytes: 124 },
        { ...f.sourceContext.reference, sha256: '0'.repeat(64) },
    ]) {
        assert.throws(() => validateClosedChild({ ...f.child, sourceBridge }, f.expected));
        assert.throws(() =>
            validateCollectedSupervisorHeader({ ...f.parent, sourceBridge }, f.expected),
        );
    }
    for (const schemaVersion of [1, 2, 3]) {
        assert.throws(() => validateClosedChild({ ...f.child, schemaVersion }, f.expected));
        assert.throws(() =>
            validateCollectedSupervisorHeader({ ...f.parent, schemaVersion }, f.expected),
        );
    }
    assert.throws(() =>
        validateCollectedSupervisor({ ...f.parent, releaseAcceptance: true }, f.child, f.expected),
    );
    assert.throws(() =>
        validateClosedChild(
            { ...f.child, nonce: '22222222-2222-2222-2222-222222222222' },
            f.expected,
        ),
    );
    const replay = { ...f.binding, jobNonce: '22222222-2222-2222-2222-222222222222' };
    assert.throws(() =>
        validateClosedChild({ ...f.child, binding: replay }, { ...f.expected, binding: replay }),
    );
});

test('timeline requires exactly one bridge third with exact source pins and retained reference', () => {
    const f = fixture();
    parseTimeline(f, f.records);
    const invalid: any[][] = [
        f.records.slice(0, 2),
        [f.records[0], f.records[2], f.records[1]],
        [f.records[0], f.records[1], f.records[3], f.records[2]],
        [...f.records, f.records[2]],
    ];
    for (const change of [
        { sourceCommit: '0'.repeat(40) },
        { sourceTree: '0'.repeat(40) },
        { reference: { ...f.sourceContext.reference, bytes: 124 } },
        { reference: { ...f.sourceContext.reference, sha256: '0'.repeat(64) } },
        { unexpected: true },
    ]) {
        const records = structuredClone(f.records);
        records[2].data = { ...records[2].data, ...change };
        invalid.push(records);
    }
    const replay = structuredClone(f.records);
    (replay[0].data as any).jobNonce = '22222222-2222-2222-2222-222222222222';
    invalid.push(replay);
    for (const records of invalid) assert.throws(() => parseTimeline(f, records));
    assert.throws(() => sourceBindingTimeline(f.binding, f.observer, undefined));
});

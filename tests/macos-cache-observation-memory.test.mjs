import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
    CACHE_BRANCH,
    CACHE_REPOSITORY,
    CACHE_WORKFLOW,
    ObservationFailure,
    collectCacheObservation,
    executeObservation,
    encodeObservationOutput,
    observationLabel,
    reportFromStep,
} from '../.github/scripts/macos-cache-observation.mjs';
const { readBoundSource, writeBoundOutput } = createRequire(import.meta.url)(
    '../.github/actions/macos-cache-metadata/main.cjs',
);
const context = () => ({
    repository: CACHE_REPOSITORY,
    repositoryId: '1405501450',
    private: 'false',
    actions: 'true',
    event: 'push',
    ref: CACHE_BRANCH,
    attempt: '1',
    runId: '123',
    job: 'cache_metadata',
    workflowRef: `${CACHE_REPOSITORY}/${CACHE_WORKFLOW}@${CACHE_BRANCH}`,
    sha: 'a'.repeat(40),
    workflowSHA: 'a'.repeat(40),
    runnerEnvironment: 'github-hosted',
    runnerOS: 'macOS',
    runnerArch: 'X64',
    arch: 'x64',
    startup: {
        BASH_ENV: '/dev/null',
        ENV: '/dev/null',
        NODE_OPTIONS: '--no-addons',
        NODE_PATH: '',
        NODE_COMPILE_CACHE: '',
        NODE_DISABLE_COMPILE_CACHE: '1',
        ESBUILD_BINARY_PATH: '',
    },
});
const identity = () => ({ platform: 'darwin', arch: 'x64', node: '24.22.0', uid: 501, euid: 501 });
const summary = () => ({
    status: 'CACHE_METADATA_CANDIDATE',
    reason: 'none',
    nativeQualification: false,
    releaseAcceptance: false,
    binaryAuthenticated: false,
    actualRuntimeVersion: 'unverified',
    hostedProvenance: 'unverified',
    resources: {
        filesystemCalls: 50,
        opened: 1,
        closed: 1,
        confirmedBytes: 32,
        retainedUnknown: 0,
        closeFailed: false,
    },
});
function ports(value = summary()) {
    const calls = [];
    return {
        calls,
        verifySources: () => {
            calls.push('sources');
        },
        inspect: async (arch) => {
            calls.push(arch);
            return value;
        },
        writeOutput: (text) => {
            calls.push(text);
        },
    };
}

for (const [key, value] of Object.entries({
    repository: 'other/project',
    repositoryId: '2',
    private: 'true',
    event: 'workflow_dispatch',
    ref: 'refs/tags/v0.6.0',
    attempt: '2',
    job: 'other',
    workflowSHA: 'b'.repeat(40),
    runnerEnvironment: 'self-hosted',
    runnerArch: 'ARM64',
})) {
    test(`context ${key} refuses before source/cache IO`, async () => {
        const c = context();
        c[key] = value;
        const p = ports();
        const r = await collectCacheObservation(c, identity(), p);
        assert.equal(r.reason, 'entry-context');
        assert.deepEqual(p.calls, []);
    });
}
for (const [key, value] of Object.entries({
    platform: 'linux',
    arch: 'arm64',
    node: '22.1.0',
    uid: 0,
    euid: 0,
})) {
    test(`runtime ${key} refuses before source/cache IO`, async () => {
        const i = identity();
        i[key] = value;
        const p = ports();
        assert.equal((await collectCacheObservation(context(), i, p)).reason, 'entry-runtime');
        assert.deepEqual(p.calls, []);
    });
}
test('startup assumptions are checked before source/cache IO', async () => {
    const c = context();
    c.startup.NODE_OPTIONS = '';
    const p = ports();
    assert.equal((await collectCacheObservation(c, identity(), p)).reason, 'entry-context');
    assert.deepEqual(p.calls, []);
});
test('source completion precedes one architecture-bound inspection', async () => {
    const p = ports();
    const r = await collectCacheObservation(context(), identity(), p);
    assert.deepEqual(p.calls, ['sources', 'x64']);
    assert.equal(r.status, 'CACHE_METADATA_CANDIDATE');
    assert.equal(r.custody, 'CLOSED');
    assert.equal(r.binaryAuthenticated, false);
});
for (const thrown of [undefined, null, 0])
    test(`falsey source failure ${String(thrown)} prevents inspection`, async () => {
        let inspected = false;
        const r = await collectCacheObservation(context(), identity(), {
            verifySources: () => {
                throw thrown;
            },
            inspect: () => {
                inspected = true;
            },
        });
        assert.equal(r.reason, 'entry-source');
        assert.equal(inspected, false);
    });
test('source close uncertainty stops before import and remains distinct', async () => {
    const r = await collectCacheObservation(context(), identity(), {
        verifySources: () => {
            throw new ObservationFailure('entry-source-custody');
        },
        inspect: () => assert.fail('must not inspect'),
    });
    assert.equal(r.reason, 'entry-source-custody');
    assert.equal(r.custody, 'RETAINED_UNKNOWN');
});
test('inspection failure has no invented cache outcome', async () => {
    const r = await collectCacheObservation(context(), identity(), {
        verifySources: () => {},
        inspect: () => {
            throw undefined;
        },
    });
    assert.equal(r.status, 'NOT_OBSERVED');
    assert.equal(r.reason, 'entry-inspection');
});
for (const [name, change] of [
    ['short', (s) => (s.resources.confirmedBytes = 31)],
    ['authority', (s) => (s.binaryAuthenticated = true)],
    [
        'unknown-code',
        (s) => {
            s.status = 'REFUSED';
            s.reason = 'unrecognized';
        },
    ],
])
    test(`invalid summary ${name} cannot pass`, async () => {
        const s = summary();
        change(s);
        const r = await collectCacheObservation(context(), identity(), ports(s));
        assert.notEqual(r.status, 'CACHE_METADATA_CANDIDATE');
    });
test('cache short read with confirmed close reports refusal', async () => {
    const s = summary();
    s.status = 'REFUSED';
    s.reason = 'short-read';
    s.resources.confirmedBytes = 7;
    const r = await collectCacheObservation(context(), identity(), ports(s));
    assert.deepEqual([r.status, r.reason, r.custody], ['REFUSED', 'short-read', 'CLOSED']);
});
test('unknown cache close remains retained without successful classification', async () => {
    const s = summary();
    s.status = 'REFUSED';
    s.reason = 'closure-unknown';
    Object.assign(s.resources, { closed: 0, retainedUnknown: 1, closeFailed: true });
    const r = await collectCacheObservation(context(), identity(), ports(s));
    assert.equal(r.custody, 'RETAINED_UNKNOWN');
    assert.equal(r.status, 'REFUSED');
});
test('contradictory close flags cannot report a confirmed close', async () => {
    const s = summary();
    s.status = 'REFUSED';
    s.reason = 'unsafe';
    s.resources.closeFailed = true;
    const r = await collectCacheObservation(context(), identity(), ports(s));
    assert.equal(r.status, 'NOT_OBSERVED');
    assert.equal(r.custody, 'NOT_OBSERVED');
});
test('encoder emits only finite fields and bounded framing', async () => {
    const r = await collectCacheObservation(context(), identity(), ports());
    const text = encodeObservationOutput({ ...r, privateDetail: '/not-for-reporting' });
    assert.equal(text, 'status=CACHE_METADATA_CANDIDATE\nreason=none\ncustody=CLOSED\nvalid=1\n');
    assert.ok(Buffer.byteLength(text) < 1024);
    assert.throws(() => encodeObservationOutput({ ...r, reason: 'unrecognized' }));
});
test('report-only mode touches no observation or output ports', async () => {
    const p = {
        verifySources: () => assert.fail(),
        inspect: () => assert.fail(),
        writeOutput: () => assert.fail(),
    };
    const step = {
        outcome: 'success',
        valid: '1',
        status: 'CACHE_METADATA_CANDIDATE',
        reason: 'none',
        custody: 'CLOSED',
    };
    assert.equal(await executeObservation('report', context(), identity(), p, step), 0);
    assert.equal(
        await executeObservation('report', context(), identity(), p, {
            ...step,
            outcome: 'failure',
        }),
        1,
    );
});
test('completed refusal report leaves overall classification nonpassing', async () => {
    const s = summary();
    s.status = 'REFUSED';
    s.reason = 'unsafe';
    s.resources.opened = 0;
    s.resources.closed = 0;
    s.resources.confirmedBytes = 0;
    const p = ports(s);
    assert.equal(await executeObservation('observe', context(), identity(), p), 0);
    assert.equal(
        await executeObservation(
            'report',
            context(),
            identity(),
            {},
            {
                outcome: 'success',
                valid: '1',
                status: 'REFUSED',
                reason: 'unsafe',
                custody: 'NO_DESCRIPTOR',
            },
        ),
        1,
    );
});
test('output failure or unsupported acknowledgement cannot lend authority to partial fields', async () => {
    for (const writeOutput of [
        () => {
            throw undefined;
        },
        () => false,
    ]) {
        const p = ports();
        p.writeOutput = writeOutput;
        assert.equal(await executeObservation('observe', context(), identity(), p), 1);
    }
    const r = reportFromStep({
        outcome: 'failure',
        valid: '1',
        status: 'CACHE_METADATA_CANDIDATE',
        reason: 'none',
        custody: 'CLOSED',
    });
    assert.equal(r.status, 'NOT_OBSERVED');
    assert.equal(
        observationLabel('x64', r),
        'Cache x64 — NOT_OBSERVED / entry-report / NOT_OBSERVED',
    );
});
test('missing or malformed reports and unknown modes remain nonpassing', async () => {
    for (const step of [
        {},
        { outcome: 'success', valid: '1', status: 'REFUSED', reason: 'none', custody: 'CLOSED' },
    ])
        assert.equal(reportFromStep(step).status, 'NOT_OBSERVED');
    assert.equal(await executeObservation('unsupported', context(), identity(), ports()), 1);
});

const bytes = Buffer.from('known inert source');
const spec = ['first-party', bytes.length, crypto.createHash('sha256').update(bytes).digest('hex')];
function fakeIO(overrides = {}) {
    const log = [];
    let writes = 0;
    const meta = () => ({
        isFile: () => true,
        dev: 1n,
        ino: 3n,
        mode: 0o100644n,
        uid: 501n,
        nlink: 1n,
        size: BigInt(bytes.length),
        mtimeNs: 1n,
        ctimeNs: 1n,
    });
    return {
        log,
        constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_WRONLY: 4, O_APPEND: 8 },
        lstatSync: () => meta(),
        fstatSync: () => meta(),
        openSync: () => {
            log.push('open');
            return 0;
        },
        readSync: (fd, b, off, len, pos) => {
            log.push('read');
            const n = Math.min(3, len);
            bytes.copy(b, off, pos, pos + n);
            return n;
        },
        writeSync: (_fd, _b, _off, len) => {
            writes++;
            log.push('write');
            return Math.min(2, len);
        },
        closeSync: () => {
            log.push('close');
        },
        ...overrides,
    };
}
test('bounded source read accepts fd0 and positive short reads then closes once', () => {
    const io = fakeIO();
    readBoundSource('/inert/source', spec, 501, io);
    assert.equal(io.log.filter((v) => v === 'close').length, 1);
});
test('source digest mismatch and EOF both close and refuse', () => {
    for (const io of [fakeIO(), fakeIO({ readSync: () => 0 })]) {
        assert.throws(() =>
            readBoundSource('/inert/source', [spec[0], spec[1], '0'.repeat(64)], 501, io),
        );
        assert.equal(io.log.filter((v) => v === 'close').length, 1);
    }
});
test('source falsey primary survives a successful close', () => {
    const io = fakeIO({
        readSync: () => {
            throw undefined;
        },
    });
    let caught = false;
    try {
        readBoundSource('/inert/source', spec, 501, io);
    } catch (error) {
        caught = true;
        assert.equal(error, undefined);
    }
    assert.equal(caught, true);
    assert.equal(io.log.at(-1), 'close');
});
test('output writes are bounded, partial-progress aware, and closed once', () => {
    const io = fakeIO();
    writeBoundOutput('/inert/output', 'bounded\n', 501, io);
    assert.equal(io.log.filter((v) => v === 'close').length, 1);
    assert.throws(() => writeBoundOutput('/inert/output', 'x'.repeat(1024), 501, io));
});
test('zero output progress fails with a once-only close', () => {
    const io = fakeIO({ writeSync: () => 0 });
    assert.throws(() => writeBoundOutput('/inert/output', 'bounded', 501, io));
    assert.equal(io.log.at(-1), 'close');
});
test('unknown source/output close freezes the respective owner without retries', () => {
    const source = fakeIO({
        readSync: () => {
            throw undefined;
        },
        closeSync: () => {
            source.log.push('close');
            throw undefined;
        },
    });
    assert.throws(() => readBoundSource('/inert/source', spec, 501, source), {
        code: 'entry-source-custody',
    });
    const sourceCalls = source.log.length;
    assert.throws(() => readBoundSource('/inert/source', spec, 501, source), {
        code: 'entry-source-custody',
    });
    assert.equal(source.log.length, sourceCalls);
    const output = fakeIO({
        closeSync: () => {
            output.log.push('close');
            return false;
        },
    });
    assert.throws(() => writeBoundOutput('/inert/output', 'bounded', 501, output), {
        code: 'entry-report',
    });
    const outputCalls = output.log.length;
    assert.throws(() => writeBoundOutput('/inert/output', 'bounded', 501, output));
    assert.equal(output.log.length, outputCalls);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { consumeInstallerLifecycleEvidence } from '../scripts/lib/installer-lifecycle-evidence.mjs';
import {
    validateWindowsNativeBinding,
    inspectWindowsNativeRows,
    inspectWindowsNativeLifecycle,
    readWindowsNativeRecords,
    produceWindowsNativeLifecycle,
    inspectWindowsNativeQueryRelease,
    releaseWindowsNativeLifecycleQueries,
    inspectWindowsNativeOwnedRows,
    inspectWindowsNativeOwnedLifecycle,
    readWindowsNativeOwnedRecords,
    produceWindowsNativeOwnedRuntime,
    observeWindowsNativeOwnedRuntime,
} from '../scripts/lib/windows-native-lifecycle.mjs';

// Authored data tests semantic consistency only. They cannot issue a native
// capability and never load/build an addon, open an OS handle or run a process.
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function fixture() {
    const binding = {
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        runId: '123',
        runAttempt: '1',
        lane: 'win32-x64',
        caseId: 'windows-nsis:offline-launch',
        package: {
            name: 'Diagnostic-Hub-Windows-x64-Setup.exe',
            bytes: 300,
            sha256: 'c'.repeat(64),
        },
        root: 'C:\\synthetic\\Hub',
        expectedFiles: [
            { relativePath: 'Diagnostic Hub.exe', size: 20, sha256: 'd'.repeat(64) },
            { relativePath: 'resources/app.asar', size: 30, sha256: 'e'.repeat(64) },
        ],
    };
    const expected = {
        version: '0.6.0',
        sourceCommit: binding.sourceCommit,
        sourceTree: binding.sourceTree,
        runId: binding.runId,
        runAttempt: binding.runAttempt,
        lane: binding.lane,
        artifacts: [binding.package],
    };
    const filePins = {
        schemaVersion: 1,
        kind: 'windows-native-file-pins/v1',
        binding: structuredClone(binding),
        observation: {
            host: { adminMember: false, elevated: false, integrityRid: 8192 },
            files: binding.expectedFiles.map((file, i) => ({
                ...file,
                fileId: String(i + 1).repeat(32),
                volumeSerial: 'a'.repeat(16),
            })),
            leaseScope: 'named-executable-and-asar',
            fileLeasesRetained: true,
            physicalLoadedBytesVerified: false,
            releaseAcceptance: false,
        },
    };
    const process = {
        schemaVersion: 1,
        kind: 'windows-native-process/v1',
        binding: structuredClone(binding),
        observation: {
            pid: 321,
            creationTime100ns: '133700000000000000',
            imagePathMatchesPinnedName: true,
            openedImagePathFileIdMatchesPin: true,
            processHandleRetained: true,
            windows: [{ handle: '1234', pid: 321, threadId: 456, visible: true }],
            processOwnership: false,
            physicalLoadedBytesVerified: false,
            physicalDescendantClosure: false,
            releaseAcceptance: false,
        },
    };
    const bytes = { 'file-pins': encoded(filePins), process: encoded(process) };
    const records = Object.fromEntries(
        Object.entries(bytes).map(([role, bytes]) => [
            role,
            {
                path: 'windows-native/offline-launch/' + role + '.json',
                bytes: bytes.length,
                sha256: sha(bytes),
            },
        ]),
    );
    const observation = {
        kind: 'windows-native-readonly-consistency/v1',
        binding,
        filePins,
        process,
        records,
    };
    const item = { id: binding.caseId, evidence: Object.values(records) };
    return { binding, expected, filePins, process, bytes, records, observation, item };
}

test('Windows original-row semantic model stays explicitly partial and unqualified', async () => {
    const f = fixture(),
        reads: string[] = [];
    assert.equal(
        inspectWindowsNativeLifecycle(f.observation, f.item, f.expected),
        'selected-named-files-and-process-consistent-unqualified',
    );
    await readWindowsNativeRecords(f.observation, async (name: string, cap: number) => {
        reads.push(name);
        const role = name.endsWith('/file-pins.json') ? 'file-pins' : 'process';
        assert.ok(f.bytes[role].length <= cap);
        return Buffer.from(f.bytes[role]);
    });
    assert.deepEqual(reads, [
        'windows-native/offline-launch/file-pins.json',
        'windows-native/offline-launch/process.json',
    ]);
    assert.equal(f.filePins.observation.physicalLoadedBytesVerified, false);
    assert.equal(f.process.observation.processOwnership, false);
    assert.equal(f.process.observation.physicalDescendantClosure, false);
    assert.equal(f.process.observation.releaseAcceptance, false);
});

test('Windows selected binding is copied and accepts exactly the two named file roles', () => {
    const f = fixture(),
        copied = validateWindowsNativeBinding(f.binding);
    f.binding.expectedFiles[0].sha256 = 'f'.repeat(64);
    assert.equal(copied.expectedFiles[0].sha256, 'd'.repeat(64));
    for (const change of [
        (q: any) => q.expectedFiles.reverse(),
        (q: any) => q.expectedFiles.push({ ...q.expectedFiles[0], relativePath: 'extra.dll' }),
        (q: any) => (q.expectedFiles[1].relativePath = '../resources/app.asar'),
        (q: any) => (q.mode = 'native'),
        (q: any) => (q.root = 'C:\\synthetic\\Hub.'),
        (q: any) => (q.root = '\\\\server\\share\\Hub'),
    ]) {
        const q = fixture().binding;
        change(q);
        assert.throws(() => validateWindowsNativeBinding(q));
    }
});

test('Windows rows bind exact source/run/package/root and actual named hashes', () => {
    for (const change of [
        (q: any) => (q.binding.sourceTree = 'f'.repeat(40)),
        (q: any) => (q.binding.runAttempt = '2'),
        (q: any) => (q.binding.package.sha256 = 'f'.repeat(64)),
        (q: any) => (q.binding.root = 'C:\\other\\Hub'),
        (q: any) => (q.observation.files[0].sha256 = 'f'.repeat(64)),
        (q: any) => q.observation.files[1].size++,
        (q: any) => (q.observation.files[1].fileId = q.observation.files[0].fileId),
    ]) {
        const f = fixture();
        change(f.filePins);
        assert.throws(() => inspectWindowsNativeRows(f.filePins, f.process, f.binding));
    }
});

test('Windows elevated, admin and unknown or different integrity observations are refused', () => {
    for (const host of [
        { adminMember: true, elevated: false, integrityRid: 8192 },
        { adminMember: false, elevated: true, integrityRid: 8192 },
        { adminMember: null, elevated: false, integrityRid: 8192 },
        { adminMember: false, elevated: false, integrityRid: 0 },
        { adminMember: false, elevated: false, integrityRid: 12288 },
    ]) {
        const f = fixture();
        (f.filePins.observation as any).host = host;
        assert.throws(() => inspectWindowsNativeRows(f.filePins, f.process, f.binding));
    }
});

test('Windows process and HWND fields are bounded observational values, never launch or close authority', () => {
    for (const change of [
        (q: any) => (q.processOwnership = true),
        (q: any) => (q.physicalLoadedBytesVerified = true),
        (q: any) => (q.physicalDescendantClosure = true),
        (q: any) => (q.releaseAcceptance = true),
        (q: any) => (q.openedImagePathFileIdMatchesPin = false),
        (q: any) => (q.imagePathMatchesPinnedName = false),
        (q: any) => (q.processHandleRetained = false),
        (q: any) => (q.creationTime100ns = '01'),
        (q: any) => (q.pid = 0),
        (q: any) => q.windows[0].pid++,
        (q: any) => q.windows.push({ ...q.windows[0] }),
        (q: any) =>
            (q.windows = Array.from({ length: 129 }, (_, i) => ({
                ...q.windows[0],
                handle: String(i + 1),
            }))),
        (q: any) => (q.argv = []),
    ]) {
        const f = fixture();
        change(f.process.observation);
        assert.throws(() => inspectWindowsNativeRows(f.filePins, f.process, f.binding));
    }
});

test('Windows case projection rejects unrelated service labels and missing or aliased original references', () => {
    for (const change of [
        (f: any) => (f.expected.sourceCommit = 'f'.repeat(40)),
        (f: any) => (f.expected.runId = '124'),
        (f: any) => (f.expected.artifacts[0] = { ...f.binding.package, bytes: 301 }),
        (f: any) => (f.item.id = 'windows-nsis:install'),
        (f: any) => f.item.evidence.pop(),
        (f: any) => f.item.evidence.push(f.item.evidence[0]),
        (f: any) => (f.records.process.path = '../process.json'),
    ]) {
        const f = fixture();
        change(f);
        assert.throws(() => inspectWindowsNativeLifecycle(f.observation, f.item, f.expected));
    }
});

test('Windows original rows are reread by hash, canonical bytes and exact projection', async () => {
    for (const mode of [
        'changed-byte',
        'changed-projection',
        'duplicate-key',
        'trailing',
        'oversize',
        'typed-array',
    ]) {
        const f = fixture();
        if (mode === 'changed-projection') f.process.observation.windows[0].visible = false;
        await assert.rejects(
            readWindowsNativeRecords(f.observation, async (name: string) => {
                const role = name.endsWith('/file-pins.json') ? 'file-pins' : 'process';
                if (role === 'file-pins') return Buffer.from(f.bytes[role]);
                if (mode === 'changed-byte')
                    return Buffer.from(f.bytes.process.toString().replace('321', '322'));
                if (mode === 'duplicate-key')
                    return Buffer.from(
                        f.bytes.process
                            .toString()
                            .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
                    );
                if (mode === 'trailing') return Buffer.concat([f.bytes.process, Buffer.from(' ')]);
                if (mode === 'oversize') return Buffer.alloc(32769);
                if (mode === 'typed-array') return new Uint8Array(f.bytes.process) as any;
                return Buffer.from(f.bytes.process);
            }),
        );
    }
});

test('Windows actual producer rejects forged native capabilities instead of accepting model records', async () => {
    const f = fixture();
    for (const fake of [null, {}, { mode: 'native' }, { binding: f.binding, records: f.bytes }]) {
        await assert.rejects(produceWindowsNativeLifecycle(f.expected, f.binding, fake));
    }
});

test('Windows shared lifecycle consumer rereads native-shaped originals but keeps the global gate closed', async () => {
    const f = fixture();
    const envelope = {
        schemaVersion: 1,
        kind: 'installer-case-observation',
        version: f.expected.version,
        sourceCommit: f.expected.sourceCommit,
        sourceTree: f.expected.sourceTree,
        runId: f.expected.runId,
        runAttempt: f.expected.runAttempt,
        lane: f.expected.lane,
        caseId: f.binding.caseId,
        package: f.binding.package,
        observation: f.observation,
    };
    const bytes = encoded(envelope);
    const ref = {
        path: 'cases/windows-nsis/offline-launch.json',
        bytes: bytes.length,
        sha256: sha(bytes),
    };
    const item = { ...f.item, lifecycleEvidence: ref, evidence: [ref, ...f.item.evidence] };
    const files = new Map([
        [ref.path, bytes],
        ...Object.entries(f.bytes).map(
            ([role, bytes]) =>
                ['windows-native/offline-launch/' + role + '.json', bytes] as [string, Buffer],
        ),
    ]);
    const reads: string[] = [];
    const result = await consumeInstallerLifecycleEvidence(
        {
            schemaVersion: 2,
            kind: 'native-installer-lifecycle',
            runId: f.expected.runId,
            runAttempt: f.expected.runAttempt,
            cases: [item],
        },
        f.expected,
        async (name: string, cap: number) => {
            reads.push(name);
            const raw = files.get(name)!;
            assert.ok(raw.length <= cap);
            return Buffer.from(raw);
        },
    );
    assert.deepEqual(reads, [ref.path, ...Object.values(f.records).map((row: any) => row.path)]);
    assert.deepEqual(result, {
        status: 'installer-lifecycle-unqualified',
        releaseAcceptance: false,
        observations: [
            {
                caseId: f.binding.caseId,
                status: 'selected-named-files-and-process-consistent-unqualified',
            },
        ],
    });
    await assert.rejects(
        consumeInstallerLifecycleEvidence(
            {
                schemaVersion: 2,
                kind: 'native-installer-lifecycle',
                runId: f.expected.runId,
                runAttempt: f.expected.runAttempt,
                cases: [item],
            },
            f.expected,
            async (name: string) =>
                name.endsWith('/process.json')
                    ? encoded({ ...f.process, extra: true })
                    : Buffer.from(files.get(name)!),
        ),
    );
});

test('Windows query-handle release schema never represents observed process retirement', async () => {
    const complete = {
        readHandlesClosed: true,
        retainedUnknown: false,
        closedCount: 5,
        totalCount: 5,
        processOwnership: false,
        physicalDescendantClosure: false,
        releaseAcceptance: false,
    };
    assert.deepEqual(inspectWindowsNativeQueryRelease(complete), complete);
    const unknown = {
        ...complete,
        readHandlesClosed: false,
        retainedUnknown: true,
        closedCount: 4,
    };
    assert.deepEqual(inspectWindowsNativeQueryRelease(unknown), unknown);
    for (const change of [
        (q: any) => (q.retainedUnknown = true),
        (q: any) => (q.closedCount = 4),
        (q: any) => (q.readHandlesClosed = 1),
        (q: any) => (q.closedCount = 6),
        (q: any) => (q.totalCount = Infinity),
        (q: any) => (q.totalCount = 65),
        (q: any) => (q.processOwnership = true),
        (q: any) => (q.physicalDescendantClosure = true),
        (q: any) => (q.releaseAcceptance = true),
        (q: any) => (q.processRetired = true),
    ]) {
        const q = { ...complete };
        change(q);
        assert.throws(() => inspectWindowsNativeQueryRelease(q));
    }
    await assert.rejects(releaseWindowsNativeLifecycleQueries({ mode: 'native', ...complete }));
});

// Authored row data only. This helper cannot supply the private authority required
// by the actual producer; actual composed issuance is covered in the authority VM.
function ownedFixture() {
    const f = fixture();
    const requestedLaunch = {
        action: 'launch-pinned-installed',
        profile: f.binding.root + '\\native-launch-profile',
    };
    const tuple = { pid: 321, threadId: 456, creationTime100ns: '133700000000000000' };
    const createdProcess = {
        schemaVersion: 1,
        kind: 'windows-native-created-process/v2',
        binding: structuredClone(f.binding),
        requestedLaunch,
        observation: {
            creationAttempted: true,
            creationReturned: true,
            createdByThisOwner: true,
            processHandleRetained: true,
            threadHandleRetained: true,
            unconfirmedHandleOutput: false,
            ...tuple,
            processExitObserved: true,
            exitCode: 0,
            profileEmptyAtPreflight: true,
            hostEventLoopReferenceAcknowledged: true,
            stdioObserved: false,
            physicalLoadedBytesVerified: false,
            physicalDescendantClosure: false,
            releaseAcceptance: false,
        },
    };
    const normalQuit = {
        schemaVersion: 1,
        kind: 'windows-native-normal-quit/v1',
        binding: structuredClone(f.binding),
        requestedLaunch: structuredClone(requestedLaunch),
        createdProcess: structuredClone(tuple),
        identity: { pid: tuple.pid, type: 'browser' },
        observation: {
            identityReplyObserved: true,
            quitSchedulingReplyObserved: true,
            rootExitObserved: true,
            rootExitCode: 0,
            stdoutEOF: true,
            stderrEOF: true,
            ownedInspectorCloseObserved: true,
            closedUnacknowledgedReplies: 0,
            physicalLoadedBytesVerified: false,
            physicalDescendantClosure: false,
            releaseAcceptance: false,
        },
    };
    const ownedRelease = {
        schemaVersion: 1,
        kind: 'windows-native-owned-release/v1',
        binding: structuredClone(f.binding),
        requestedLaunch: structuredClone(requestedLaunch),
        createdProcess: structuredClone(tuple),
        observation: {
            ownedHandlesClosed: true,
            retainedUnknown: false,
            closedCount: 6,
            totalCount: 6,
            processOwnership: false,
            physicalDescendantClosure: false,
            releaseAcceptance: false,
            hostLifetimeAcquisitionSubmitted: true,
            hostLifetimeReleaseAcknowledged: true,
            hostLifetimeFinalizerObserved: true,
            hostLifetimeFinalizerAcknowledged: true,
            hostEnvironmentClosing: false,
        },
    };
    const rows = {
        'file-pins': f.filePins,
        'created-process': createdProcess,
        'normal-quit': normalQuit,
        'owned-release': ownedRelease,
    };
    const buffers = Object.fromEntries(
        Object.entries(rows).map(([role, value]) => [role, encoded(value)]),
    );
    const records = Object.fromEntries(
        Object.entries(buffers).map(([role, bytes]) => [
            role,
            {
                path: 'windows-native/owned-runtime/' + role + '.json',
                bytes: bytes.length,
                sha256: sha(bytes),
            },
        ]),
    );
    const observation = {
        kind: 'windows-native-owned-runtime/v1',
        binding: structuredClone(f.binding),
        filePins: f.filePins,
        createdProcess,
        normalQuit,
        ownedRelease,
        records,
    };
    const item = { id: f.binding.caseId, evidence: Object.values(records) };
    return {
        ...f,
        requestedLaunch,
        tuple,
        createdProcess,
        normalQuit,
        ownedRelease,
        rows,
        buffers,
        records,
        observation,
        item,
    };
}

test('Windows owned four-row semantic data stays partial and reads exactly the named originals', async () => {
    const f = ownedFixture();
    inspectWindowsNativeOwnedRows(
        f.filePins,
        f.createdProcess,
        f.normalQuit,
        f.ownedRelease,
        f.binding,
    );
    assert.equal(
        inspectWindowsNativeOwnedLifecycle(f.observation, f.item, f.expected),
        'selected-pinned-runtime-and-component-closure-consistent-unqualified',
    );
    const reads: string[] = [];
    await readWindowsNativeOwnedRecords(f.observation, async (name: string, maximum: number) => {
        reads.push(name);
        const role = name.split('/').at(-1)!.replace('.json', '') as keyof typeof f.buffers;
        assert.equal(maximum, role === 'owned-release' ? 8192 : 16384);
        return Buffer.from(f.buffers[role]);
    });
    assert.deepEqual(
        reads,
        Object.keys(f.rows).map((role) => 'windows-native/owned-runtime/' + role + '.json'),
    );
    assert.equal(f.normalQuit.observation.releaseAcceptance, false);
    assert.equal(f.ownedRelease.observation.processOwnership, false);
});

test('Windows owned rows reject mismatched binding profile PID context and component closure without promotion', () => {
    for (const change of [
        (f: ReturnType<typeof ownedFixture>) => {
            f.normalQuit.binding.runId = '999';
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.createdProcess.binding.sourceTree = 'f'.repeat(40);
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.ownedRelease.binding.package.sha256 = '0'.repeat(64);
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.normalQuit.requestedLaunch.profile = f.binding.root + '\\other';
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.normalQuit.createdProcess.pid++;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.ownedRelease.createdProcess.creationTime100ns = '2';
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.normalQuit.identity.type = 'renderer';
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.normalQuit.identity.pid++;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.normalQuit.observation.stdoutEOF = false;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.normalQuit.observation.closedUnacknowledgedReplies = 1;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.createdProcess.observation.processExitObserved = false;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.ownedRelease.observation.hostLifetimeFinalizerAcknowledged = false;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.ownedRelease.observation.retainedUnknown = true;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.ownedRelease.observation.processOwnership = true;
        },
    ]) {
        const f = ownedFixture();
        change(f);
        assert.throws(() =>
            inspectWindowsNativeOwnedRows(
                f.filePins,
                f.createdProcess,
                f.normalQuit,
                f.ownedRelease,
                f.binding,
            ),
        );
    }
});

test('Windows owned evidence requires exact four roles unique references and canonical original byte readback', async () => {
    for (const change of [
        (f: ReturnType<typeof ownedFixture>) => {
            delete (f.observation.records as any)['normal-quit'];
        },
        (f: ReturnType<typeof ownedFixture>) => {
            (f.observation.records as any).extra = f.records['file-pins'];
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.records['owned-release'].path = '../owned-release.json';
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.records['normal-quit'].path = f.records['file-pins'].path;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.records['owned-release'].sha256 = f.records['normal-quit'].sha256;
        },
        (f: ReturnType<typeof ownedFixture>) => {
            f.item.evidence.pop();
        },
    ]) {
        const f = ownedFixture();
        change(f);
        assert.throws(() => inspectWindowsNativeOwnedLifecycle(f.observation, f.item, f.expected));
    }
    for (const mode of ['changed-bytes', 'honest-rehash', 'noncanonical', 'duplicate-json-key']) {
        const f = ownedFixture();
        let bytes = Buffer.from(f.buffers['normal-quit']);
        if (mode === 'noncanonical')
            bytes = Buffer.from(JSON.stringify(f.normalQuit, null, 2) + '\n');
        else if (mode === 'duplicate-json-key')
            bytes = Buffer.from(
                JSON.stringify(f.normalQuit).slice(0, -1) + ',"schemaVersion":1}\n',
            );
        else bytes = encoded({ ...f.normalQuit, extra: true });
        if (mode !== 'changed-bytes') {
            f.records['normal-quit'].bytes = bytes.length;
            f.records['normal-quit'].sha256 = sha(bytes);
        }
        await assert.rejects(
            readWindowsNativeOwnedRecords(f.observation, async (name: string) =>
                name.endsWith('/normal-quit.json')
                    ? bytes
                    : Buffer.from(
                          f.buffers[
                              name.split('/').at(-1)!.replace('.json', '') as keyof typeof f.buffers
                          ],
                      ),
            ),
        );
    }
});

test('Windows owned original readback snapshots projection before asynchronous caller mutation', async () => {
    const f = ownedFixture();
    let first = true;
    const reads: string[] = [];
    await readWindowsNativeOwnedRecords(f.observation, async (name: string) => {
        reads.push(name);
        if (first) {
            first = false;
            f.observation.normalQuit.identity.pid++;
            f.observation.binding.root = 'C:\\changed';
        }
        const role = name.split('/').at(-1)!.replace('.json', '') as keyof typeof f.buffers;
        return Buffer.from(f.buffers[role]);
    });
    assert.equal(reads.length, 4);
    assert.equal(f.observation.normalQuit.identity.pid, 322);
    assert.equal(JSON.parse(f.buffers['normal-quit'].toString()).identity.pid, 321);
});

test('Windows owned shared-consumer branch rereads originals but refuses honestly rehashed qualification claims', async () => {
    const f = ownedFixture();
    const envelope = {
        schemaVersion: 1,
        kind: 'installer-case-observation',
        version: f.expected.version,
        sourceCommit: f.expected.sourceCommit,
        sourceTree: f.expected.sourceTree,
        runId: f.expected.runId,
        runAttempt: f.expected.runAttempt,
        lane: f.expected.lane,
        caseId: f.binding.caseId,
        package: f.binding.package,
        observation: f.observation,
    };
    const bytes = encoded(envelope),
        ref = {
            path: 'cases/windows-nsis/offline-launch.json',
            bytes: bytes.length,
            sha256: sha(bytes),
        };
    const files = new Map([
        [ref.path, bytes],
        ...Object.entries(f.buffers).map(
            ([role, bytes]) =>
                ['windows-native/owned-runtime/' + role + '.json', bytes] as [string, Buffer],
        ),
    ]);
    const reads: string[] = [];
    const summary = await consumeInstallerLifecycleEvidence(
        {
            schemaVersion: 2,
            kind: 'native-installer-lifecycle',
            runId: f.expected.runId,
            runAttempt: f.expected.runAttempt,
            cases: [
                {
                    id: f.binding.caseId,
                    lifecycleEvidence: ref,
                    evidence: [ref, ...f.item.evidence],
                },
            ],
        },
        f.expected,
        async (name: string, maximum: number) => {
            reads.push(name);
            const bytes = files.get(name)!;
            assert.ok(bytes.length <= maximum);
            return Buffer.from(bytes);
        },
    );
    assert.deepEqual(summary, {
        status: 'installer-lifecycle-unqualified',
        releaseAcceptance: false,
        observations: [
            {
                caseId: f.binding.caseId,
                status: 'selected-pinned-runtime-and-component-closure-consistent-unqualified',
            },
        ],
    });
    assert.deepEqual(reads, [ref.path, ...Object.values(f.records).map((record) => record.path)]);
    for (const role of ['created-process', 'normal-quit', 'owned-release'] as const)
        for (const field of [
            'physicalLoadedBytesVerified',
            'physicalDescendantClosure',
            'releaseAcceptance',
        ]) {
            const copy = ownedFixture();
            (copy.rows[role].observation as any)[field] = true;
            copy.buffers[role] = encoded(copy.rows[role]);
            copy.records[role].bytes = copy.buffers[role].length;
            copy.records[role].sha256 = sha(copy.buffers[role]);
            const changedBytes = encoded({ ...envelope, observation: copy.observation });
            const changedRef = {
                path: ref.path,
                bytes: changedBytes.length,
                sha256: sha(changedBytes),
            };
            const changedFiles = new Map([
                [changedRef.path, changedBytes],
                ...Object.entries(copy.buffers).map(
                    ([name, bytes]) =>
                        ['windows-native/owned-runtime/' + name + '.json', bytes] as [
                            string,
                            Buffer,
                        ],
                ),
            ]);
            await assert.rejects(
                consumeInstallerLifecycleEvidence(
                    {
                        schemaVersion: 2,
                        kind: 'native-installer-lifecycle',
                        runId: copy.expected.runId,
                        runAttempt: copy.expected.runAttempt,
                        cases: [
                            {
                                id: copy.binding.caseId,
                                lifecycleEvidence: changedRef,
                                evidence: [changedRef, ...Object.values(copy.records)],
                            },
                        ],
                    },
                    copy.expected,
                    async (name: string) => Buffer.from(changedFiles.get(name)!),
                ),
            );
            assert.throws(() =>
                inspectWindowsNativeOwnedRows(
                    copy.filePins,
                    copy.createdProcess,
                    copy.normalQuit,
                    copy.ownedRelease,
                    copy.binding,
                ),
            );
        }
    const broken = ownedFixture();
    (broken.normalQuit as any).kind = 'windows-native-readonly-consistency/v1';
    assert.throws(() =>
        inspectWindowsNativeOwnedLifecycle(broken.observation, broken.item, broken.expected),
    );
});

test('Windows owned data cannot issue producer authority and role byte bounds remain fail closed', async () => {
    const f = ownedFixture();
    await assert.rejects(
        produceWindowsNativeOwnedRuntime(f.expected, f.binding, {}),
        /CAPABILITY_UNISSUED/,
    );
    await assert.rejects(
        produceWindowsNativeOwnedRuntime(f.expected, f.binding, f.observation as any),
        /CAPABILITY_UNISSUED/,
    );
    const wrong = { ...f.binding, sourceTree: '0'.repeat(40) };
    await assert.rejects(observeWindowsNativeOwnedRuntime(f.expected, wrong, {})); // Selected tuple rejects before preparation/loader.
    for (const role of Object.keys(f.buffers)) {
        const cap = role === 'owned-release' ? 8192 : 16384;
        await assert.rejects(
            readWindowsNativeOwnedRecords(f.observation, async (name: string) =>
                name === 'windows-native/owned-runtime/' + role + '.json'
                    ? Buffer.alloc(cap + 1)
                    : Buffer.from(
                          f.buffers[
                              name.split('/').at(-1)!.replace('.json', '') as keyof typeof f.buffers
                          ],
                      ),
            ),
        );
    }
});

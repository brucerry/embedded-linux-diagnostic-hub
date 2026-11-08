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

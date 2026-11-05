import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import {
    produceWebArchive,
    readStableArtifactFile,
    validateWebArchiveBuildRecord,
    parseWebArchiveBuildRecord,
} from '../scripts/lib/web-archive-producer.mjs';
import { gitObjectID, sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';

function fixture() {
    const files = new Map([
        ['package.json', Buffer.from('{"version":"0.6.0"}')],
        ['vite.config.mts', Buffer.from('synthetic frozen shipping configuration')],
    ]);
    const objects = new Map<string, any>();
    const object = (type: string, bytes: Buffer) => {
        const oid = gitObjectID(type, bytes);
        objects.set(oid, { oid, type, bytes });
        return oid;
    };
    const index = [...files].map(([path, bytes]) => ({
        path,
        mode: '100644',
        oid: object('blob', bytes),
        stage: 0,
    }));
    const sourceTree = object(
        'tree',
        Buffer.concat(
            index.map((file) =>
                Buffer.concat([
                    Buffer.from('100644 ' + file.path + '\0'),
                    Buffer.from(file.oid, 'hex'),
                ]),
            ),
        ),
    );
    const sourceCommit = object(
        'commit',
        Buffer.from(
            `tree ${sourceTree}\nauthor Synthetic <test@example.invalid> 0 +0000\ncommitter Synthetic <test@example.invalid> 0 +0000\n\nSynthetic build input.\n`,
        ),
    );
    let observations = 0;
    const provider = {
        async state() {
            observations++;
            return { sourceCommit, sourceTree, index: structuredClone(index) };
        },
        async objects(ids: string[]) {
            return ids.map((id) => ({
                ...objects.get(id),
                bytes: Buffer.from(objects.get(id).bytes),
            }));
        },
        async entries() {
            return [...files.keys()].map((name) => ({ name, kind: 'file' }));
        },
        async file(path: string) {
            return { mode: '100644', bytes: Buffer.from(files.get(path)!) };
        },
    };
    const context = {
        scope: 'web',
        version: '0.6.0',
        sourceCommit,
        sourceTree,
        runId: '123',
        runAttempt: '1',
        jobKey: 'web_archive',
    };
    const output = new Map(
        ['index.html', 'capture-download-sw.js', 'capture-download-frame.js', 'assets/main.js'].map(
            (name) => [name, Buffer.from('synthetic compiled ' + name)],
        ),
    );
    const calls: string[] = [],
        archives = new Map<string, Buffer>();
    let record: any;
    const build = {
        pid: 123,
        exitCode: 0,
        signal: null,
        error: null,
        command: [
            '/synthetic/node',
            '/synthetic/vite/bin/vite.js',
            'build',
            '--config',
            '/synthetic/vite.config.mts',
            '--mode',
            'web',
            '--outDir',
            '/synthetic/validation/new/site',
        ],
        environment: { NODE_ENV: 'production', WEB_BASE_PATH: './' },
        custody: {
            policy: 'owned-direct-child-no-signals-v1',
            bounds: {
                deadlineMs: 600000,
                stdoutBytes: 16777216,
                stderrBytes: 1048576,
                chunksPerStream: 4096,
            },
            spawn: true,
            exit: true,
            childClose: true,
            elapsedMs: 0,
            descendantRetirement: 'not-observed',
            stdout: {
                bytes: 0,
                closed: true,
                sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
            stderr: {
                bytes: 0,
                closed: true,
                sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
        },
    };
    const builder = {
        runtime: {
            executablePath: '/synthetic/node',
            executableSHA256: 'a'.repeat(64),
            node: 'v24.19.0',
            platform: 'linux',
            arch: 'x64',
            versions: { node: '24.19.0' },
            execArgv: [],
            nodeOptions: null,
        },
        viteEntryPath: '/synthetic/vite/bin/vite.js',
        viteEntrySHA256: 'b'.repeat(64),
    };
    const io = {
        async packageJSON() {
            calls.push('package');
            return files.get('package.json')!;
        },
        async builder() {
            calls.push('builder');
            return structuredClone(builder);
        },
        async build() {
            calls.push('build');
            return structuredClone(build);
        },
        async output() {
            calls.push('output');
            return new Map([...output].map(([name, bytes]) => [name, Buffer.from(bytes)]));
        },
        async writeArchive(name: string, bytes: Buffer) {
            calls.push('archive');
            assert.ok(!archives.has(name));
            archives.set(name, bytes);
            return { name, bytes: bytes.length, sha256: sourceDigest(bytes) };
        },
        async writeChecksum(name: string, bytes: Buffer) {
            calls.push('checksum');
            return { name, bytes: bytes.length, sha256: sourceDigest(bytes) };
        },
        async writeRecord(value: any, bytes: Buffer) {
            calls.push('record');
            record = value;
            assert.equal(bytes.toString(), JSON.stringify(value) + '\n');
            return { name: 'web-build.json', bytes: bytes.length, sha256: sourceDigest(bytes) };
        },
    };
    return {
        context,
        provider,
        io,
        files,
        output,
        calls,
        archives,
        build,
        builder,
        get record() {
            return record;
        },
        get observations() {
            return observations;
        },
    };
}

test('actual-source producer encodes the complete captured payload and binds source, build, observer and written bytes', async () => {
    const f = fixture(),
        result = await produceWebArchive(f.context, f.provider, f.io);
    assert.equal(result.kind, 'web-source-build-archive');
    assert.equal(result.status, 'built');
    assert.equal(result.context.sourceCommit, f.context.sourceCommit);
    assert.equal(result.context.sourceTree, f.context.sourceTree);
    assert.equal(
        result.sourceBridgeSHA256,
        sourceDigest(JSON.stringify(result.sourceBridge) + '\n'),
    );
    assert.deepEqual(result.build.command, f.build.command);
    assert.deepEqual(result.builder, f.builder);
    assert.ok(f.observations >= 12);
    assert.equal(result.archive.name, 'Diagnostic-Hub-Web-0.6.0.zip');
    const bytes = f.archives.get(result.archive.name)!;
    assert.equal(result.archive.sha256, sourceDigest(bytes));
    assert.equal(result.checksum.name, result.archive.name + '.sha256');
    assert.equal(
        result.checksum.sha256,
        sourceDigest(`${result.archive.sha256}  ${result.archive.name}\n`),
    );
    const decoded = unzipSync(bytes);
    assert.deepEqual(Object.keys(decoded).sort(), [...f.output.keys()].sort());
    for (const [name, data] of f.output) assert.deepEqual(Buffer.from(decoded[name]), data);
    assert.deepEqual(
        [result.productRuntime, result.loaderProvenance, result.normalGC, result.forcedGC],
        [null, null, null, null],
    );
    assert.equal(result.releaseAcceptance, false);
    assert.equal(f.record, result);
});

test('Gateway and malformed independent pins refuse all build and write callbacks', async () => {
    for (const update of [
        { scope: 'gateway' },
        { sourceCommit: 'wrong' },
        { sourceTree: 'wrong' },
        { runId: '' },
        { runAttempt: '0' },
        { jobKey: '' },
    ]) {
        const f = fixture();
        await assert.rejects(produceWebArchive({ ...f.context, ...update }, f.provider, f.io));
        assert.deepEqual(f.calls, []);
        assert.equal(f.observations, 0);
    }
});

test('version and captured package identity cannot borrow another source pin', async () => {
    const f = fixture();
    f.io.packageJSON = async () => Buffer.from('{"version":"0.6.0","foreign":true}');
    await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
    assert.ok(!f.calls.includes('build'));
    assert.equal(f.archives.size, 0);
    const g = fixture();
    await assert.rejects(produceWebArchive({ ...g.context, version: '0.6.1' }, g.provider, g.io));
    assert.ok(!g.calls.includes('build'));
});

for (const update of [
    { exitCode: 1 },
    { exitCode: null },
    { signal: 'SIGTERM' },
    { error: 'synthetic failure' },
    { pid: 0 },
    { command: ['/unrelated'] },
])
    test(
        'unacknowledged or foreign build result refuses output and publication: ' +
            JSON.stringify(update),
        async () => {
            const f = fixture();
            Object.assign(f.build, update);
            await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
            assert.ok(!f.calls.includes('output'));
            assert.equal(f.archives.size, 0);
            assert.equal(f.record, undefined);
        },
    );

test('pending build holds admission before any output is collected', async () => {
    const f = fixture();
    let admit!: (value: any) => void;
    f.io.build = () => {
        f.calls.push('build');
        return new Promise((resolve) => {
            admit = resolve;
        });
    };
    const task = produceWebArchive(f.context, f.provider, f.io);
    for (let i = 0; i < 100 && !admit; i++) await Promise.resolve();
    assert.ok(admit);
    assert.ok(!f.calls.includes('output'));
    assert.equal(f.record, undefined);
    admit(f.build);
    await task;
});

for (const stage of ['during-build', 'after-archive'])
    test('changed source ' + stage + ' cannot finish a build record', async () => {
        const f = fixture(),
            mutate = () => f.files.set('package.json', Buffer.from('dirty source'));
        if (stage === 'during-build') {
            const build = f.io.build;
            f.io.build = async () => {
                const result = await build();
                mutate();
                return result;
            };
        } else {
            const write = f.io.writeArchive;
            f.io.writeArchive = async (...args) => {
                const result = await write(...args);
                mutate();
                return result;
            };
        }
        await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
        assert.equal(f.record, undefined);
        assert.equal(f.archives.size, stage === 'during-build' ? 0 : 1);
    });

test('changed outputs or builder identity before publication cannot produce a record', async () => {
    for (const mode of ['outputs', 'builder']) {
        const f = fixture();
        let reads = 0;
        if (mode === 'outputs') {
            const read = f.io.output;
            f.io.output = async () => {
                const value = await read();
                if (++reads === 2) value.set('index.html', Buffer.from('changed'));
                return value;
            };
        } else {
            const read = f.io.builder;
            f.io.builder = async () => {
                const value = await read();
                if (++reads === 2) value.viteEntrySHA256 = 'c'.repeat(64);
                return value;
            };
        }
        await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
        assert.equal(f.archives.size, 0);
        assert.equal(f.record, undefined);
    }
});

test('unsafe, missing and aliased payload names cannot become archive members', async () => {
    for (const mode of [
        'missing-entry',
        '../outside',
        '/absolute',
        'Index.html',
        'assets',
        'bad\\name',
        'bad:name',
        'CON.txt',
    ]) {
        const f = fixture();
        if (mode === 'missing-entry') f.output.delete('capture-download-sw.js');
        else f.output.set(mode, Buffer.from('synthetic'));
        await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
        assert.equal(f.archives.size, 0);
    }
});

test('wrong written archive or lost build-record acknowledgement never becomes a completed record', async () => {
    const f = fixture(),
        write = f.io.writeArchive;
    f.io.writeArchive = async (...args) => ({ ...(await write(...args)), sha256: 'f'.repeat(64) });
    await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
    assert.equal(f.record, undefined);
    assert.equal(f.archives.size, 1);
    const g = fixture(),
        failure = Error('synthetic record failure');
    g.io.writeRecord = async () => {
        throw failure;
    };
    await assert.rejects(
        produceWebArchive(g.context, g.provider, g.io),
        (error) => error === failure,
    );
    assert.equal(g.archives.size, 1);
    assert.equal(g.calls.filter((call) => call === 'build').length, 1);
});

for (const mode of ['output', 'builder', 'record-readback'])
    test(
        'post-write ' + mode + ' mismatch preserves archive without acknowledged success',
        async () => {
            const f = fixture(),
                write = f.io.writeArchive;
            f.io.writeArchive = async (...args) => {
                const value = await write(...args);
                if (mode === 'output')
                    f.output.set('index.html', Buffer.from('changed after write'));
                if (mode === 'builder') f.builder.viteEntrySHA256 = 'd'.repeat(64);
                return value;
            };
            if (mode === 'record-readback') {
                const record = f.io.writeRecord;
                f.io.writeRecord = async (...args) => ({
                    ...(await record(...args)),
                    sha256: '0'.repeat(64),
                });
            }
            await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
            assert.equal(f.archives.size, 1);
            if (mode !== 'record-readback') assert.equal(f.record, undefined);
        },
    );

test('pending record acknowledgement cannot settle the producer promise', async () => {
    const f = fixture();
    let acknowledge!: () => void,
        complete = false;
    f.io.writeRecord = async (record, bytes) => {
        f.calls.push('record');
        await new Promise<void>((resolve) => {
            acknowledge = resolve;
        });
        return { name: 'web-build.json', bytes: bytes.length, sha256: sourceDigest(bytes) };
    };
    const task = produceWebArchive(f.context, f.provider, f.io).then((value) => {
        complete = true;
        return value;
    });
    for (let i = 0; i < 500 && !acknowledge; i++) await Promise.resolve();
    assert.ok(acknowledge);
    assert.equal(complete, false);
    assert.equal(f.archives.size, 1);
    acknowledge();
    await task;
    assert.equal(complete, true);
});

test('wrong checksum acknowledgement refuses the build record while preserving the written archive', async () => {
    const f = fixture();
    f.io.writeChecksum = async (name, bytes) => ({
        name,
        bytes: bytes.length,
        sha256: '0'.repeat(64),
    });
    await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
    assert.equal(f.archives.size, 1);
    assert.equal(f.record, undefined);
});

test('a source change during checksum publication refuses the final build-record handoff', async () => {
    const f = fixture(),
        write = f.io.writeChecksum;
    f.io.writeChecksum = async (...args) => {
        const value = await write(...args);
        f.files.set('package.json', Buffer.from('late dirty source'));
        return value;
    };
    await assert.rejects(produceWebArchive(f.context, f.provider, f.io));
    assert.equal(f.archives.size, 1);
    assert.equal(f.record, undefined);
});

function memoryFile() {
    const state = {
        bytes: Buffer.from('exact bytes'),
        symlink: false,
        nlink: 1,
        changed: false,
        mutateDuringRead: false,
        closed: false,
        closeFailure: null as Error | null,
        readFailure: null as Error | null,
    };
    const stat = () => ({
        isFile: () => true,
        isSymbolicLink: () => state.symlink,
        nlink: state.nlink,
        dev: 1,
        ino: state.changed ? 2 : 1,
        mode: 0o100644,
        size: state.bytes.length,
        mtimeMs: 1,
        ctimeMs: 1,
    });
    const before = stat();
    let at = 0;
    const fs = {
        async realpath(file: string) {
            return file;
        },
        async lstat() {
            return stat();
        },
        async open() {
            return {
                async stat() {
                    return stat();
                },
                async read(buffer: Buffer, offset: number, length: number) {
                    if (state.readFailure) throw state.readFailure;
                    const n = Math.min(length, state.bytes.length - at);
                    state.bytes.copy(buffer, offset, at, at + n);
                    at += n;
                    if (state.mutateDuringRead) state.changed = true;
                    return { bytesRead: n };
                },
                async close() {
                    state.closed = true;
                    if (state.closeFailure) throw state.closeFailure;
                },
            };
        },
    };
    return { state, fs };
}

test('stable artifact reads retain bytes and acknowledge close with memory-only handles', async () => {
    const f = memoryFile();
    assert.deepEqual(
        (await readStableArtifactFile('/synthetic', 'file', 100, f.fs)).bytes,
        f.state.bytes,
    );
    assert.equal(f.state.closed, true);
});

test('artifact aliases, size changes and close failures cannot produce observed bytes', async () => {
    for (const mode of ['symlink', 'hardlink', 'oversize', 'changed', 'close']) {
        const f = memoryFile();
        if (mode === 'symlink') f.state.symlink = true;
        if (mode === 'hardlink') f.state.nlink = 2;
        if (mode === 'changed') f.state.mutateDuringRead = true;
        if (mode === 'close') f.state.closeFailure = Error('close');
        await assert.rejects(
            readStableArtifactFile('/synthetic', 'file', mode === 'oversize' ? 1 : 100, f.fs),
        );
    }
    const f = memoryFile(),
        primary = Error('read'),
        cleanup = Error('close');
    f.state.readFailure = primary;
    f.state.closeFailure = cleanup;
    await assert.rejects(
        readStableArtifactFile('/synthetic', 'file', 100, f.fs),
        (error: any) =>
            error instanceof AggregateError &&
            error.cause === primary &&
            error.errors[1] === cleanup,
    );
});

test('held CLI uses only fixed shipping config, new output paths and exclusive writes; it is not run', async () => {
    const source = await readFile('scripts/produce-web-archive.mjs', 'utf8');
    assert.match(source, /await fs\.mkdir\(directory\)/);
    assert.match(source, /await fs\.mkdir\(site\)/);
    assert.match(
        source,
        /\[\s*await fs\.realpath\(process\.execPath\),\s*vite,\s*'build',\s*'--config'/,
    );
    assert.match(source, /startOwnedWebBuild/);
    assert.doesNotMatch(source, /spawnSync|stdio: 'inherit'/);
    assert.equal((source.match(/flag: 'wx'/g) || []).length, 3);
    assert.doesNotMatch(source, /fs\.(rm|unlink|chmod|chown)|--no-sandbox|npm.*install/);
});

test('build-record schema retains missing qualification and rejects relabeling, source/run swaps and malformed references', async () => {
    const f = fixture(),
        record = await produceWebArchive(f.context, f.provider, f.io);
    assert.equal(validateWebArchiveBuildRecord(record, f.context), record);
    for (const change of [
        { status: 'passed' },
        { releaseAcceptance: true },
        { productRuntime: {} },
        { loaderProvenance: {} },
        { normalGC: { status: 'passed' } },
        { forcedGC: { status: 'passed' } },
        { sourceBridgeSHA256: '0'.repeat(64) },
        { unexpected: true },
        { archive: { ...record.archive, name: 'foreign.zip' } },
        { checksum: { ...record.checksum, sha256: '0'.repeat(64) } },
        { build: { ...record.build, exitCode: 1 } },
    ])
        assert.throws(() => validateWebArchiveBuildRecord({ ...record, ...change }, f.context));
    assert.throws(() => validateWebArchiveBuildRecord(record, { ...f.context, runId: '456' }));
    assert.throws(() =>
        validateWebArchiveBuildRecord(record, { ...f.context, sourceTree: 'e'.repeat(40) }),
    );
    const duplicate = { ...record, payload: [...record.payload, record.payload[0]] };
    assert.throws(() => validateWebArchiveBuildRecord(duplicate, f.context));
});

test('build-record byte reader rejects BOM, duplicate keys, malformed UTF8 and partial/noncanonical JSON', async () => {
    const f = fixture(),
        record = await produceWebArchive(f.context, f.provider, f.io),
        text = JSON.stringify(record) + '\n';
    assert.deepEqual(parseWebArchiveBuildRecord(Buffer.from(text), f.context), record);
    for (const bytes of [
        Buffer.from('\ufeff' + text),
        Buffer.from(text + '\n'),
        Buffer.from(text.replace('{"schemaVersion":1,', '{"schemaVersion":1,"schemaVersion":1,')),
        Buffer.concat([Buffer.from([255]), Buffer.from(text)]),
        Buffer.from(text.slice(0, -2)),
    ])
        assert.throws(() => parseWebArchiveBuildRecord(bytes, f.context));
});

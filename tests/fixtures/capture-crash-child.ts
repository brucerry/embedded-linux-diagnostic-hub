import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ownFixtureChild } from './owned-fixture-child';

// This reviewed closure is compiled before the crash child starts. No runtime TS loader,
// package resolution, compiler service or child-process module enters that child.
const inputs = [
    'tests/fixtures/capture-store-crash.ts',
    'electron/capture-store.ts',
    'electron/capture-catalog.ts',
    'electron/physical-fs.ts',
    'shared/capture-store.ts',
    'shared/capture-writer.ts',
    'shared/capture-query.ts',
    'shared/capture-search.ts',
    'shared/automation-result.ts',
    'shared/automation-time.ts',
    'shared/automation.ts',
    'shared/ssh-console.ts',
];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function bounded(file: string, limit: number) {
    const before = await fs.lstat(file);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= limit);
    const handle = await fs.open(file, 'r');
    try {
        const identity = (value: typeof before) => [
            value.dev,
            value.ino,
            value.mode,
            value.size,
            value.mtimeMs,
            value.ctimeMs,
        ];
        assert.deepEqual(identity(await handle.stat()), identity(before));
        const bytes = Buffer.alloc(before.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        assert.equal(offset, before.size);
        assert.deepEqual(identity(await handle.stat()), identity(before));
        assert.deepEqual(identity(await fs.lstat(file)), identity(before));
        return bytes.subarray(0, offset);
    } finally {
        await handle.close();
    }
}

/** Prepare only in the exact fresh test profile. Every returned child retirement is retained. */
export async function prepareCaptureCrash(
    profile: string,
    retain: (retired: Promise<void>) => void,
) {
    assert.equal(process.versions.electron, undefined);
    assert.equal(Number(process.versions.node.split('.')[0]), 24);
    assert.equal(await fs.realpath(profile), profile);
    assert.equal(path.dirname(profile), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('hub-index-lifecycle-'));
    const root = await fs.realpath(process.cwd());
    const load = createRequire(path.join(root, 'package.json'));
    const lock = JSON.parse(
        (await bounded(path.join(root, 'package-lock.json'), 1024 * 1024)).toString(),
    );
    const native = `@esbuild/${process.platform}-${process.arch}`;
    const version = lock.packages['node_modules/esbuild'].version;
    assert.equal(lock.packages['node_modules/' + native]?.version, version);
    const nativePackage = load.resolve(native + '/package.json');
    const nativeData = JSON.parse((await bounded(nativePackage, 65536)).toString());
    assert.equal(nativeData.name, native);
    assert.equal(nativeData.version, version);
    assert.equal(
        JSON.parse((await bounded(load.resolve('esbuild/package.json'), 65536)).toString()).version,
        version,
    );
    const binary = path.join(
        path.dirname(nativePackage),
        process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
    );
    assert.equal(await fs.realpath(binary), binary);
    const binaryHash = sha(await bounded(binary, 32 * 1024 * 1024));
    const node = await fs.realpath(process.execPath);
    const nodeHash = sha(await bounded(node, 128 * 1024 * 1024));
    const frozen = new Map<string, string>();
    for (const name of inputs)
        frozen.set(name, sha(await bounded(path.join(root, name), 1024 * 1024)));
    // Keep compiler outputs for diagnosis; profile cleanup removes only synthetic captures.
    const directory = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), 'hub-capture-crash-build-'),
    );
    const output = path.join(directory, 'fixture.cjs'),
        metadata = path.join(directory, 'meta.json');
    const env: NodeJS.ProcessEnv = {
        PATH: path.dirname(node),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        GOMAXPROCS: '2',
    };
    // Preserve these selectors when present; inherit no loader, credentials or shell hooks.
    for (const key of ['HOME', 'SystemRoot', 'WINDIR'])
        if (process.env[key] !== undefined) env[key] = process.env[key];
    const compiler = ownFixtureChild(
        () =>
            spawn(
                binary,
                [
                    inputs[0],
                    '--bundle',
                    '--platform=node',
                    '--format=cjs',
                    '--target=node24',
                    '--outfile=' + output,
                    '--metafile=' + metadata,
                    '--log-level=warning',
                ],
                { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
            ),
        { timeoutMs: 30000 },
    );
    retain(compiler.retired);
    const built = await compiler.done;
    assert.equal(built.code, 0);
    assert.equal(built.signal, null);
    const bytes = await bounded(output, 2 * 1024 * 1024);
    const meta = JSON.parse((await bounded(metadata, 128 * 1024)).toString());
    assert.ok(meta.inputs[inputs[0]]);
    for (const [name, value] of Object.entries(meta.inputs) as [string, { bytes: number }][]) {
        assert.ok(frozen.has(name), 'Unreviewed crash fixture input: ' + name);
        const source = await bounded(path.join(root, name), 1024 * 1024);
        assert.equal(value.bytes, source.length);
        assert.equal(sha(source), frozen.get(name));
    }
    const outputs = Object.values(meta.outputs) as {
        entryPoint: string;
        imports: { path: string; external: boolean }[];
    }[];
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].entryPoint, inputs[0]);
    for (const entry of outputs[0].imports)
        assert.ok(
            entry.external &&
                ['node:fs/promises', 'node:fs', 'node:path', 'node:crypto', 'node:module'].includes(
                    entry.path,
                ),
            'Unreviewed emitted crash dependency.',
        );
    const artifactHash = sha(bytes);
    async function unchanged() {
        for (const [name, pin] of frozen)
            assert.equal(sha(await bounded(path.join(root, name), 1024 * 1024)), pin);
        assert.equal(sha(await bounded(binary, 32 * 1024 * 1024)), binaryHash);
        assert.equal(sha(await bounded(node, 128 * 1024 * 1024)), nodeHash);
        assert.equal(sha(await bounded(output, 2 * 1024 * 1024)), artifactHash);
    }
    await unchanged();
    let used = false,
        observation: ReturnType<ReturnType<typeof ownFixtureChild>['snapshot']> | undefined;
    return {
        identity: {
            artifactHash,
            binaryHash,
            nodeHash,
            compilerVersion: version,
            inputs: [...frozen],
            output,
            metadata,
        },
        get observation() {
            return observation;
        },
        async crash(mode: 'write' | 'delete', id?: string) {
            assert.equal(used, false, 'One compiled fixture activation only.');
            used = true;
            assert.ok(mode === 'write' || mode === 'delete');
            if (mode === 'delete') assert.match(id ?? '', /^[0-9a-f-]{36}$/);
            else assert.equal(id, undefined);
            await unchanged();
            const owned = ownFixtureChild(
                () =>
                    spawn(node, [output, profile, mode, ...(id ? [id] : [])], {
                        cwd: directory,
                        env,
                        stdio: ['ignore', 'pipe', 'pipe'],
                        windowsHide: true,
                    }),
                { timeoutMs: 15000 },
            );
            retain(owned.retired);
            let message: Record<string, unknown> | undefined;
            const errors: unknown[] = [];
            try {
                message = JSON.parse(await owned.firstLine);
                assert.ok(message && typeof message === 'object' && !Array.isArray(message));
                assert.match(String(message.id), /^[0-9a-f-]{36}$/);
                if (mode === 'write') {
                    assert.deepEqual(Object.keys(message).sort(), ['id', 'raw', 'stage']);
                    assert.equal(message.stage, 'committed-prefix-and-uncommitted-tail');
                    assert.ok(typeof message.raw === 'string');
                    assert.ok(message.raw.length <= 65536);
                } else {
                    assert.deepEqual(Object.keys(message).sort(), ['id', 'removed', 'stage']);
                    assert.equal(message.stage, 'explicit-deletion-partial');
                    assert.equal(message.id, id);
                    assert.equal(message.removed, 1);
                }
                owned.stop();
                const result = await owned.done;
                observation = owned.snapshot();
                assert.equal(result.code, null);
                assert.equal(result.signal, 'SIGKILL');
            } catch (error) {
                errors.push(error);
            } finally {
                owned.stop();
                try {
                    await owned.done;
                } catch (error) {
                    if (!errors.includes(error)) errors.push(error);
                }
            }
            if (errors.length) throw new AggregateError(errors, 'Capture crash fixture failed.');
            assert.ok(message);
            return message;
        },
    };
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspectInnerArchive } from '../scripts/lib/inner-archive-inspection.mjs';
import { inspectOwnedGatewayTar } from '../scripts/lib/gateway-tar.mjs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { gatewayPackageMemoryHook } from './fixtures/gateway-package-memory-hook';

const script = pathToFileURL(path.resolve('scripts/package-gateway.mjs'));
const packageText = readFileSync('package.json', 'utf8');
const lockText = readFileSync('package-lock.json', 'utf8');
let sequence = 0;
const fileBytes = (value: string | Buffer) =>
    typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);

// Execute the actual shipping script with memory-only filesystem/child ports.
// The committed lock and real projection/validator are used, but no npm, external archiver,
// dependency installation, filesystem archive write or cleanup operation is performed.
async function exercise(
    options: {
        source?: (lock: any) => void;
        prepared?: (lock: any) => void;
        npmStatus?: number;
        invalidJSON?: boolean;
        preparedManifest?: (manifest: any) => void;
        closeError?: boolean;
    } = {},
) {
    const id = ++sequence;
    const key = '__gatewayPackageLockTest' + id;
    const globals = globalThis as typeof globalThis & Record<string, any>;
    const files = new Map<string, string | Buffer>();
    const calls: string[] = [];
    const sourceLock = JSON.parse(lockText);
    options.source?.(sourceLock);
    files.set('package.json', packageText);
    files.set('package-lock.json', JSON.stringify(sourceLock));
    const stage = path.resolve('synthetic-gateway-stage');
    const lockFile = path.join(stage, 'package-lock.json');
    const archiveFile = path.resolve('release/Diagnostic-Hub-Gateway-0.6.0.tar.gz');
    const bytes = (file: string) => fileBytes(files.get(file)!);
    const metadata = (file: string) => ({
        dev: 1,
        ino: 1,
        mode: 0o100644,
        nlink: 1,
        size: bytes(file).length,
        mtimeMs: 0,
        ctimeMs: 0,
        isFile: () => true,
        isSymbolicLink: () => false,
    });
    const ports = {
        readFile: async (file: string) => {
            calls.push('read:' + file);
            assert.ok(files.has(file), 'Unexpected memory read: ' + file);
            return files.get(file);
        },
        writeFile: async (file: string, bytes: string | Buffer) => {
            calls.push(file === archiveFile ? 'archive' : 'write:' + file);
            files.set(file, bytes);
        },
        mkdtemp: async () => {
            calls.push('allocate');
            return stage;
        },
        mkdir: async () => {
            calls.push('mkdir');
        },
        cp: async (file: string, destination: string) => {
            calls.push('copy');
            if (file === 'dist-gateway')
                files.set(
                    path.join(destination, 'main.cjs'),
                    Buffer.from('synthetic compiled CLI bytes'),
                );
            else {
                assert.ok(
                    [
                        '.env.gateway.example',
                        'LICENSE',
                        'gateway/Caddyfile.example',
                        'docs/gateway.md',
                    ].includes(file),
                );
                files.set(destination, readFileSync(file));
            }
        },
        realpath: async (file: string) => file,
        lstat: async (file: string) => metadata(file),
        open: async (file: string, flags: string) => {
            assert.equal(flags, 'r');
            calls.push('open:' + file);
            const value = bytes(file);
            let at = 0;
            return {
                stat: async () => metadata(file),
                read: async (target: Buffer, offset: number, length: number, position: unknown) => {
                    assert.equal(position, null);
                    const bytesRead = Math.min(length, value.length - at);
                    value.copy(target, offset, at, at + bytesRead);
                    at += bytesRead;
                    return { bytesRead };
                },
                close: async () => {
                    calls.push('close:' + file);
                    if (options.closeError) throw Error('synthetic payload close failure');
                },
            };
        },
        rm: async () => {
            calls.push('cleanup');
        },
        tmpdir: () => path.resolve('synthetic-temp'),
        spawnSync: (
            command: string,
            args: string[],
            spawnOptions: {
                cwd?: string;
                encoding?: string;
                shell?: boolean;
            },
        ) => {
            if (command === 'npm' || command === 'npm.cmd') {
                assert.deepEqual(args, [
                    'install',
                    '--package-lock-only',
                    '--ignore-scripts',
                    '--omit=optional',
                    '--no-audit',
                    '--no-fund',
                ]);
                assert.deepEqual(spawnOptions, {
                    cwd: stage,
                    encoding: 'utf8',
                    shell: process.platform === 'win32',
                });
                calls.push('npm');
                const prepared = JSON.parse(String(files.get(lockFile)!));
                options.prepared?.(prepared);
                files.set(lockFile, options.invalidJSON ? '{' : JSON.stringify(prepared));
                if (options.preparedManifest) {
                    const file = path.join(stage, 'package.json');
                    const value = JSON.parse(String(files.get(file)!));
                    options.preparedManifest(value);
                    files.set(file, JSON.stringify(value));
                }
                return { status: options.npmStatus ?? 0, stderr: 'synthetic npm outcome' };
            }
            assert.fail('No external archiver or other child is allowed: ' + command);
        },
    };
    globals[key] = ports;
    let hooks: ReturnType<typeof registerHooks> | undefined;
    let failure: unknown;
    try {
        hooks = registerHooks(gatewayPackageMemoryHook(script.href + '?case=' + id, key, ports));
        await import(script.href + '?case=' + id);
    } catch (error) {
        failure = error;
    } finally {
        hooks?.deregister();
        delete globals[key];
    }
    return { calls, files, lockFile, archiveFile, stage, failure };
}

test('shipping Gateway packager validates the committed dependency closure before archiving', async () => {
    const result = await exercise();
    assert.equal(result.failure, undefined);
    assert.deepEqual(
        result.calls.filter((call) => ['npm', 'archive'].includes(call)),
        ['npm', 'archive'],
    );
    assert.ok(result.calls.indexOf('open:' + result.lockFile) > result.calls.indexOf('npm'));
    assert.ok(result.calls.indexOf('open:' + result.lockFile) < result.calls.indexOf('archive'));
    const archive = fileBytes(result.files.get(result.archiveFile)!);
    const payload = new Map<string, Buffer>();
    for (const name of [
        '.env.gateway.example',
        'LICENSE',
        'README.md',
        'dist-gateway/main.cjs',
        'docs/gateway.md',
        'gateway/Caddyfile.example',
        'package-lock.json',
        'package.json',
    ])
        payload.set(name, fileBytes(result.files.get(path.join(result.stage, name))!));
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const tarInventory = inspectOwnedGatewayTar(gunzipSync(archive), payload);
    const facts = inspectInnerArchive(
        archive,
        {
            archive: { bytes: archive.length, sha256: hash(archive) },
            payload: [...payload]
                .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }))
                .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
            tarInventory,
        },
        'gateway',
    );
    assert.equal(facts.releaseAcceptance, false);
    assert.equal(facts.status, 'matches-producer-inventory-unqualified');
    const prepared = JSON.parse(String(result.files.get(result.lockFile)!));
    assert.deepEqual(Object.keys(prepared.packages).sort(), [
        '',
        'node_modules/asn1',
        'node_modules/bcrypt-pbkdf',
        'node_modules/buildcheck',
        'node_modules/cpu-features',
        'node_modules/nan',
        'node_modules/safer-buffer',
        'node_modules/ssh2',
        'node_modules/tweetnacl',
    ]);
});

for (const [name, mutate] of Object.entries({
    version: (lock: any) => {
        lock.packages['node_modules/ssh2'].version = '1.17.1';
    },
    url: (lock: any) => {
        lock.packages['node_modules/asn1'].resolved = 'https://example.invalid/foreign.tgz';
    },
    integrity: (lock: any) => {
        lock.packages['node_modules/asn1'].integrity = 'sha512-Zm9yZWlnbg==';
    },
    extra: (lock: any) => {
        lock.packages['node_modules/extra'] = lock.packages['node_modules/asn1'];
    },
    optional: (lock: any) => {
        lock.packages['node_modules/ssh2'].optional = true;
    },
    missing: (lock: any) => {
        delete lock.packages['node_modules/asn1'];
    },
    root: (lock: any) => {
        lock.packages[''].version = '0.6.1';
    },
})) {
    test(
        'shipping packager rejects npm ' + name + ' drift before archive publication',
        async () => {
            const result = await exercise({ prepared: mutate });
            assert.ok(result.failure);
            assert.ok(result.calls.includes('npm'));
            assert.ok(!result.calls.includes('archive'));
            assert.equal(result.calls.at(-1), 'cleanup');
        },
    );
}

test('invalid source identity refuses staging and all children', async () => {
    const result = await exercise({
        source: (lock) => {
            lock.version = '0.0.0';
        },
    });
    assert.ok(result.failure);
    assert.ok(!result.calls.includes('allocate'));
    assert.ok(!result.calls.includes('npm'));
    assert.ok(!result.calls.includes('archive'));
});

test('malformed npm lock and unsuccessful npm exit cannot publish an archive', async () => {
    for (const options of [{ invalidJSON: true }, { npmStatus: 1 }]) {
        const result = await exercise(options);
        assert.ok(result.failure);
        assert.ok(!result.calls.includes('archive'));
    }
});

test('captured package manifest drift cannot publish an archive with a valid lock', async () => {
    const result = await exercise({
        preparedManifest: (manifest) => {
            manifest.main = 'other.cjs';
        },
    });
    assert.ok(result.failure);
    assert.ok(!result.calls.includes('archive'));
    assert.equal(result.calls.at(-1), 'cleanup');
});

test('a failed payload descriptor close cannot publish an archive', async () => {
    const result = await exercise({ closeError: true });
    assert.match(String(result.failure), /synthetic payload close failure/);
    assert.ok(!result.calls.includes('archive'));
    assert.equal(result.calls.at(-1), 'cleanup');
});

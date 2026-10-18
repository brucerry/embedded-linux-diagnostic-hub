// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { nativePilotBuildLaunch } from './fixtures/memory-product-native-host';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { ProductLease } from '../scripts/lib/product-collector-files.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { preparePilotStageRuntime, startupBound } from '../scripts/lib/pilot-runtime-startup.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve('tsx')).href;
const runtimeWorker = path.join(root, 'tests/fixtures/native-pilot-runtime-worker.mts');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temporary = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub real entry '));

async function entryControl(kind, incompleteHelperProof = false) {
    assert.equal(process.version, 'v24.22.0');
    assert.equal(process.cwd(), root);
    const packageBytes = fs.readFileSync(path.join(root, 'package.json'));
    const tsconfigBytes = fs.readFileSync(path.join(root, 'tsconfig.json'));
    assert(!Object.hasOwn(JSON.parse(packageBytes), 'type'));
    assert(!fs.existsSync(path.join(root, 'tests/package.json')));
    assert(!fs.existsSync(path.join(root, 'tests/fixtures/package.json')));
    const dir = temporary(),
        outputParent = path.join(dir, 'runtime'),
        report = path.join(dir, 'evidence');
    fs.mkdirSync(outputParent);
    fs.mkdirSync(report);
    const controller = new AbortController(),
        nonce = randomUUID(),
        bindingSHA256 = 'b'.repeat(64);
    const lease = new ProductLease(path.join(dir, 'fixture-marker.lock'), { nonce, bindingSHA256 });
    lease.acquire();
    const journal = new PilotEvidence(report),
        rows = [],
        messages = [],
        argv = [];
    let startup,
        child,
        held,
        raw = '',
        admissionAttempted = false,
        preloadIdentity;
    const hold = (reason) => {
        startup?.stopQueryAdmission();
        if (!held) {
            let referenced = false;
            const actual = createOwnershipHold(
                { reason: String(reason) },
                (s, d) => {
                    assert(referenced);
                    journal.append(s, d);
                },
                {
                    interval: () => ({
                        ref() {
                            referenced = true;
                        },
                    }),
                },
            );
            held = { actual, referenced };
        }
        controller.abort(reason);
        startup?.cancel();
    };
    const emit = async (stage, data) => {
        rows.push({ stage, data });
        journal.append(stage, data);
        if (stage === 'runtime-admission') {
            // The production factory has verified actual creation identity and readiness,
            // but this deliberate receipt refusal withholds the application's GO message.
            admissionAttempted = true;
            throw Error('Control withholds runtime GO before SSH build admission');
        }
    };
    startup = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 5000,
        cleanupDeadline: now() + 15000,
        diagnostics: true,
        emit,
        hold,
        ...(incompleteHelperProof
            ? {
                  proveDescendants: async () => {
                      throw Error('Control withholds loader-helper closure proof');
                  },
              }
            : {}),
    });
    const capture = (exe, args, options) => {
        argv.push({
            executable: exe,
            args: [...args],
            cwd: options.cwd,
            stdio: options.stdio,
            windowsHide: options.windowsHide,
        });
        child = spawn(exe, args, options);
        child.on('message', (m) => messages.push(m));
        child.stderr.on('data', (b) => {
            raw += b;
            assert(Buffer.byteLength(raw) <= 65536);
        });
        return child;
    };
    let red, result, failure, proof;
    try {
        if (kind === 'build') {
            const supplied = process.env.HUB_PILOT_ENTRY_PROFILE;
            assert(
                supplied && path.isAbsolute(supplied),
                'Supply an existing generated qualification profile; this control never builds one.',
            );
            const manifest = JSON.parse(fs.readFileSync(path.join(supplied, 'manifest.json')));
            const { id, ...core } = manifest;
            assert.equal(hash(JSON.stringify(core)), id);
            assert.equal(manifest.kind, 'ssh2-js-bundle');
            for (const [name, digest] of Object.entries(manifest.files))
                assert.equal(hash(fs.readFileSync(path.join(supplied, name))), digest);
            assert.equal(
                manifest.lockSHA256,
                hash(fs.readFileSync(path.join(root, 'package-lock.json'))),
            );
            preloadIdentity = {
                manifestSHA256: hash(fs.readFileSync(path.join(supplied, 'manifest.json'))),
                preloadSHA256: manifest.files['preload.cjs'],
                bundleSHA256: manifest.files['ssh2.cjs'],
                profile: id,
            };
            const previous = process.env.HUB_MEMORY_SSH_PROFILE;
            let launch;
            try {
                process.env.HUB_MEMORY_SSH_PROFILE = path.join(supplied, 'manifest.json');
                launch = nativePilotBuildLaunch({
                    profile: path.join(dir, 'native-profile'),
                    gcMode: 'normal',
                    coldStart: false,
                    workDeadlineMs: now() + 5000,
                    pilot: { root: dir, nonce },
                });
            } finally {
                if (previous === undefined) delete process.env.HUB_MEMORY_SSH_PROFILE;
                else process.env.HUB_MEMORY_SSH_PROFILE = previous;
            }
            assert.deepEqual(launch.args.slice(0, 5), [
                '--require',
                path.join(supplied, 'preload.cjs'),
                '--import',
                loader,
                path.join(root, 'tests/fixtures/native-pilot-build-worker.mts'),
            ]);
            assert.equal(launch.options.cwd, root);
            assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
            startup.spawn(
                'native-build-entry',
                () =>
                    capture(launch.executable, launch.args, {
                        ...launch.options,
                        stdio: [...launch.options.stdio],
                    }),
                (p) => {
                    if (p.connected) p.send({ kind: 'cancel-native-pilot-build' });
                },
            );
            await startupBound(startup.children.get(child).closed, {
                deadline: now() + 5000,
                label: 'Build entry refusal',
            });
            assert.match(raw, /diagnostic-hub-native-pilot-/);
            assert(!/TransformError|Top-level await/.test(raw));
            assert(
                !messages.some(
                    (m) => m.kind === 'native-build-event' || m.kind === 'native-build-result',
                ),
            );
            assert(!fs.existsSync(path.join(dir, 'native-app')));
            assert(!fs.existsSync(path.join(dir, 'native-profile')));
            try {
                proof = await startup.join();
            } catch (e) {
                failure = e;
                assert(held?.referenced);
            }
        } else {
            if (kind === 'red') {
                // Exact entry bytes in a deliberately wrong extension under the same real
                // default-CJS package. No package.json, loader or source-body substitution.
                red = path.join(root, 'tests/fixtures', 'module-red-' + nonce + '.ts');
                fs.writeFileSync(red, fs.readFileSync(runtimeWorker), { flag: 'wx' });
            }
            const binding = { nonce, deadline: now() + 600000 };
            try {
                result = await preparePilotStageRuntime(
                    {
                        binding,
                        bindingSHA256,
                        paths: { runtimeParent: outputParent },
                        startup,
                        signal: controller.signal,
                        deadline: now() + 5000,
                        emit,
                        cancel: (e) => controller.abort(e),
                        hold,
                        root,
                    },
                    { spawnPort: capture, ...(red ? { worker: red } : {}) },
                );
            } catch (e) {
                failure = e;
            }
            assert(failure && result === undefined);
            assert.equal(argv.length, 1);
            assert.deepEqual(argv[0].args.slice(0, 3), ['--import', loader, red ?? runtimeWorker]);
            assert.equal(argv[0].cwd, root);
            assert.deepEqual(argv[0].stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
            if (kind === 'red') {
                assert.match(
                    raw,
                    /Top-level await is currently not supported with the "cjs" output format/,
                );
                assert(!messages.some((m) => m.kind === 'native-runtime-ready'));
                assert(!admissionAttempted);
            } else {
                assert(admissionAttempted);
                assert(messages.some((m) => m.kind === 'native-runtime-ready'));
                assert(messages.some((m) => m.kind === 'native-runtime-cancel-ack'));
                assert(!/TransformError|Top-level await/.test(raw));
            }
            assert(!messages.some((m) => m.kind === 'native-runtime-result'));
            assert(
                !rows.some((r) =>
                    [
                        'runtime-esbuild-before',
                        'runtime-publication-before',
                        'runtime-ready',
                    ].includes(r.stage),
                ),
            );
            assert.deepEqual(fs.readdirSync(outputParent), []);
            const row = startup.children.get(child);
            if (!held) assert(row.joined && row.observationsDrained && row.identity);
        }
        const row = startup.children.get(child);
        assert(row.exit && row.close && row.code === 1);
        if (held) {
            assert(held.referenced);
            assert(!row.joined);
        } else assert(row.joined && row.observationsDrained && row.identity);
        if (incompleteHelperProof) assert(held?.referenced && !row.joined);
        assert(fs.existsSync(lease.file) && !lease.state().released);
        assert(!journal.entry.attempted && fs.fstatSync(journal.entry.fd).isFile());
        assert.equal(hash(packageBytes), hash(fs.readFileSync(path.join(root, 'package.json'))));
        assert.equal(hash(tsconfigBytes), hash(fs.readFileSync(path.join(root, 'tsconfig.json'))));
        return {
            kind,
            actualNode: process.version,
            platform: process.platform,
            arch: process.arch,
            argv: argv[0],
            loaderSHA256: hash(fs.readFileSync(require.resolve('tsx'))),
            tsxVersion: require('tsx/package.json').version,
            packageTypeAbsent: true,
            packageSHA256: hash(packageBytes),
            tsconfigSHA256: hash(tsconfigBytes),
            preloadIdentity,
            moduleBoundaryReached:
                kind === 'build'
                    ? 'production pilotPathMap before prepareProductNativeBuild'
                    : kind === 'red'
                      ? 'real CJS transform rejection'
                      : 'native-runtime-ready before GO',
            applicationAdmission: false,
            SSHBuilds: 0,
            nativeBuilds: 0,
            PTYOrElectronRuns: 0,
            exitCode: row.code,
            pipeClose: row.close,
            creationIdentity: row.identity,
            observedProcessAndHelperJoin: row.joined === true,
            referencedUnknownHold: Boolean(held?.referenced),
            markerRetained: true,
            evidenceStillOpen: true,
            releaseClaimed: false,
            stderr: raw,
        };
    } finally {
        if (child && !startup.children.get(child).close) {
            controller.abort(Error('Entry control teardown'));
            child.kill('SIGKILL');
            await startup.children.get(child).closed;
        }
        if (red) fs.unlinkSync(red);
        journal.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
for (const [kind, missing] of [
    ['runtime', false],
    ['build', false],
    ['red', false],
    ['red', true],
])
    test(
        'actual production loader entry before payload: ' +
            kind +
            (missing ? ' with unknown helper closure' : ''),
        async (t) => {
            const result = await entryControl(kind, missing);
            t.diagnostic(JSON.stringify(result));
        },
    );

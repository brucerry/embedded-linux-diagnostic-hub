import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { runMacNativeCLI, finishMacNativeEntry } from './macos-installer-native-cli.mjs';
import {
    parseMacNativeArgs,
    validateMacNativeRequest,
    normalizeMacTree,
    NATIVE_EFFECTS,
    NATIVE_LIMITS,
} from '../scripts/lib/macos-native-contract.mjs';
import {
    createMacNativeEffects,
    macNativeSourcePins,
    parseMacBundleInfo,
    offlineHelperSource,
    CAPTURE_ID,
    NATIVE_WORKSPACE,
    LEGACY_V052_COMMIT,
    legacyDiagnosticSnapshot,
    legacyKnownHostsFixture,
    validateLegacyDiagnosticReport,
} from '../scripts/lib/macos-native-adapter.mjs';
import {
    runMacInstallerActions,
    validateMacInstallerActionResult,
} from '../scripts/lib/macos-installer-actions.mjs';
import { createMacNativeIO } from '../scripts/lib/macos-native-io.mjs';
import { captureMacHelperOperation } from '../scripts/lib/macos-installer-child.mjs';
import { digest, installerCases } from '../scripts/lib/staged-artifact-gate.mjs';
import { produceMacOfflineLifecycle } from '../scripts/lib/macos-offline-lifecycle.mjs';
import { inspectInstallerCaseObservation } from '../scripts/lib/installer-lifecycle-evidence.mjs';
import {
    macPayloadIdentity,
    validateMacInstalledPayloadSample,
} from '../scripts/lib/macos-payload-identity.mjs';

const NATIVE_TASK = '/synthetic/mac-native-task';

// All native operations below are memory substitutes. No real IO/owner factory is called.
function model(options = {}) {
    const now = Date.parse('2026-10-26T12:00:00.000Z'),
        nonce = '1'.repeat(32);
    const root = NATIVE_TASK + '/diagnostic-hub-v060-macos-native-run-' + nonce;
    const files = new Map(),
        log = [],
        dirs = new Map(),
        trees = new Map();
    let ino = 100;
    const write = (file, bytes) => files.set(file, Buffer.from(bytes));
    const json = (file, value) => write(file, JSON.stringify(value));
    const sourcePins = [
        { role: 'node', path: NATIVE_TASK + '/mock/node' },
        { role: 'helper', path: NATIVE_WORKSPACE + '/public/download-run-macos.sh' },
        { role: 'tsx', path: NATIVE_TASK + '/mock/loader.mjs' },
        { role: 'playwright', path: NATIVE_TASK + '/mock/playwright.mjs' },
    ];
    write(sourcePins[0].path, 'mock-node');
    for (const pin of sourcePins.slice(2)) write(pin.path, 'mock-' + pin.role);
    // Static source bytes only, never invoked.
    write(
        sourcePins[1].path,
        readFileSync(new URL('../public/download-run-macos.sh', import.meta.url)),
    );
    const inputs = {},
        infos = {},
        inventories = {};
    for (const role of ['current', 'prior']) {
        const version = role === 'current' ? '0.6.0' : '0.5.2',
            prefix = NATIVE_TASK + '/mock/' + role;
        write(prefix + '.zip', role + '-fake-zip');
        const infoBytes = Buffer.from(
            '<plist><dict><key>CFBundleShortVersionString</key><string>' +
                version +
                '</string><key>CFBundleIdentifier</key><string>dev.diagnostichub.desktop</string></dict></plist>',
        );
        const inv = [
            ...['Contents', 'Contents/Resources', 'Contents/MacOS'].map((path) => ({
                path,
                kind: 'directory',
                mode: 0o755,
            })),
            {
                path: 'Contents/Info.plist',
                kind: 'file',
                bytes: infoBytes.length,
                sha256: digest(infoBytes),
                mode: 0o644,
            },
            {
                path: 'Contents/Resources/app.asar',
                kind: 'file',
                bytes: 4,
                sha256: digest('asar'),
                mode: 0o644,
            },
            {
                path: 'Contents/MacOS/Diagnostic Hub',
                kind: 'file',
                bytes: 4,
                sha256: digest('mock'),
                mode: 0o755,
            },
        ];
        const info = {
            platform: 'darwin',
            arch: 'arm64',
            version,
            commit:
                role === 'prior' && options.legacyPrior
                    ? LEGACY_V052_COMMIT
                    : (role === 'current' ? 'a' : 'b').repeat(40),
            asset: 'Diagnostic-Hub-macos-arm64.zip',
            sha256: digest(files.get(prefix + '.zip')),
            asarSHA256: digest('asar'),
            bundleIdentifier: 'dev.diagnostichub.desktop',
            minimumMacOSVersion: '13.0.0',
            signature: 'ad-hoc',
            adHocIntegrityVerified: true,
            notarized: false,
            gatekeeperDownloadedAppQualified: false,
            payloadIdentity: macPayloadIdentity(normalizeMacTree({ files: inv })),
        };
        json(prefix + '.json', info);
        json(prefix + '.tree.json', { files: inv });
        infos[version] = { infoBytes, info };
        inventories[version] = normalizeMacTree({ files: inv });
        inputs[role] = {
            zip: prefix + '.zip',
            info: prefix + '.json',
            tree: prefix + '.tree.json',
            zipBytes: files.get(prefix + '.zip').length,
            zipSHA256: info.sha256,
            infoSHA256: digest(files.get(prefix + '.json')),
            treeSHA256: digest(files.get(prefix + '.tree.json')),
        };
    }
    const approvalPath = NATIVE_TASK + '/mock/approval.json';
    const approval = {
        operation: 'macos-native-installer-lifecycle',
        approved: true,
        nonce,
        root,
        sourceRoot: NATIVE_TASK + '/mock/source',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'c'.repeat(40),
        windowMs: 120000,
        clockAllowanceMs: 0,
        minimumFreeBytes: 1,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 120000).toISOString(),
        effects: [...NATIVE_EFFECTS],
        inputs,
        pins: sourcePins.map((pin) => ({
            ...pin,
            bytes: files.get(pin.path).length,
            sha256: digest(files.get(pin.path)),
        })),
    };
    const refresh = () => json(approvalPath, approval);
    refresh();
    const argv = (mode = '--validate') => [
        mode,
        '--task-root',
        NATIVE_TASK,
        ...['node', 'tsx', 'playwright'].flatMap((role) => [
            '--' + role,
            sourcePins.find((pin) => pin.role === role).path,
        ]),
        '--approval',
        approvalPath,
        '--approval-sha256',
        digest(files.get(approvalPath)),
        '--root',
        root,
        '--source-root',
        approval.sourceRoot,
        ...['current', 'prior'].flatMap((role) => [
            '--' + role + '-zip',
            inputs[role].zip,
            '--' + role + '-info',
            inputs[role].info,
            '--' + role + '-tree',
            inputs[role].tree,
        ]),
    ];
    const st = (file, kind) => ({
        dev: 1,
        ino: dirs.get(file) ?? 1,
        size: files.get(file)?.length ?? 0,
        nlink: 1,
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
        isSymbolicLink: () => false,
    });
    const io = {
        taskRoot: NATIVE_TASK,
        state: {
            root: null,
            rootAllocated: false,
            claim: null,
            deadline: 999999999,
            reason: null,
            fds: new Set(),
            children: [],
            desktops: [],
            terminalRows: 0,
            terminalBytes: 0,
        },
        gate: () => {},
        nowUTC: () => now + 1,
        setExpiry: () => {},
        canonicalDir: (file) => file,
        metadata: () => ({
            platform: 'darwin',
            arch: 'arm64',
            node: '24.22.0',
            executable: sourcePins[0].path,
            osRelease: 'mock',
        }),
        read: (file, cap) => {
            log.push(['read', file]);
            const b = files.get(file);
            assert.ok(b && b.length <= cap);
            return Buffer.from(b);
        },
        hash: (file, size) => {
            const b = files.get(file);
            assert.ok(b);
            assert.equal(b.length, size);
            return { bytes: b.length, sha256: digest(b) };
        },
        absent: (file) => !files.has(file) && !dirs.has(file) && !trees.has(file),
        freeBytes: () => 1000000000000n,
        claim: async () => {
            log.push(['claim']);
            io.state.root = root;
            io.state.claim = root + '.SPENT.json';
        },
        sourceContext: async (...args) => {
            log.push(['sourceContext', ...args]);
        },
        allocateRoot: () => {
            log.push(['allocate']);
            io.state.rootAllocated = true;
            dirs.set(root, ++ino);
        },
        publish: (file, bytes, cap = 65536) => {
            log.push(['publish', file]);
            assert.ok(!files.has(file));
            assert.ok(bytes.length <= cap);
            write(file, bytes);
            assert.deepEqual(files.get(file), bytes);
            log.push(['readback', file]);
        },
        mkdir: (file) => {
            log.push(['mkdir', file]);
            assert.ok(!dirs.has(file));
            dirs.set(file, ++ino);
        },
        stat: (file) => {
            assert.ok(dirs.has(file) || files.has(file));
            return st(file, dirs.has(file) ? 'directory' : 'file');
        },
        tree: (file, inventory) => {
            assert.ok(trees.has(file));
            assert.deepEqual(trees.get(file).inventory, inventory);
            return [
                { path: '.', kind: 'directory', mode: 0o755, dev: 1, ino: 7 },
                ...inventory.map((entry, index) => ({ ...entry, dev: 1, ino: 8 + index })),
            ];
        },
        copyTree: (from, to, inventory) => {
            const snapshot = io.tree(from, inventory);
            trees.set(to, structuredClone(trees.get(from)));
            return snapshot;
        },
        removeTree: (file, inventory) => {
            io.tree(file, inventory);
            log.push(['removeTree', file]);
            trees.delete(file);
        },
        take: () => true,
        row: () => {
            assert.ok(io.state.terminalRows < NATIVE_LIMITS.terminalRows);
            io.state.terminalRows++;
        },
        wait: async (_label, fn) => fn(),
        beforeExpiry: () => true,
        needsHold: () =>
            io.state.desktops.some((entry) => !entry.closed) ||
            io.state.children.some((entry) => !entry.closeObserved),
    };
    io.child = async (exe, args, env, cwd, operation = null) => {
        io.row();
        const request = Object.freeze({
            executable: exe,
            args: Object.freeze([...args]),
            env: Object.freeze({ ...env }),
            cwd,
            operation: operation === null ? null : captureMacHelperOperation(operation),
        });
        const record = {
            executable: exe,
            args: request.args,
            child: null,
            stdout: [],
            stderr: [],
            stdoutBytes: 0,
            stderrBytes: 0,
            exitObserved: false,
            closeObserved: false,
            stdoutEOF: false,
            stderrEOF: false,
            exitCode: null,
            signal: null,
            error: 'none',
        };
        Object.defineProperty(record, 'request', { value: request });
        io.state.children.push(record);
        const complete = (fact) => {
            const stdout = Buffer.from(fact.stdout),
                stderr = Buffer.from(fact.stderr);
            Object.assign(record, {
                stdout: [stdout],
                stderr: [stderr],
                stdoutBytes: stdout.length,
                stderrBytes: stderr.length,
                exitObserved: fact.exitObserved,
                closeObserved: true,
                stdoutEOF: true,
                stderrEOF: true,
                exitCode: fact.exitCode,
                signal: fact.signal,
                error: fact.error,
            });
            io.state.terminalBytes += stdout.length + stderr.length;
            return fact;
        };
        log.push(['child', exe, args, env, cwd]);
        const version = args[2].slice(1),
            target = env.HUB_NATIVE_TARGET;
        if (env.HUB_NATIVE_FAULT) {
            write(env.HUB_NATIVE_FAULT_MARKER, 'activation-return-failure\n');
            return complete({
                command: [exe, ...args],
                exitObserved: true,
                exitCode: 70,
                signal: null,
                error: 'none',
                stdout: '',
                stderr: '',
            });
        }
        if (io.state.desktops.some((entry) => entry.fixture.target === target && !entry.closed))
            return complete({
                command: [exe, ...args],
                exitObserved: true,
                exitCode: 1,
                signal: null,
                error: 'none',
                stdout: '',
                stderr: 'Quit Diagnostic Hub',
            });
        trees.set(target, { version, inventory: inventories[version] });
        write(path.join(target, 'Contents/Info.plist'), infos[version].infoBytes);
        return complete({
            command: [exe, ...args],
            exitObserved: true,
            exitCode: 0,
            signal: null,
            error: 'none',
            stdout: '',
            stderr: '',
        });
    };
    class Desktop {
        constructor(options) {
            this.options = options;
            this.owner = {
                publicationFDs: new Set(),
                preQuitReceiptVerified: false,
                reason: null,
                shutdownActive() {},
                streams: { stdoutEOF: false, stderrEOF: false },
            };
        }
        launch() {
            log.push(['app-launch', this.options]);
        }
        async attach() {}
        process() {
            return { pid: 42 };
        }
        snapshot() {
            return { pid: 42, reason: this.owner.reason, exitObserved: !!this.owner.exitObserved };
        }
        async normalQuit() {
            assert.equal(this.owner.preQuitReceiptVerified, true);
            log.push(['normal-quit']);
            Object.assign(this.owner, {
                quitComplete: true,
                exitObserved: true,
                closeObserved: true,
                exitCode: 0,
                signal: null,
            });
            this.owner.streams = { stdoutEOF: true, stderrEOF: true };
        }
        async evaluate(fn, argument) {
            const profile = this.options.profile,
                target = path.resolve(this.options.executable, '../../..');
            this.context ??= {
                globalThis: { __hubInstallerOffline: { applied: true, readyBeforeWindow: true } },
                process: { pid: 42 },
            };
            const window = {
                id: 1,
                webContents: {
                    getURL: () => 'app://bundle/index.html',
                    executeJavaScript: async (code) => {
                        const legacy = trees.get(target).version === '0.5.2' && options.legacyPrior;
                        if (code.includes('typeof window.diagnosticHub?.consoleStorage'))
                            return {
                                consoleStorage: options.missingConsole
                                    ? false
                                    : legacy
                                      ? Boolean(options.legacyHasConsole)
                                      : true,
                                exportReport: legacy ? !options.missingLegacyExport : false,
                            };
                        const begin = code.indexOf('('),
                            request = JSON.parse(code.slice(begin + 1, -1));
                        if (code.startsWith('window.diagnosticHub.exportReport(')) {
                            assert.ok(legacy && !options.missingLegacyExport);
                            log.push(['legacy-export', structuredClone(request)]);
                            if (options.legacyExportFalse) return false;
                            const selected = await this.electron.dialog.showSaveDialog();
                            json(selected.filePath, {
                                application: 'Diagnostic Hub',
                                applicationVersion: '0.5.2',
                                ...request,
                                summary: {},
                                diagnostics: request.results,
                            });
                            return true;
                        }
                        assert.ok(
                            !legacy && !options.missingConsole,
                            'Unavailable API must never be invoked.',
                        );
                        if (request.op === 'export') {
                            const result = await this.electron.dialog.showSaveDialog();
                            json(result.filePath, { schema: 2, mode: 'console' });
                            return { ok: true, value: { saved: true } };
                        }
                        if (request.op === 'read')
                            return { ok: true, value: { handle: 'mock-reader' } };
                        if (request.op === 'pull') return { ok: true, value: { done: true } };
                        if (request.op === 'return') return { ok: true, value: {} };
                        throw Error('unexpected mock IPC');
                    },
                },
            };
            this.electron ??= {
                dialog: {
                    showSaveDialog: async () => {
                        throw Error('unexpected original dialog');
                    },
                },
            };
            Object.assign(this.electron, {
                app: {
                    isPackaged: true,
                    getVersion: () => trees.get(target).version,
                    getAppPath: () => path.join(target, 'Contents/Resources/app.asar'),
                    getPath: () => profile,
                },
                BrowserWindow: { getAllWindows: () => [window] },
            });
            // Only fixed adapter callbacks, in an inert VM context without require, host process or IO.
            return structuredClone(
                await vm.runInNewContext('(' + fn.toString() + ')', this.context)(
                    this.electron,
                    argument,
                ),
            );
        }
    }
    for (const name of ['header.json', 'meta.json', 'raw.jsonl'])
        write(
            path.join(NATIVE_WORKSPACE, 'tests/fixtures/macos-installer-data', name),
            readFileSync(new URL('./fixtures/macos-installer-data/' + name, import.meta.url)),
        );
    const deps = {
        sourcePins: () => sourcePins,
        createIO: () => io,
        createEffects: (admitted) => createMacNativeEffects(admitted, io, { Desktop }),
    };
    return {
        now,
        nonce,
        root,
        files,
        log,
        dirs,
        trees,
        io,
        approval,
        sourcePins,
        inputs,
        argv,
        refresh,
        deps,
        Desktop,
        write,
        json,
    };
}
const actorNames = new Set([
    'claim',
    'sourceContext',
    'allocate',
    'publish',
    'mkdir',
    'child',
    'app-launch',
    'normal-quit',
    'removeTree',
]);
const noActors = (m) =>
    assert.deepEqual(
        m.log.filter(([name]) => actorNames.has(name)),
        [],
    );

test('current installed payload samples bind shipping metadata and remain unqualified', async () => {
    const m = model(),
        result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 0, result.output + (result.state.failure?.stack ?? ''));
    const samples = [...m.files].filter(([name]) => /\/installed-payload-\d+\.json$/.test(name));
    assert.equal(samples.length, 12);
    const info = JSON.parse(m.files.get(m.inputs.current.info));
    for (const [file, bytes] of samples) {
        const value = JSON.parse(bytes);
        assert.ok(
            file.startsWith(
                path.join(m.root, value.caseId.slice('macos-bundle:'.length), 'evidence') + '/',
            ),
        );
        validateMacInstalledPayloadSample(value, {
            caseId: value.caseId,
            version: '0.6.0',
            sourceCommit: 'a'.repeat(40),
            sourceTree: 'c'.repeat(40),
            archive: {
                name: info.asset,
                bytes: m.inputs.current.zipBytes,
                sha256: m.inputs.current.zipSHA256,
            },
            payloadIdentity: info.payloadIdentity,
        });
        assert.equal(value.qualification, false);
    }
});
test('actual adapter record shapes feed the shipping-payload lifecycle producer without native qualification', async () => {
    const m = model();
    const { LaunchCustody } = inertOwnerExports();
    class LifecycleDesktop extends m.Desktop {
        constructor(options) {
            super(options);
            this.custody = new LaunchCustody(120000, () => 0, { take: () => true });
            this.child = new EventEmitter();
            this.child.pid = 42;
            this.child.stdout = new EventEmitter();
            this.child.stderr = new EventEmitter();
            this.custody.adopt(this.child);
            this.transportsClosed = false;
        }
        snapshot() {
            return {
                ...this.custody.snapshot(),
                mainPending: 0,
                mainTransportClosed: this.transportsClosed,
                rendererTransportClosed: this.transportsClosed,
            };
        }
        async normalQuit() {
            await super.normalQuit(); // Explicit fake normal-quit and transport ACKs, never native evidence.
            Object.assign(this.custody, {
                quitIntent: true,
                quitScheduledAck: true,
                quitComplete: true,
            });
            this.custody.shutdown.complete = true;
            this.child.emit('exit', 0, null);
            this.child.stdout.emit('end');
            this.child.stderr.emit('end');
            this.child.emit('close');
            this.transportsClosed = true;
        }
    }
    m.deps.createEffects = (admitted) =>
        createMacNativeEffects(admitted, m.io, { Desktop: LifecycleDesktop });
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 0, result.output + (result.state.failure?.stack ?? ''));
    const old = JSON.parse(m.files.get(m.root + '/evidence/observation.json'));
    const expected = {
        version: '0.6.0',
        sourceCommit: m.approval.sourceCommit,
        sourceTree: m.approval.sourceTree,
        runId: '123',
        runAttempt: '2',
        lane: 'darwin-arm64',
        artifacts: old.artifacts,
    };
    const names = {
        prequit: m.root + '/offline-launch/evidence/app-1-prequit.json',
        closed: m.root + '/offline-launch/evidence/app-1-closure.json',
        installedPayload: m.root + '/offline-launch/evidence/installed-payload-1.json',
        shippingBuildInfo: m.inputs.current.info,
    };
    const files = new Map(),
        records = {};
    for (const [role, original] of Object.entries(names)) {
        const bytes = m.files.get(original);
        assert.ok(bytes);
        const file = 'retained/' + role + '.json';
        files.set(file, bytes);
        records[role] = { path: file, bytes: bytes.length, sha256: digest(bytes) };
    }
    const produced = await produceMacOfflineLifecycle(expected, records, async (file, max) => {
        const bytes = files.get(file);
        assert.ok(bytes.length <= max);
        return bytes;
    });
    assert.equal(
        inspectInstallerCaseObservation(
            JSON.parse(produced.bytes),
            { id: produced.caseId, evidence: produced.evidence },
            expected,
        ),
        'shipping-payload-and-direct-child-consistent-unqualified',
    );
    assert.equal(produced.releaseAcceptance, false);
    assert.equal(
        JSON.parse(produced.bytes).observation.closed.closure.physicalDescendantClosure,
        false,
    );
});
test('changed installed tree sample refuses before payload publication or application launch', async () => {
    const m = model(),
        tree = m.io.tree;
    m.io.tree = (file, inventory) => {
        const rows = tree(file, inventory);
        if (file.endsWith('/Applications/Diagnostic Hub.app'))
            rows.find((r) => r.path === 'Contents/MacOS/Diagnostic Hub').sha256 =
                digest('wrong observed main');
        return rows;
    };
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.actions.result.status, 'unknown');
    assert.ok(![...m.files.keys()].some((name) => name.includes('/installed-payload-')));
    assert.ok(!m.log.some(([name]) => name === 'app-launch'));
});

test('CLI import/help/default never constructs IO or effects', async () => {
    let calls = 0;
    const deps = {
        createIO: () => {
            calls++;
            throw Error();
        },
    };
    for (const argv of [[], ['--help']])
        assert.equal((await runMacNativeCLI(argv, deps)).exitCode, 0);
    assert.equal(calls, 0);
});
for (const [name, argv] of [
    ['implicit run', ['run']],
    ['unknown flag', ['--run', '--unknown', 'x']],
    ['missing inputs', ['--run']],
    ['help plus run', ['--help', '--run']],
]) {
    test('arguments refuse ' + name + ' without IO', async () => {
        const result = await runMacNativeCLI(argv, {
            createIO: () => {
                throw Error('should not construct');
            },
        });
        assert.equal(result.exitCode, 2);
        assert.equal(result.state.io, null);
    });
}

test('explicit host configuration is required and malformed paths refuse before IO', async () => {
    const m = model();
    const variants = [];
    for (const flag of ['--task-root', '--node', '--tsx', '--playwright']) {
        const argv = m.argv();
        argv.splice(argv.indexOf(flag), 2);
        variants.push(argv);
    }
    for (const value of ['/', 'relative/task', '/synthetic/../task', '/synthetic/task\n']) {
        const argv = m.argv();
        argv[argv.indexOf('--task-root') + 1] = value;
        variants.push(argv);
    }
    for (const argv of variants) {
        let calls = 0;
        const result = await runMacNativeCLI(argv, {
            createIO() {
                calls++;
                throw Error('IO forbidden');
            },
        });
        assert.equal(result.exitCode, 2);
        assert.equal(result.state.io, null);
        assert.equal(calls, 0);
    }
});

test('configured tools must match expected approval pins and actual selected Node', async () => {
    for (const role of ['node', 'tsx', 'playwright']) {
        const m = model(),
            argv = m.argv();
        argv[argv.indexOf('--' + role) + 1] = '/synthetic/different-' + role;
        const result = await runMacNativeCLI(argv, m.deps);
        assert.equal(result.exitCode, 2);
        noActors(m);
    }
    const m = model();
    m.io.metadata = () => ({
        platform: 'darwin',
        arch: 'arm64',
        node: '24.22.0',
        executable: '/synthetic/other-node',
    });
    assert.equal((await runMacNativeCLI(m.argv(), m.deps)).exitCode, 2);
    noActors(m);
});

test('configured task root must match IO and its canonical directory before claiming a run', async () => {
    for (const change of [
        (m) => {
            m.io.taskRoot = '/synthetic/different-root';
        },
        (m) => {
            m.io.canonicalDir = (name) =>
                name === NATIVE_TASK ? '/synthetic/redirected-root' : name;
        },
    ]) {
        const m = model();
        change(m);
        assert.equal((await runMacNativeCLI(m.argv('--run'), m.deps)).exitCode, 2);
        noActors(m);
    }
});

test('default source pins need explicit configuration and keep the SDK nominally source-local', () => {
    const configuration = {
        'source-root': NATIVE_WORKSPACE,
        node: '/synthetic/selected/node',
        tsx: '/synthetic/selected/loader.mjs',
        playwright: NATIVE_WORKSPACE + '/node_modules/@playwright/test/index.mjs',
    };
    const pins = macNativeSourcePins(configuration);
    assert.equal(pins.length, 20);
    assert.equal(
        pins.find((pin) => pin.role === 'macos-installer-child.mjs').path,
        NATIVE_WORKSPACE + '/scripts/lib/macos-installer-child.mjs',
    );
    for (const role of ['node', 'tsx', 'playwright'])
        assert.equal(pins.find((pin) => pin.role === role).path, configuration[role]);
    assert.throws(() => macNativeSourcePins());
    assert.throws(() =>
        macNativeSourcePins({ ...configuration, 'source-root': '/synthetic/other-source' }),
    );
    assert.throws(() =>
        macNativeSourcePins({ ...configuration, playwright: '/synthetic/arbitrary-sdk.mjs' }),
    );
});

test('native IO requires explicit valid task configuration before any filesystem or spawn access', () => {
    let calls = 0;
    const denied = new Proxy(
        {},
        {
            get() {
                calls++;
                throw Error('native IO forbidden');
            },
        },
    );
    for (const taskRoot of [undefined, '/', 'relative', '/synthetic/../root'])
        assert.throws(() =>
            createMacNativeIO(0, {
                taskRoot,
                fs: denied,
                spawn() {
                    calls++;
                },
            }),
        );
    assert.equal(calls, 0);
});
test('valid validation mode performs only binding reads, no SPENT/root/child', async () => {
    const m = model(),
        result = await runMacNativeCLI(m.argv(), m.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.output).nativeEffects, false);
    noActors(m);
});
for (const [name, change] of [
    [
        'not approved',
        (m) => {
            m.approval.approved = false;
        },
    ],
    [
        'missing effects',
        (m) => {
            m.approval.effects.pop();
        },
    ],
    [
        'wrong nonce/root',
        (m) => {
            m.approval.nonce = '2'.repeat(32);
        },
    ],
    [
        'expired',
        (m) => {
            m.io.nowUTC = () => m.now + 120000;
        },
    ],
    [
        'future issuance',
        (m) => {
            m.io.nowUTC = () => m.now - 1;
        },
    ],
    [
        'noncanonical time',
        (m) => {
            m.approval.issuedAt = '2026-10-26T12:00:00Z';
        },
    ],
    [
        'noncanonical source root',
        (m) => {
            m.io.canonicalDir = (value) =>
                value === m.approval.sourceRoot ? value + '/other' : value;
        },
    ],
    [
        'existing target',
        (m) => {
            m.dirs.set(m.root, 5);
        },
    ],
    [
        'consumed claim',
        (m) => {
            m.write(m.root + '.SPENT.json', 'SPENT');
        },
    ],
    [
        'wrong host platform',
        (m) => {
            const original = m.io.metadata;
            m.io.metadata = () => ({ ...original(), platform: 'linux' });
        },
    ],
    [
        'wrong Node major',
        (m) => {
            const original = m.io.metadata;
            m.io.metadata = () => ({ ...original(), node: '22.0.0' });
        },
    ],
    [
        'wrong pin bytes',
        (m) => {
            m.approval.pins[0].bytes++;
        },
    ],
    [
        'wrong ZIP identity',
        (m) => {
            m.write(m.inputs.current.zip, 'CHANGED');
        },
    ],
    [
        'same current/prior version',
        (m) => {
            const info = JSON.parse(m.files.get(m.inputs.prior.info));
            info.version = '0.6.0';
            m.json(m.inputs.prior.info, info);
            m.inputs.prior.infoSHA256 = digest(m.files.get(m.inputs.prior.info));
        },
    ],
]) {
    test('preflight refuses ' + name + ' before effects', async () => {
        const m = model();
        change(m);
        m.refresh();
        const result = await runMacNativeCLI(m.argv(), m.deps);
        assert.equal(result.exitCode, 2);
        noActors(m);
    });
}
test('approval byte hash mismatch refuses before effects', async () => {
    const m = model(),
        argv = m.argv();
    argv[argv.indexOf('--approval-sha256') + 1] = '0'.repeat(64);
    assert.equal((await runMacNativeCLI(argv, m.deps)).exitCode, 2);
    noActors(m);
});
for (const [name, mutate] of [
    [
        'traversal',
        (v) => {
            v.files[0].path = '../escape';
        },
    ],
    [
        'duplicate',
        (v) => {
            v.files.push(v.files[0]);
        },
    ],
    [
        'link parent',
        (v) => {
            v.files.push({ path: 'Contents', kind: 'symlink', target: 'other' });
        },
    ],
    [
        'escaping link',
        (v) => {
            v.files.push({ path: 'bad', kind: 'symlink', target: '../escape' });
        },
    ],
    [
        'missing executable',
        (v) => {
            v.files.pop();
        },
    ],
])
    test('tree grammar refuses ' + name, () => {
        const m = model(),
            value = JSON.parse(m.files.get(m.inputs.current.tree));
        mutate(value);
        assert.throws(() => normalizeMacTree(value));
    });
test('complete native-labelled adapter action path executes only inert substitutes', async () => {
    const m = model(),
        result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 0, result.output + (result.state.failure?.stack ?? ''));
    assert.equal(result.state.actions.result.status, 'verified');
    assert.equal(result.state.actions.result.cases.length, 9);
    assert.equal(result.state.actions.result.qualificationStatus, 'unverified');
    assert.equal(m.log.filter(([name]) => name === 'child').length, 15);
    assert.equal(m.log.filter(([name]) => name === 'app-launch').length, 8);
    assert.equal(m.log.filter(([name]) => name === 'normal-quit').length, 8);
    assert.equal(m.log.filter(([name]) => name === 'removeTree').length, 1);
    const receipt = JSON.parse(m.files.get(m.root + '/evidence/observation.json'));
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.fixtureStatus, 'unexecuted');
    assert.ok(m.files.get(m.root + '/evidence/observation.json').length <= 8192);
    assert.equal(receipt.commandReference.pointer, '/command');
    const stages = JSON.parse(m.files.get(m.root + '/evidence/stages.json'));
    assert.equal(stages.command.length, 33);
    assert.deepEqual(stages.command.slice(-m.argv('--run').length), m.argv('--run'));
    assert.deepEqual(stages.command.slice(0, 3), [
        m.sourcePins.find((pin) => pin.role === 'node').path,
        '--import',
        m.sourcePins.find((pin) => pin.role === 'tsx').path,
    ]);
    assert.ok(
        m.files
            .get(m.root + '/bin/curl')
            .toString()
            .includes(m.sourcePins[0].path),
    );
    const terminal = JSON.parse(m.files.get(m.root + '/evidence/terminal-index.json'));
    const helperRows = terminal.rows.filter((row) => row.kind === 'fixed-child');
    assert.equal(helperRows.length, 15);
    assert.equal(terminal.capturedRows, terminal.rows.length);
    assert.equal(helperRows[0].operation.caseId, 'macos-bundle:install');
    assert.equal(helperRows[0].operation.operationId, m.nonce + ':macos-bundle:install:helper:1');
    assert.deepEqual(helperRows[0].operation.observerSource, {
        commit: m.approval.sourceCommit,
        tree: m.approval.sourceTree,
    });
    assert.deepEqual(helperRows[0], JSON.parse(m.files.get(m.root + '/evidence/child-0.json')));
    assert.ok(
        helperRows.some(
            (row) => row.operation.caseId === 'macos-bundle:busy-refusal' && row.exitCode === 1,
        ),
    );
    assert.ok(
        helperRows.some(
            (row) =>
                row.operation.caseId === 'macos-bundle:interrupted-recovery' && row.exitCode === 70,
        ),
    );
    assert.equal(
        receipt.cases[0].evidence[0].sha256,
        digest(m.files.get(m.root + '/evidence/stages.json')),
    );
    assert.equal(result.state.holdRequired, false);
    assert.ok(
        m.log.findIndex(([name]) => name === 'claim') <
            m.log.findIndex(([name]) => name === 'sourceContext'),
    );
    assert.ok(
        m.log.findIndex(([name]) => name === 'sourceContext') <
            m.log.findIndex(([name]) => name === 'allocate'),
    );
    for (const [, exe, args, env] of m.log.filter(([name]) => name === 'child')) {
        assert.equal(exe, '/bin/bash');
        assert.ok(args[0].startsWith(m.root + '/bin/'));
        assert.equal(args.at(-1), '--no-launch');
        assert.deepEqual(
            Object.keys(env).sort(),
            [
                'HOME',
                'HUB_NATIVE_APPS',
                'HUB_NATIVE_FAULT',
                'HUB_NATIVE_FAULT_MARKER',
                'HUB_NATIVE_MAP',
                'HUB_NATIVE_TARGET',
                'LANG',
                'PATH',
                'TMPDIR',
            ].sort(),
        );
    }
    assert.ok(m.files.get(m.root + '/bin/download-run-macos.sh').includes('refuse directly'));
});
test('SPENT failure stops before source query or allocation and does not retry', async () => {
    const m = model();
    m.io.claim = async () => {
        m.log.push(['claim']);
        throw Error('PRIVATE_CANARY');
    };
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 2);
    assert.equal(m.log.filter(([name]) => actorNames.has(name)).length, 1);
    assert.ok(!result.output.includes('PRIVATE_CANARY'));
});
test('source identity failure after SPENT stops before allocation', async () => {
    const m = model();
    m.io.sourceContext = async () => {
        m.log.push(['sourceContext']);
        throw Error();
    };
    assert.equal((await runMacNativeCLI(m.argv('--run'), m.deps)).exitCode, 2);
    assert.deepEqual(
        m.log.filter(([name]) => actorNames.has(name)).map(([name]) => name),
        ['claim', 'sourceContext'],
    );
});
test('insufficient sampled free space refuses before claim', async () => {
    const m = model();
    m.io.freeBytes = () => 0n;
    assert.equal((await runMacNativeCLI(m.argv('--run'), m.deps)).exitCode, 2);
    noActors(m);
});
test('abnormal helper return cannot advance to app launch or verified actions', async () => {
    const m = model();
    m.io.child = async () => ({
        command: ['mock'],
        exitObserved: true,
        exitCode: null,
        signal: 'SIGTERM',
        error: 'none',
        stdout: '',
        stderr: '',
    });
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.actions.result.status, 'unknown');
    assert.equal(result.state.holdRequired, true);
    assert.equal(
        m.log.some(([name]) => name === 'app-launch'),
        false,
    );
    assert.equal(m.files.has(m.root + '/evidence/observation.json'), false);
});
test('unknown app attachment retains private owner and does not issue quit', async () => {
    const m = model();
    class BadDesktop extends m.Desktop {
        async attach() {
            throw Error('PRIVATE_CANARY');
        }
    }
    m.deps.createEffects = (admitted) =>
        createMacNativeEffects(admitted, m.io, { Desktop: BadDesktop });
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.holdRequired, true);
    assert.equal(m.io.state.desktops.length, 1);
    assert.equal(
        m.log.some(([name]) => name === 'normal-quit'),
        false,
    );
    assert.ok(!result.output.includes('PRIVATE_CANARY'));
});
test('factory refuses missing admitted run/root state without native calls', async () => {
    const m = model(),
        parsed = parseMacNativeArgs(m.argv());
    const admitted = await validateMacNativeRequest(parsed, m.io, m.sourcePins);
    await assert.rejects(createMacNativeEffects(admitted, m.io));
    noActors(m);
});
test('forged fixture and unknown case refuse before helper/launch', async () => {
    const m = model(),
        admitted = await validateMacNativeRequest(
            parseMacNativeArgs(m.argv('--run')),
            m.io,
            m.sourcePins,
        );
    await m.io.claim(admitted);
    m.io.allocateRoot();
    const effects = await createMacNativeEffects(admitted, m.io, { Desktop: m.Desktop });
    await effects.initialize();
    await assert.rejects(effects.prepare('macos-bundle:unknown'));
    const fixture = await effects.prepare(installerCases('darwin-arm64')[0]);
    await assert.rejects(effects.snapshot({ ...fixture }));
    assert.equal(
        m.log.some(([name]) => name === 'child' || name === 'app-launch'),
        false,
    );
});
test('offline fixture consent transformation is exact and refuses unmatched source', () => {
    const source = readFileSync(new URL('../public/download-run-macos.sh', import.meta.url));
    const patched = offlineHelperSource(source);
    assert.ok(patched.includes('return 1 # isolated fixture'));
    assert.ok(!patched.includes('trying the controlling terminal.'));
    assert.throws(() => offlineHelperSource(Buffer.from('wrong-helper')));
});
test('bundle metadata refuses binary, entity, duplicate version and wrong identifier', () => {
    for (const value of [
        'bplist00',
        '<plist><!ENTITY bad>',
        '<plist><key>CFBundleShortVersionString</key><string>0.6.0</string><key>CFBundleShortVersionString</key><string>9.0.0</string>',
        '<plist><key>CFBundleShortVersionString</key><string>0.6.0</string><key>CFBundleIdentifier</key><string>other</string>',
    ])
        assert.throws(() => parseMacBundleInfo(Buffer.from(value)));
});
test('limits preserve full terminal allowance and bounded receipts', () => {
    assert.equal(NATIVE_LIMITS.terminalBytes, 327680);
    assert.equal(NATIVE_LIMITS.terminalRows, 32);
    assert.equal(NATIVE_LIMITS.resultBytes, 8192);
    assert.equal(NATIVE_LIMITS.evidenceBytes, 10485760);
});
test('IO construction and unused native factory have no filesystem or process effects', () => {
    const denied = new Proxy(
        {},
        {
            get() {
                throw Error('unexpected filesystem access');
            },
        },
    );
    const io = createMacNativeIO(0, {
        taskRoot: NATIVE_TASK,
        fs: denied,
        spawn() {
            throw Error('unexpected spawn');
        },
        now: () => 0,
    });
    assert.equal(io.needsHold(), false);
    assert.equal(io.state.rootAllocated, false);
});
test('late returned open FD is retained before the post-return deadline refusal', () => {
    let clock = 0;
    const io = createMacNativeIO(0, {
        taskRoot: NATIVE_TASK,
        now: () => clock,
        fs: {
            constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
            realpathSync: (file) => file,
            openSync: () => {
                clock = 120000;
                return 77;
            },
        },
    });
    assert.throws(() => io.read(NATIVE_TASK + '/mock/file', 10));
    assert.equal(io.state.fds.has(77), true);
    assert.equal(io.needsHold(), true);
});
test('late successful root allocation provenance survives refusal before canonicalization', () => {
    let clock = 0;
    const root = NATIVE_TASK + '/mock-new-root';
    const io = createMacNativeIO(0, {
        taskRoot: NATIVE_TASK,
        now: () => clock,
        fs: {
            realpathSync: (file) => file,
            mkdirSync: () => {
                clock = 120000;
            },
        },
    });
    io.state.root = root;
    assert.throws(() => io.allocateRoot());
    assert.equal(io.state.rootAllocated, true);
    assert.deepEqual(io.state.allocations, [root]);
});
test('terminal overflow refuses without raising either cap', () => {
    const io = createMacNativeIO(0, { taskRoot: NATIVE_TASK, now: () => 0, fs: {} });
    assert.equal(io.take(327680), true);
    assert.equal(io.take(1), false);
    assert.equal(io.state.reason, 'terminal-cap');
    assert.equal(io.state.terminalBytes, 327680);
});
test('publication rejects complete oversized buffer before opening any file', () => {
    const io = createMacNativeIO(0, {
        taskRoot: NATIVE_TASK,
        now: () => 0,
        fs: new Proxy(
            {},
            {
                get() {
                    throw Error('filesystem reached');
                },
            },
        ),
    });
    assert.throws(
        () => io.publish(NATIVE_TASK + '/mock', Buffer.alloc(8193), 8192),
        /false|assert|bytes.length/i,
    );
    assert.equal(io.state.fds.size, 0);
});
function inertChildIO(events) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const io = createMacNativeIO(0, {
        taskRoot: NATIVE_TASK,
        now: () => 0,
        fs: {},
        spawn: () => {
            queueMicrotask(() => events(child));
            return child;
        },
    });
    return { child, io };
}
test('owned child capture requires exit, both EOFs and close with actual nonzero status preserved', async () => {
    const { io } = inertChildIO((child) => {
        child.stdout.emit('data', Buffer.from('out'));
        child.stderr.emit('data', Buffer.from('err'));
        child.emit('exit', 7, null);
        child.stdout.emit('end');
        child.stderr.emit('end');
        child.emit('close');
    });
    const fact = await io.child('/mock/helper', [], {}, '/mock');
    assert.equal(fact.exitCode, 7);
    assert.equal(fact.stdout, 'out');
    assert.equal(fact.stderr, 'err');
    assert.equal(io.state.terminalBytes, 6);
    assert.equal(io.needsHold(), false);
});
test('missing EOF cannot qualify child closure', async () => {
    const { io } = inertChildIO((child) => {
        child.emit('exit', 0, null);
        child.stdout.emit('end');
        child.emit('close');
    });
    await assert.rejects(io.child('/mock/helper', [], {}, '/mock'));
    assert.equal(io.state.reason, 'child-closure-unknown');
    assert.equal(io.state.children[0].stderrEOF, false);
});
test('child stream overflow stops capture and retains unknown process ownership', async () => {
    const { io } = inertChildIO((child) => {
        child.stdout.emit('data', Buffer.alloc(65537));
    });
    await assert.rejects(io.child('/mock/helper', [], {}, '/mock'));
    assert.equal(io.state.children[0].stdout.length, 0);
    assert.equal(io.needsHold(), true);
});
const ownerSource = readFileSync(
    new URL('./fixtures/macos-native-owned.ts', import.meta.url),
    'utf8',
);
function inertOwnerExports(clock = {}) {
    const exports = {};
    const inertFS = { realpathSync: (file) => file };
    const require = (name) => {
        if (name === 'node:assert/strict') return assert;
        if (name === 'node:fs') return inertFS;
        if (name === 'node:string_decoder') return { StringDecoder };
        if (name === 'node:child_process')
            return {
                spawn() {
                    throw Error('native spawn prohibited');
                },
            };
        if (name === '@playwright/test')
            return {
                chromium: {
                    connectOverCDP() {
                        throw Error('framework attach prohibited');
                    },
                },
            };
        throw Error('unapproved mock module');
    };
    const compiled = ts.transpileModule(ownerSource, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    });
    vm.runInNewContext(compiled.outputText, {
        exports,
        require,
        Buffer,
        URL,
        Date,
        performance: { now: clock.now ?? (() => 0) },
        setTimeout: clock.setTimeout ?? setTimeout,
        clearTimeout: clock.clearTimeout ?? clearTimeout,
        WebSocket: class {
            constructor() {
                throw Error('network prohibited');
            }
        },
    });
    return exports;
}
test('actual adapted owner launch uses paused loopback inspector and injected child only', () => {
    const { OwnedDesktop } = inertOwnerExports();
    let observed;
    const desktop = new OwnedDesktop({
        executable: '/mock/app',
        profile: '/mock/profile',
        env: {},
        artifactsDir: '/mock/evidence',
        deadline: 120000,
        offline: true,
        captureBudget: { take: () => true },
    });
    desktop.launch((exe, args, options) => {
        observed = { exe, args, options };
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 5;
        return child;
    });
    assert.equal(observed.args[0], '--inspect-brk=127.0.0.1:0');
    assert.equal(observed.options.shell, false);
    assert.equal(observed.options.detached, false);
    assert.equal(desktop.owner.phaseDeadline, 30000);
    assert.equal(desktop.process().pid, 5);
});
test('actual adapted owner rejects shared terminal-budget overflow without retaining excess bytes', () => {
    const { LaunchCustody } = inertOwnerExports();
    const owner = new LaunchCustody(120000, () => 0, { take: () => false });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    owner.adopt(child);
    child.stdout.emit('data', Buffer.from('excess'));
    assert.equal(owner.reason, 'root-stream-cap');
    assert.equal(owner.streams.capExceeded, true);
    assert.equal(owner.captured.stdout.length, 0);
});
// Actual LocalSocket and MainInspector run with authored in-process protocol peers.
// The peer's error-on-open-browser rule is a possible race model, not a native finding.
async function protocolQuitFixture(options = {}) {
    let mono = 0,
        sequence = 0;
    const timers = new Map(),
        events = [],
        scheduled = [],
        sockets = new Map();
    const deferred = () => {
        let resolve;
        const promise = new Promise((done) => {
            resolve = done;
        });
        return { promise, resolve };
    };
    const browserRequested = deferred(),
        mainRequested = deferred();
    const clock = {
        now: () => mono,
        setTimeout(callback, ms) {
            const id = ++sequence;
            timers.set(id, { callback, due: mono + ms });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
    };
    const { OwnedDesktop } = inertOwnerExports(clock);
    const child = new EventEmitter();
    child.pid = 5;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let desktop,
        quitCalls = 0,
        peerErrors = 0;
    const emitRoot = (code = 0, signal = null) => {
        child.emit('exit', code, signal);
        child.stdout.emit('end');
        child.stderr.emit('end');
        child.emit('close');
    };
    class Socket extends EventEmitter {
        constructor(kind) {
            super();
            this.kind = kind;
            this.readyState = 0;
            this.closeCalls = 0;
            sockets.set(kind, this);
            queueMicrotask(() => {
                this.readyState = 1;
                this.emit('open');
            });
        }
        addEventListener(name, callback) {
            this.on(name, callback);
        }
        send(text) {
            assert.equal(
                this.kind,
                'node',
                'Fake framework never sends browser protocol commands.',
            );
            assert.equal(this.readyState, 1);
            const message = JSON.parse(text);
            if (message.method === 'Runtime.enable') {
                queueMicrotask(() => {
                    this.emit('message', {
                        data: JSON.stringify({
                            method: 'Runtime.executionContextCreated',
                            params: { context: { id: 1, auxData: { isDefault: true } } },
                        }),
                    });
                    this.emit('message', { data: JSON.stringify({ id: message.id, result: {} }) });
                });
                return;
            }
            assert.equal(message.method, 'Runtime.evaluate');
            events.push('main-quit-evaluate');
            // Execute only the actual fixed serialized quit expression. The only require
            // binding is an authored Electron app; setImmediate queues a memory callback.
            const task = Promise.resolve().then(() =>
                vm.runInNewContext(message.params.expression, {
                    require(name) {
                        assert.equal(name, 'electron');
                        return {
                            app: {
                                quit() {
                                    quitCalls++;
                                    events.push('app-quit');
                                    const browser = sockets.get('browser');
                                    if (browser.readyState === 1) {
                                        peerErrors++;
                                        events.push('peer-browser-error');
                                        browser.emit('error');
                                    }
                                    browser.acknowledge();
                                    emitRoot();
                                },
                            },
                        };
                    },
                    setImmediate(callback) {
                        scheduled.push(callback);
                    },
                }),
            );
            void task.then(
                (value) =>
                    this.emit('message', {
                        data: JSON.stringify({ id: message.id, result: { result: { value } } }),
                    }),
                () =>
                    this.emit('message', {
                        data: JSON.stringify({
                            id: message.id,
                            error: { message: 'authored protocol refusal' },
                        }),
                    }),
            );
        }
        close() {
            this.closeCalls++;
            events.push(this.kind + '-close-request');
            if (this.kind === 'browser') browserRequested.resolve();
            else mainRequested.resolve();
            if (this.readyState === 3) return;
            this.readyState = 2;
            if (this.kind === 'browser' && options.browserClose === 'throw')
                throw Error('authored browser close refusal');
            if (this.kind === 'browser' && options.browserClose === 'error') this.emit('error');
            if (!(this.kind === 'browser' && options.browserClose === 'hold'))
                queueMicrotask(() => this.acknowledge());
        }
        acknowledge() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            events.push(this.kind + '-close-ack');
            this.emit('close');
        }
    }
    desktop = new OwnedDesktop(
        {
            executable: '/mock/app',
            profile: '/mock/profile',
            env: {},
            artifactsDir: '/mock/evidence',
            deadline: 120000,
        },
        {
            socket: (url) => new Socket(url.includes('/devtools/') ? 'browser' : 'node'),
            connect: async (transport) => {
                transport.onmessage = () => {};
                transport.onclose = () => events.push('fake-sdk-disconnected');
                return { contexts: () => [{ pages: () => [] }] };
            },
        },
    );
    desktop.launch(() => child);
    child.stderr.emit(
        'data',
        Buffer.from(
            'Debugger listening on ws://127.0.0.1:43123/11111111-1111-1111-1111-111111111111\n' +
                'DevTools listening on ws://127.0.0.1:43124/devtools/browser/22222222-2222-2222-2222-222222222222\n',
        ),
    );
    await desktop.attach();
    desktop.owner.preQuitReceiptVerified = true;
    return {
        desktop,
        owner: desktop.owner,
        events,
        sockets,
        scheduled,
        browserRequested,
        mainRequested,
        emitRoot,
        quitCalls: () => quitCalls,
        peerErrors: () => peerErrors,
        timers,
        advance(ms) {
            mono += ms;
            for (const [id, entry] of [...timers])
                if (entry.due <= mono) {
                    timers.delete(id);
                    entry.callback();
                }
        },
        release() {
            if (!desktop.owner.quitComplete) desktop.owner.freeze('test-control-finished');
            emitRoot();
            for (const socket of sockets.values()) socket.acknowledge();
        },
    };
}

test('actual owned shutdown closes the browser inspector before an authored peer-exit race', async () => {
    const f = await protocolQuitFixture();
    const quit = f.desktop.normalQuit();
    void quit.catch(() => {});
    try {
        await Promise.race([
            f.mainRequested.promise,
            quit.then(() => {
                throw Error('quit returned before its main disconnect');
            }),
        ]);
        assert.equal(f.owner.quitScheduledAck, true);
        assert.equal(f.scheduled.length, 1);
        f.scheduled[0]();
        await quit;
        assert.equal(f.owner.reason, null);
        assert.equal(f.peerErrors(), 0);
        assert.equal(f.quitCalls(), 1);
        assert.ok(f.events.indexOf('browser-close-ack') < f.events.indexOf('main-quit-evaluate'));
        assert.equal(f.owner.quitComplete, true);
        assert.equal(f.owner.exitCode, 0);
        assert.equal(f.owner.signal, null);
        assert.equal(f.owner.streams.stdoutEOF && f.owner.streams.stderrEOF, true);
        assert.equal(f.desktop.mainLink.closedObserved, true);
        assert.equal(f.desktop.browserLink.closedObserved, true);
        assert.doesNotThrow(() => f.owner.active());
    } finally {
        f.release();
        await quit.catch(() => {});
        assert.equal(f.timers.size, 0);
    }
});

// These controls invoke actual owned shutdown code with authored events only.
// The VM denies the default OS spawn, WebSocket and framework entrypoints.
function ownedQuitFixture() {
    const { OwnedDesktop, rendererTransport } = inertOwnerExports();
    const desktop = new OwnedDesktop({
        executable: '/mock/app',
        profile: '/mock/profile',
        env: {},
        artifactsDir: '/mock/evidence',
        deadline: 120000,
    });
    const owner = desktop.owner;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 5;
    owner.adopt(child);
    owner.attachStarted = true;
    owner.attachReturned = true;
    owner.preQuitReceiptVerified = true;
    const deferred = () => {
        let resolve;
        const promise = new Promise((done) => {
            resolve = done;
        });
        return { promise, resolve };
    };
    const mainRequested = deferred(),
        browserRequested = deferred();
    const calls = [],
        scheduled = [];
    let quitCalls = 0;
    const link = (kind, requested) => {
        const closed = deferred();
        return {
            closed,
            closedObserved: false,
            disconnectOnly() {
                calls.push(kind + '-disconnect');
                if (kind === 'main') assert.equal(owner.quitScheduledAck, true);
                else {
                    assert.equal(owner.preQuitReceiptVerified, true);
                    assert.equal(owner.quitIntent, false);
                }
                requested.resolve();
            },
            acknowledge() {
                this.closedObserved = true;
                closed.resolve();
            },
        };
    };
    const mainLink = link('main', mainRequested),
        browserLink = link('browser', browserRequested);
    // Private source dependencies are replaced only in this closed VM instance.
    desktop.main = {
        async evaluate(fn) {
            return vm.runInNewContext('(' + fn.toString() + ')({app})', {
                app: {
                    quit() {
                        quitCalls++;
                    },
                },
                setImmediate(callback) {
                    scheduled.push(callback);
                },
                __name: (value) => value,
            });
        },
        pendingCount: () => 0,
    };
    desktop.mainLink = mainLink;
    desktop.browserLink = browserLink;
    const emitRoot = (code = 0, signal = null) => {
        child.emit('exit', code, signal);
        child.stdout.emit('end');
        child.stderr.emit('end');
        child.emit('close');
    };
    const release = () => {
        emitRoot();
        mainLink.acknowledge();
        browserLink.acknowledge();
    };
    return {
        desktop,
        owner,
        child,
        mainLink,
        browserLink,
        mainRequested,
        browserRequested,
        rendererTransport,
        calls,
        scheduled,
        emitRoot,
        release,
        quitCalls: () => quitCalls,
    };
}

test('actual owned normal shutdown joins independently observed root EOF and both transport acknowledgements', async () => {
    const f = ownedQuitFixture();
    const quit = f.desktop.normalQuit();
    void quit.catch(() => {}); // Observe rejection custody; later await still exposes it.
    try {
        await f.browserRequested.promise;
        assert.equal(f.owner.quitIntent, false);
        assert.equal(f.owner.quitScheduledAck, false);
        assert.equal(f.scheduled.length, 0);
        assert.deepEqual(f.calls, ['browser-disconnect']);
        f.browserLink.acknowledge();
        await f.mainRequested.promise;
        assert.equal(f.owner.quitScheduledAck, true);
        assert.equal(f.scheduled.length, 1);
        assert.equal(f.quitCalls(), 0);
        f.scheduled[0]();
        assert.equal(f.quitCalls(), 1);
        assert.equal(f.owner.quitComplete, false);
        f.emitRoot();
        assert.equal(f.owner.exitCode, 0);
        assert.equal(f.owner.signal, null);
        assert.equal(f.owner.streams.stdoutEOF && f.owner.streams.stderrEOF, true);
        assert.equal(f.owner.quitComplete, false);
        assert.equal(f.mainLink.closedObserved, false);
        f.mainLink.acknowledge();
        await quit;
        assert.equal(f.owner.shutdown.complete, true);
        assert.equal(f.owner.quitComplete, true);
        assert.equal(f.owner.reason, null);
        assert.equal(f.owner.shutdownPending.size, 0);
        assert.doesNotThrow(() => f.owner.active());
        assert.deepEqual(f.calls, ['browser-disconnect', 'main-disconnect']);
    } finally {
        f.release();
        await quit.catch(() => {});
    }
});

test('actual owned socket errors may drain direct closure while retaining the nonpassing incident', async () => {
    for (const kind of ['node', 'browser']) {
        const f = ownedQuitFixture();
        const quit = f.desktop.normalQuit();
        void quit.catch(() => {}); // Observe rejection custody; later await still exposes it.
        try {
            await f.browserRequested.promise;
            f.browserLink.acknowledge();
            await f.mainRequested.promise;
            f.owner.socketError(kind);
            assert.equal(f.owner.shutdown.mode, 'DRAINING_NONPASS');
            assert.equal(f.owner.reason, kind + '-socket-error');
            f.emitRoot();
            f.mainLink.acknowledge();
            await quit;
            assert.equal(f.owner.quitComplete, true);
            assert.equal(f.owner.shutdown.complete, true);
            assert.equal(f.owner.exitObserved && f.owner.closeObserved, true);
            assert.equal(f.owner.streams.stdoutEOF && f.owner.streams.stderrEOF, true);
            assert.equal(f.owner.pendingWaits.size + f.owner.shutdownPending.size, 0);
            assert.equal(f.owner.publicationFDs.size, 0);
            assert.throws(() => f.owner.active(), new RegExp(kind + '-socket-error'));
            assert.equal(f.owner.shutdown.mode, 'RETAINED_UNKNOWN');
            assert.equal(f.owner.reason, kind + '-socket-error');
        } finally {
            f.release();
            await quit.catch(() => {});
        }
    }
});

test('actual renderer transport close refuses before during and after independently observed normal shutdown', async () => {
    for (const timing of ['before', 'preclose', 'during', 'after']) {
        const f = ownedQuitFixture();
        let sent = 0,
            disconnected = 0;
        const transport = f.rendererTransport(f.owner, {
            send() {
                sent++;
            },
            disconnectOnly() {
                disconnected++;
            },
        });
        let quit;
        try {
            if (timing !== 'before') {
                quit = f.desktop.normalQuit();
                void quit.catch(() => {});
                await f.browserRequested.promise;
                if (timing !== 'preclose') {
                    f.browserLink.acknowledge();
                    await f.mainRequested.promise;
                    assert.equal(f.owner.quitScheduledAck, true);
                    assert.equal(f.scheduled.length, 1);
                    if (timing === 'after') {
                        f.release();
                        await quit;
                        assert.equal(f.owner.reason, null);
                        assert.equal(f.owner.quitComplete, true);
                    }
                } else {
                    assert.equal(f.owner.quitIntent, false);
                    assert.equal(f.scheduled.length, 0);
                }
            }
            transport.close();
            assert.equal(f.owner.reason, 'framework-transport-close-refused');
            assert.equal(sent, 0);
            assert.equal(disconnected, 0);
            assert.throws(() => f.owner.active(), /framework-transport-close-refused/);
            if (timing === 'preclose' || timing === 'during') {
                f.release();
                await assert.rejects(quit, /shutdown-retained|framework-transport-close-refused/);
                assert.equal(f.owner.quitComplete, false);
                assert.equal(f.scheduled.length, timing === 'preclose' ? 0 : 1);
            } else if (timing === 'after') {
                assert.equal(f.owner.quitComplete, true);
                assert.equal(f.owner.shutdown.mode, 'RETAINED_UNKNOWN');
            }
        } finally {
            f.release();
            if (quit) await quit.catch(() => {});
        }
    }
});

test('actual renderer transport preserves forbidden termination commands and sends only permitted data', () => {
    const { LaunchCustody, rendererTransport } = inertOwnerExports();
    const permittedOwner = new LaunchCustody(120000, () => 0);
    const messages = [];
    const permitted = rendererTransport(permittedOwner, {
        send(message) {
            messages.push(message);
        },
        disconnectOnly() {
            throw Error('physical close prohibited');
        },
    });
    const read = { id: 1, method: 'Runtime.enable', params: {} };
    permitted.send(read);
    assert.deepEqual(messages, [read]);
    for (const method of [
        'Browser.close',
        'Browser.crash',
        'Target.closeTarget',
        'Target.disposeBrowserContext',
        'Page.close',
    ]) {
        const owner = new LaunchCustody(120000, () => 0);
        const transport = rendererTransport(owner, {
            send() {
                throw Error('forbidden command forwarded');
            },
            disconnectOnly() {
                throw Error('physical close prohibited');
            },
        });
        assert.throws(
            () => transport.send({ id: 2, method, params: {} }),
            /forbidden-termination-command/,
        );
        assert.equal(owner.reason, 'forbidden-termination-command');
    }
});

test('actual browser preclose refuses errors cancellation and missing or late acknowledgements', async () => {
    for (const mode of ['throw', 'error', 'late', 'cancel', 'error-after-ack']) {
        const f = await protocolQuitFixture({
            browserClose: ['late', 'cancel'].includes(mode) ? 'hold' : mode,
        });
        const quit = f.desktop.normalQuit();
        void quit.catch(() => {});
        try {
            await f.browserRequested.promise;
            if (mode === 'error-after-ack') {
                await Promise.race([f.mainRequested.promise, quit]);
                assert.equal(f.sockets.get('browser').readyState, 3);
                f.sockets.get('browser').emit('error');
                assert.equal(f.owner.shutdown.mode, 'DRAINING_NONPASS');
                f.scheduled[0]();
                await quit;
                assert.equal(f.owner.quitComplete, true);
                assert.equal(f.owner.reason, 'browser-socket-error');
                assert.throws(() => f.owner.active(), /browser-socket-error/);
            } else {
                assert.equal(f.owner.quitIntent, false);
                assert.equal(f.quitCalls(), 0);
                assert.equal(f.events.includes('main-quit-evaluate'), false);
                assert.equal(f.sockets.get('node').readyState, 1);
                if (mode === 'late') {
                    assert.equal(f.owner.shutdown.until, 20000);
                    assert.equal(f.owner.shutdownPending.size, 1);
                    f.advance(20001);
                }
                if (mode === 'cancel') f.owner.freeze('authored-shutdown-cancelled');
                await assert.rejects(quit);
                const expected = {
                    throw: 'browser-transport-close-failed',
                    error: 'browser-socket-error',
                    late: 'shutdown-deadline',
                    cancel: 'authored-shutdown-cancelled',
                }[mode];
                assert.equal(f.owner.reason, expected);
                assert.equal(f.owner.shutdown.mode, 'RETAINED_UNKNOWN');
                assert.equal(f.owner.quitComplete, false);
                f.sockets.get('browser').acknowledge();
                await Promise.resolve();
                await Promise.resolve();
                assert.equal(f.owner.reason, expected);
                assert.throws(() => f.owner.active());
                assert.equal(f.quitCalls(), 0);
                assert.equal(f.events.includes('main-quit-evaluate'), false);
            }
        } finally {
            f.release();
            await quit.catch(() => {});
            assert.equal(f.timers.size, 0);
        }
    }
});

test('actual browser preclose preserves prequit workload gates and refuses a premature root exit', async () => {
    for (const defect of ['prequit', 'generic-pending', 'main-pending', 'publication-fd']) {
        const f = await protocolQuitFixture();
        if (defect === 'prequit') f.owner.preQuitReceiptVerified = false;
        if (defect === 'generic-pending') f.owner.pendingWaits.set(99, { phase: 'file-open' });
        if (defect === 'main-pending') f.owner.mainPendingCount = 1;
        if (defect === 'publication-fd') f.owner.publicationFDs.add(99);
        const quit = f.desktop.normalQuit();
        void quit.catch(() => {});
        try {
            await assert.rejects(quit);
            assert.equal(f.sockets.get('browser').closeCalls, 0);
            assert.equal(f.owner.quitIntent, false);
            assert.equal(f.events.includes('main-quit-evaluate'), false);
            assert.equal(f.quitCalls(), 0);
        } finally {
            f.release();
            await quit.catch(() => {});
            assert.equal(f.timers.size, 0);
        }
    }
    const f = await protocolQuitFixture({ browserClose: 'hold' });
    const quit = f.desktop.normalQuit();
    void quit.catch(() => {});
    try {
        await f.browserRequested.promise;
        assert.equal(f.owner.quitIntent, false);
        f.emitRoot();
        await assert.rejects(quit, /unexpected-root-exit|shutdown-retained/);
        assert.equal(f.owner.reason, 'unexpected-root-exit');
        assert.equal(f.owner.quitComplete, false);
        f.sockets.get('browser').acknowledge();
        await Promise.resolve();
        assert.equal(f.events.includes('main-quit-evaluate'), false);
        assert.equal(f.quitCalls(), 0);
        assert.throws(() => f.owner.active(), /unexpected-root-exit/);
    } finally {
        f.release();
        await quit.catch(() => {});
        assert.equal(f.timers.size, 0);
    }
});

test('actual owned shutdown completion rejects missing EOF abnormal exit and pending owner resources', () => {
    for (const defect of [
        'stderr-eof',
        'nonzero-exit',
        'signal',
        'generic-pending',
        'shutdown-pending',
        'main-pending',
        'publication-fd',
    ]) {
        const f = ownedQuitFixture();
        f.owner.beginShutdown();
        f.owner.quitIntent = true;
        f.owner.quitScheduledAck = true;
        f.child.emit(
            'exit',
            defect === 'nonzero-exit' ? 7 : 0,
            defect === 'signal' ? 'SIGTERM' : null,
        );
        f.child.stdout.emit('end');
        if (defect !== 'stderr-eof') f.child.stderr.emit('end');
        f.child.emit('close');
        if (defect === 'generic-pending') f.owner.pendingWaits.set(1, { phase: 'file-open' });
        if (defect === 'shutdown-pending')
            f.owner.shutdownPending.set(1, { phase: 'transport-close' });
        if (defect === 'main-pending') f.owner.mainPendingCount = 1;
        if (defect === 'publication-fd') f.owner.publicationFDs.add(99); // Synthetic descriptor identity only.
        assert.throws(() => f.owner.finishShutdown());
        assert.equal(f.owner.shutdown.complete, false);
        assert.equal(f.owner.quitComplete, false);
    }
});

test('locked SDK natural connection close does not invoke the owned transport close callback', async () => {
    const packageURL = new URL('../node_modules/playwright-core/package.json', import.meta.url);
    const metadata = JSON.parse(readFileSync(packageURL, 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    assert.equal(metadata.version, '1.63.0');
    assert.equal(metadata.version, lock.packages['node_modules/playwright-core'].version);
    const sdkSource = readFileSync(new URL('./lib/coreBundle.js', packageURL), 'utf8');
    assert.equal(
        digest(sdkSource),
        '549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171',
    );
    const parsed = ts.createSourceFile(
        'locked-coreBundle.js',
        sdkSource,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    assert.equal(parsed.parseDiagnostics.length, 0);
    const classes = [];
    const visit = (node) => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            node.left.text === 'CRConnection' &&
            ts.isClassExpression(node.right)
        )
            classes.push(node.right);
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.equal(classes.length, 1);
    const select = (name) => {
        const matches = classes[0].members.filter(
            (node) =>
                ts.isMethodDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name,
        );
        assert.equal(matches.length, 1);
        return matches[0].getText(parsed);
    };
    const disconnected = Symbol('fake-disconnected');
    // Only these two ACTUAL method bodies run. No bundle import, constructor,
    // SDK session, downstream event listener, native port or module code executes.
    const methods = vm.runInNewContext('({' + select('_onClose') + ',' + select('close') + '})', {
        Promise,
        helper: {
            formatBrowserLogs: (logs, reason) => {
                assert.deepEqual(logs, []);
                return reason;
            },
        },
        ConnectionEvents: { Disconnected: disconnected },
    });
    const { LaunchCustody, rendererTransport } = inertOwnerExports();
    const fixture = () => {
        const owner = new LaunchCustody(120000, () => 0),
            events = [];
        let sends = 0,
            disconnects = 0,
            disposed = 0;
        const link = {
            send() {
                sends++;
            },
            disconnectOnly() {
                disconnects++;
            },
        };
        const transport = rendererTransport(owner, link);
        const receiver = {
            _closed: false,
            _transport: transport,
            _browserLogsCollector: { recentLogs: () => [] },
            rootSession: {
                dispose() {
                    disposed++;
                },
            },
            emit(event) {
                events.push(event);
            },
        };
        transport.onmessage = () => {};
        transport.onclose = (reason) => methods._onClose.call(receiver, reason);
        return { owner, receiver, link, events, counts: () => ({ sends, disconnects, disposed }) };
    };
    const natural = fixture();
    natural.link.onclose();
    assert.equal(natural.receiver._closed, true);
    assert.equal(natural.receiver._transport.onclose, undefined);
    assert.equal(natural.receiver._transport.onmessage, undefined);
    assert.deepEqual(natural.counts(), { sends: 0, disconnects: 0, disposed: 1 });
    assert.equal(natural.events.length, 0);
    await Promise.resolve();
    assert.deepEqual(natural.events, [disconnected]);
    methods.close.call(natural.receiver);
    assert.equal(natural.owner.reason, null);
    assert.deepEqual(natural.counts(), { sends: 0, disconnects: 0, disposed: 1 });
    const explicit = fixture();
    methods.close.call(explicit.receiver);
    assert.equal(explicit.owner.reason, 'framework-transport-close-refused');
    assert.deepEqual(explicit.counts(), { sends: 0, disconnects: 0, disposed: 0 });
});

function offlineCallback() {
    const file = ts.createSourceFile(
            'owner.ts',
            ownerSource,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        ),
        found = [];
    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'evaluate' &&
            node.arguments[0]?.getText(file).includes('__hubInstallerOffline')
        )
            found.push(node.arguments[0]);
        ts.forEachChild(node, visit);
    };
    visit(file);
    assert.equal(found.length, 1);
    const javascript = ts.transpileModule(
        'const callback = ' + found[0].getText(file) + '; callback;',
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText;
    return javascript;
}
for (const [name, ready, windows, expected] of [
    ['not ready yet', false, [], true],
    ['already ready before window', true, [], true],
    ['window already exists', true, [{}], false],
]) {
    test('actual offline scheduling callback: ' + name, async () => {
        let calls = 0;
        const electron = {
            app: { isReady: () => ready, whenReady: () => Promise.resolve() },
            session: {
                defaultSession: {
                    enableNetworkEmulation: (options) => {
                        assert.equal(options.offline, true);
                        calls++;
                    },
                },
            },
            BrowserWindow: { getAllWindows: () => windows },
        };
        const sandbox = {
            require: (name) => {
                assert.equal(name, 'electron');
                return electron;
            },
        };
        const callback = vm.runInNewContext(offlineCallback(), sandbox);
        assert.equal(callback(electron).scheduled, true);
        await Promise.resolve();
        assert.equal(calls, 1);
        assert.equal(sandbox.__hubInstallerOffline.applied, true);
        assert.equal(sandbox.__hubInstallerOffline.readyBeforeWindow, expected);
    });
}

test('genuine v0.5.2 prior uses only legacy exportReport and preserves supported profile/report bytes across update', async () => {
    const m = model({ legacyPrior: true }),
        result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 0, result.state.failure?.stack ?? result.output);
    assert.equal(m.log.filter(([name]) => name === 'legacy-export').length, 1);
    assert.deepEqual(
        m.log.find(([name]) => name === 'legacy-export')[1],
        legacyDiagnosticSnapshot(),
    );
    const row = result.state.actions.result.cases.find(
        (item) => item.id === 'macos-bundle:update-distinct-version',
    );
    assert.equal(row.status, 'verified');
    assert.equal(row.priorVersion, '0.5.2');
    assert.equal(row.finalVersion, '0.6.0');
    const seed = row.actions.find((item) => item.method === 'seedApplicationData');
    assert.deepEqual(seed.facts, {
        origin: 'application',
        reportFormat: 'legacy-diagnostic-schema1',
        profileFixture: 'known-hosts-record-v052',
        profileUseVerified: false,
    });
    const snaps = row.actions
        .filter((item) => item.method === 'snapshot')
        .map((item) => item.facts);
    const prior = snaps.find((value) => value.version === '0.5.2' && value.reportFiles.length);
    const after = snaps.at(-1);
    assert.deepEqual(after.profileFiles, prior.profileFiles);
    assert.deepEqual(after.reportFiles, prior.reportFiles);
    const fixture = m.root + '/update-distinct-version';
    assert.deepEqual(
        JSON.parse(m.files.get(fixture + '/profile/known-hosts.json')),
        legacyKnownHostsFixture(),
    );
    assert.equal(
        JSON.parse(m.files.get(fixture + '/reports/legacy-diagnostic.json')).applicationVersion,
        '0.5.2',
    );
    assert.equal(
        m.files.has(fixture + '/profile/console-captures-v2/' + CAPTURE_ID + '/header.json'),
        false,
    );
    assert.equal(result.state.actions.result.qualificationStatus, 'unverified');
});
for (const [name, options, reason, caseId] of [
    [
        'new API absent',
        { missingConsole: true },
        'CONSOLE_STORAGE_SEED_API_UNAVAILABLE',
        'macos-bundle:repair',
    ],
    [
        'legacy API absent',
        { legacyPrior: true, missingLegacyExport: true },
        'LEGACY_REPORT_SEED_API_UNAVAILABLE',
        'macos-bundle:update-distinct-version',
    ],
    [
        'new API contradicts genuine old source binding',
        { legacyPrior: true, legacyHasConsole: true },
        'LEGACY_SEED_API_BINDING_MISMATCH',
        'macos-bundle:update-distinct-version',
    ],
])
    test(
        'known unsupported path is unavailable, settled and later cases unexecuted: ' + name,
        async () => {
            const m = model(options),
                result = await runMacNativeCLI(m.argv('--run'), m.deps);
            assert.equal(result.exitCode, 2);
            assert.equal(result.state.holdRequired, false);
            const actions = result.state.actions.result;
            assert.equal(actions.status, 'unavailable');
            assert.equal(actions.reason, reason);
            const index = actions.cases.findIndex((row) => row.id === caseId);
            assert.equal(actions.cases[index].status, 'unavailable');
            assert.ok(
                actions.cases
                    .slice(index + 1)
                    .every((row) => row.status === 'unexecuted' && row.actions.length === 0),
            );
            assert.deepEqual(actions.cases[index].actions.at(-1).facts, {
                origin: 'unsupported',
                reason,
                ownerSettled: true,
            });
            assert.equal(
                m.io.state.desktops.every((owner) => owner.closed),
                true,
            );
            assert.equal(
                m.log.some(([name]) => name === 'legacy-export'),
                false,
            );
            validateMacInstallerActionResult(actions);
            assert.equal(JSON.parse(result.output).actions.status, 'unavailable');
            assert.equal(JSON.parse(result.output).actions.reason, reason);
            assert.deepEqual(
                JSON.parse(result.output).actions.cases,
                actions.cases.map(({ id, status }) => ({ id, status })),
            );
            const receipt = JSON.parse(m.files.get(m.root + '/evidence/observation.json'));
            assert.equal(receipt.status, 'blocked');
            assert.equal(receipt.cases[index].status, 'unavailable');
            assert.equal(result.state.publicationComplete, true);
        },
    );
test('failed legacy export stays UNKNOWN, retains owner and cannot become unavailable or verified', async () => {
    const m = model({ legacyPrior: true, legacyExportFalse: true }),
        result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.actions.result.status, 'unknown');
    assert.equal(result.state.holdRequired, true);
    const rows = result.state.actions.result.cases,
        index = rows.findIndex((row) => row.id === 'macos-bundle:update-distinct-version');
    assert.ok(rows.slice(index + 1).every((row) => row.status === 'unexecuted'));
    assert.equal(m.io.state.desktops.at(-1).closed, false);
});
test('missing legacy API with uncertain normal-quit return remains UNKNOWN and retained', async () => {
    const m = model({ legacyPrior: true, missingLegacyExport: true });
    class BadQuit extends m.Desktop {
        async normalQuit() {
            if (this.options.profile.includes('/update-distinct-version/'))
                throw Error('PRIVATE_QUIT_CANARY');
            return super.normalQuit();
        }
    }
    m.deps.createEffects = (admitted) =>
        createMacNativeEffects(admitted, m.io, { Desktop: BadQuit });
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.state.actions.result.status, 'unknown');
    assert.equal(result.state.holdRequired, true);
    assert.equal(JSON.parse(result.output).actions.status, 'unknown');
    assert.ok(!result.output.includes('PRIVATE_QUIT_CANARY'));
});
test('unavailable result validator rejects missing settlement, arbitrary reason or continued later work', async () => {
    const m = model({ legacyPrior: true, missingLegacyExport: true }),
        result = await runMacNativeCLI(m.argv('--run'), m.deps);
    const original = result.state.actions.result,
        index = original.cases.findIndex((row) => row.status === 'unavailable');
    for (const mutate of [
        (copy) => {
            copy.cases[index].actions.at(-1).facts.ownerSettled = false;
        },
        (copy) => {
            copy.reason = 'ARBITRARY_PRIVATE_TEXT';
        },
        (copy) => {
            copy.cases[index + 1].status = 'verified';
        },
    ]) {
        const copy = structuredClone(original);
        mutate(copy);
        assert.throws(() => validateMacInstallerActionResult(copy));
    }
});
test('legacy fixture factories lend no stable comparison object to a caller', () => {
    const one = legacyDiagnosticSnapshot();
    one.results[0].stdout = 'mutated';
    assert.notEqual(legacyDiagnosticSnapshot().results[0].stdout, one.results[0].stdout);
    const hosts = legacyKnownHostsFixture();
    hosts['synthetic.fixture.invalid:22'] = 'mutated';
    assert.notEqual(
        legacyKnownHostsFixture()['synthetic.fixture.invalid:22'],
        hosts['synthetic.fixture.invalid:22'],
    );
});
test('legacy report validation rejects new schema, wrong producer version and modified identity data', () => {
    const input = legacyDiagnosticSnapshot(),
        original = {
            application: 'Diagnostic Hub',
            applicationVersion: '0.5.2',
            ...input,
            diagnostics: structuredClone(input.results),
        };
    validateLegacyDiagnosticReport(original);
    for (const mutate of [
        (v) => {
            v.schemaVersion = 2;
        },
        (v) => {
            v.applicationVersion = '0.6.0';
        },
        (v) => {
            v.results[0].stdout = 'changed';
        },
        (v) => {
            v.diagnostics = [];
        },
    ]) {
        const copy = structuredClone(original);
        mutate(copy);
        assert.throws(() => validateLegacyDiagnosticReport(copy));
    }
});

const LEGACY_SOURCE_DATA = {
    'main.ts': {
        sourcePath: 'electron/main.ts',
        blob: '6cd9f28ba3766991d40c3c207fb1ff51e9b039b9',
        bytes: 18922,
        sha256: 'f867d73253dd10d80cd22a224538b0398fa30fcbcf66bcf0f1bd076e4ecdbcb4',
    },
    'report.ts': {
        sourcePath: 'shared/report.ts',
        blob: '692258549dc99d682ca0e7ab441e79be87aacebf',
        bytes: 5059,
        sha256: '5993b4b4c24d3690ad8c16c1686c93f4c50f5c7b0801603a95b983b5a5f5a5bb',
    },
    'probes.ts': {
        sourcePath: 'shared/diagnostics/probes.ts',
        blob: '85f2cfad3082ffba636478fd191163db8056c7b1',
        bytes: 16930,
        sha256: '45ee9fc12d98bcde7f2a4cedb3b64921399e71928f02eb6ce9331bac6cce156b',
    },
};
function readLegacySource(file) {
    assert.ok(Object.hasOwn(LEGACY_SOURCE_DATA, file));
    const identity = LEGACY_SOURCE_DATA[file];
    const bytes = readFileSync(
        new URL('./fixtures/legacy-v052-source/' + file + '.txt', import.meta.url),
    );
    assert.equal(bytes.length, identity.bytes);
    assert.equal(digest(bytes), identity.sha256);
    return bytes.toString('utf8');
}
function genuineLegacyFunction(file, name, sandbox) {
    const source = readLegacySource(file);
    const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    const node = parsed.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(node);
    const code = node.getText(parsed).replace(/^export\s+/, '') + '; ' + name + ';';
    const javascript = ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return vm.runInNewContext(javascript, sandbox);
}
test('actual v0.5.2 validateSnapshot source accepts schema1 fixture and rejects substituted schema/mode', () => {
    const text = readLegacySource('probes.ts');
    const file = ts.createSourceFile(
            'probes.ts',
            text,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        ),
        ids = [];
    const visit = (node) => {
        if (
            ts.isPropertyAssignment(node) &&
            node.name.getText(file) === 'id' &&
            ts.isStringLiteral(node.initializer)
        )
            ids.push(node.initializer.text);
        ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(ids.includes('identity') && ids.length > 1);
    assert.equal(new Set(ids).size, ids.length);
    const validate = genuineLegacyFunction('report.ts', 'validateSnapshot', {
        probes: ids.map((id) => ({ id })),
        validateNetworkEvidence() {
            throw Error('unexpected network-evidence fixture');
        },
    });
    const value = structuredClone(validate(legacyDiagnosticSnapshot()));
    assert.equal(value.results.length, ids.length);
    assert.deepEqual(
        value.results.find((row) => row.id === 'identity'),
        legacyDiagnosticSnapshot().results[0],
    );
    assert.throws(() => validate({ ...legacyDiagnosticSnapshot(), schemaVersion: 2 }));
    assert.throws(() => validate({ ...legacyDiagnosticSnapshot(), mode: 'console' }));
});
test('actual v0.5.2 verifyHost source recognizes known-host schema using inert reads and no connection/prompt', async () => {
    let reads = 0;
    const verify = genuineLegacyFunction('main.ts', 'verifyHost', {
        path,
        app: { getPath: () => '/mock/profile' },
        readFile: async (file) => {
            assert.equal(file, '/mock/profile/known-hosts.json');
            reads++;
            return JSON.stringify(legacyKnownHostsFixture());
        },
        hostVerification: {
            request() {
                throw Error('unexpected trust prompt');
            },
        },
        mkdir() {
            throw Error('unexpected write');
        },
        writeFile() {
            throw Error('unexpected write');
        },
    });
    assert.equal(
        await verify(
            'synthetic.fixture.invalid:22',
            legacyKnownHostsFixture()['synthetic.fixture.invalid:22'],
        ),
        true,
    );
    assert.equal(reads, 1);
});
test('actual old host-store parser rejects invalid profile data with inert effects', async () => {
    for (const value of [[], { host: 42 }]) {
        const verify = genuineLegacyFunction('main.ts', 'verifyHost', {
            path,
            app: { getPath: () => '/mock/profile' },
            readFile: async () => JSON.stringify(value),
        });
        await assert.rejects(verify('synthetic.fixture.invalid:22', 'not-used'));
    }
});

function knownRepairFailureModel() {
    const m = model();
    m.deps.createEffects = async (admitted) => {
        const native = await createMacNativeEffects(admitted, m.io, { Desktop: m.Desktop });
        let repairInstalls = 0;
        return {
            ...native,
            async install(fixture, ...args) {
                const fact = await native.install(fixture, ...args);
                if (fixture.id === 'macos-bundle:repair') repairInstalls++;
                return fact;
            },
            async snapshot(fixture) {
                const value = await native.snapshot(fixture);
                if (
                    fixture.id === 'macos-bundle:repair' &&
                    repairInstalls === 2 &&
                    value.reportFiles.length
                )
                    value.reportFiles[0].sha256 = '0'.repeat(64);
                return value;
            },
        };
    };
    return m;
}
test('N1 quiescent failed repair retains full failed case, predecessors, later-unexecuted cases and terminal facts', async () => {
    const m = knownRepairFailureModel(),
        result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.holdRequired, false);
    assert.equal(result.state.publicationComplete, true);
    assert.equal(
        m.io.state.desktops.every((owner) => owner.closed),
        true,
    );
    const stage = JSON.parse(m.files.get(m.root + '/evidence/stages.json')),
        receipt = JSON.parse(m.files.get(m.root + '/evidence/observation.json'));
    assert.deepEqual(stage.nativeActionResults, result.state.actions.result);
    assert.equal(stage.nativeActionResults.reason, 'ACTION_ASSERTION_FAILED');
    assert.equal(receipt.status, 'failed');
    assert.ok(
        stage.nativeActionResults.cases.slice(0, 3).every((row) => row.status === 'verified'),
    );
    assert.equal(stage.nativeActionResults.cases[3].id, 'macos-bundle:repair');
    assert.equal(stage.nativeActionResults.cases[3].status, 'failed');
    assert.ok(
        stage.nativeActionResults.cases
            .slice(4)
            .every((row) => row.status === 'unexecuted' && row.actions.length === 0),
    );
    for (const name of ['terminal-index.json', 'stages.json', 'observation.json']) {
        const file = m.root + '/evidence/' + name;
        assert.ok(m.files.has(file));
        assert.ok(m.log.some(([kind, selected]) => kind === 'readback' && selected === file));
        assert.ok(m.files.get(file).length <= (name === 'observation.json' ? 8192 : 65536));
    }
    assert.equal(JSON.parse(result.output).status, 'ACTIONS_FAILED_EVIDENCE_RETAINED');
});
for (const late of [false, true])
    test(
        'N1 publication ' +
            (late ? 'late return' : 'error') +
            ' retains complete private facts with no retry/later write',
        async () => {
            const m = knownRepairFailureModel(),
                publish = m.io.publish;
            let attempts = 0;
            m.io.publish = (file, bytes, ...args) => {
                if (file.endsWith('/stages.json')) {
                    attempts++;
                    if (late) {
                        publish(file, bytes, ...args);
                        m.io.beforeExpiry = () => false;
                    }
                    m.io.state.reason = late ? 'native-deadline' : 'native-io-refusal';
                    throw Error('PRIVATE_PUBLICATION_CANARY');
                }
                return publish(file, bytes, ...args);
            };
            const result = await runMacNativeCLI(m.argv('--run'), m.deps);
            assert.equal(result.exitCode, 2);
            assert.equal(result.state.holdRequired, true);
            assert.equal(result.state.publicationComplete, false);
            assert.equal(result.state.actions.result.cases[3].status, 'failed');
            assert.equal(attempts, 1);
            assert.equal(m.files.has(m.root + '/evidence/observation.json'), false);
            assert.ok(!result.output.includes('PRIVATE_PUBLICATION_CANARY'));
            if (late) assert.equal(result.output, '');
        },
    );
test('N1 unknown effects retain custody without attempting failure publication', async () => {
    const m = model();
    m.io.child = async () => {
        throw Error('private child refusal');
    };
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.state.actions.result.status, 'unknown');
    assert.equal(result.state.holdRequired, true);
    assert.equal(m.files.has(m.root + '/evidence/terminal-index.json'), false);
    assert.equal(m.files.has(m.root + '/evidence/stages.json'), false);
});
for (const asynchronous of [false, true])
    test(
        'N2 ' +
            (asynchronous ? 'asynchronous' : 'throwing') +
            ' stdout error cannot bypass prior custody registration/parking',
        async () => {
            const stdout = new EventEmitter(),
                globals = {},
                order = [],
                codes = [];
            const result = {
                exitCode: 2,
                output: 'safe diagnostic\n',
                state: { holdRequired: true, privateOwner: { retained: true } },
            };
            stdout.write = () => {
                assert.equal(globals.__hubNativeRetained, result.state);
                assert.deepEqual(order, ['park']);
                order.push('write');
                if (asynchronous) {
                    queueMicrotask(() => stdout.emit('error', Error('PRIVATE_CHANNEL_CANARY')));
                    return true;
                }
                throw Error('PRIVATE_CHANNEL_CANARY');
            };
            await finishMacNativeEntry(result, {
                stdout,
                globals,
                setExitCode: (code) => codes.push(code),
                park: (state) => {
                    assert.equal(state, result.state);
                    order.push('park');
                    return Promise.resolve();
                },
            });
            await Promise.resolve();
            assert.deepEqual(order, ['park', 'write']);
            assert.equal(result.state.publicOutputFailure, 'PUBLIC_OUTPUT_FAILED');
            assert.equal(codes.at(-1), 2);
            assert.equal(result.state.holdRequired, true);
            assert.equal(globals.__hubNativeRetained.privateOwner.retained, true);
        },
    );
test('N2 known-closed failure reports once, exits nonzero and needs no fake HOLD or closure', async () => {
    const stdout = new EventEmitter(),
        globals = {},
        writes = [],
        codes = [];
    stdout.write = (bytes) => {
        writes.push(bytes);
        return true;
    };
    const result = {
        exitCode: 2,
        output: 'known failed evidence retained\n',
        state: { holdRequired: false, publicationComplete: true },
    };
    await finishMacNativeEntry(result, {
        stdout,
        globals,
        setExitCode: (code) => codes.push(code),
        park: () => {
            throw Error('should not park');
        },
    });
    assert.deepEqual(writes, [result.output]);
    assert.equal(codes.at(-1), 2);
    assert.equal(result.state.publicOutputFailure, undefined);
});
test('N2 bounded successful output remains unchanged; late asynchronous failure becomes nonpassing', async () => {
    const stdout = new EventEmitter(),
        writes = [],
        codes = [],
        globals = {};
    stdout.write = (bytes) => {
        writes.push(bytes);
        return true;
    };
    const result = {
        exitCode: 0,
        output: 'bounded result\n',
        state: { holdRequired: false, publicationComplete: true },
    };
    await finishMacNativeEntry(result, {
        stdout,
        globals,
        setExitCode: (code) => codes.push(code),
        park: () => {
            throw Error('should not park');
        },
    });
    assert.deepEqual(writes, [result.output]);
    assert.equal(codes.at(-1), 0);
    stdout.emit('error', Error('private late error'));
    assert.equal(codes.at(-1), 2);
    assert.equal(result.state.publicOutputFailure, 'PUBLIC_OUTPUT_FAILED');
});

test('native terminal row publication excludes private environment and record properties', async () => {
    const m = model(),
        original = m.io.child;
    const canary = 'PRIVATE_ENVIRONMENT_AND_RECORD_CANARY';
    m.io.child = async (...args) => {
        args[2].PRIVATE_TOKEN = canary;
        const result = await original(...args);
        m.io.state.children.at(-1).privateCredential = canary;
        return result;
    };
    const result = await runMacNativeCLI(m.argv('--run'), m.deps);
    assert.equal(result.exitCode, 0, result.output + (result.state.failure?.stack ?? ''));
    const records = [...m.files].filter(([name]) =>
        /\/evidence\/(?:child-[0-9]+\.json|terminal-index\.json)$/.test(name),
    );
    assert.equal(records.length, 16);
    for (const [, bytes] of records) {
        assert.ok(!bytes.toString().includes(canary));
        assert.ok(!bytes.toString().includes('PRIVATE_TOKEN'));
        assert.ok(!bytes.toString().includes('privateCredential'));
    }
    assert.equal(JSON.parse(m.files.get(m.root + '/evidence/observation.json')).status, 'blocked');
});

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
    NATIVE_TASK,
    NATIVE_EFFECTS,
    NATIVE_LIMITS,
} from '../scripts/lib/macos-native-contract.mjs';
import {
    createMacNativeEffects,
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
import { digest, installerCases } from '../scripts/lib/staged-artifact-gate.mjs';

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
    ];
    write(sourcePins[0].path, 'mock-node');
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
        state: {
            root: null,
            rootAllocated: false,
            claim: null,
            deadline: 999999999,
            reason: null,
            fds: new Set(),
            children: [],
            desktops: [],
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
        row: () => {},
        wait: async (_label, fn) => fn(),
        beforeExpiry: () => true,
        needsHold: () => io.state.desktops.some((entry) => !entry.closed),
    };
    io.child = async (exe, args, env, cwd) => {
        log.push(['child', exe, args, env, cwd]);
        const version = args[2].slice(1),
            target = env.HUB_NATIVE_TARGET;
        if (env.HUB_NATIVE_FAULT) {
            write(env.HUB_NATIVE_FAULT_MARKER, 'activation-return-failure\n');
            return {
                command: [exe, ...args],
                exitObserved: true,
                exitCode: 70,
                signal: null,
                error: 'none',
                stdout: '',
                stderr: '',
            };
        }
        if (io.state.desktops.some((entry) => entry.fixture.target === target && !entry.closed))
            return {
                command: [exe, ...args],
                exitObserved: true,
                exitCode: 1,
                signal: null,
                error: 'none',
                stdout: '',
                stderr: 'Quit Diagnostic Hub',
            };
        trees.set(target, { version, inventory: inventories[version] });
        write(path.join(target, 'Contents/Info.plist'), infos[version].infoBytes);
        return {
            command: [exe, ...args],
            exitObserved: true,
            exitCode: 0,
            signal: null,
            error: 'none',
            stdout: '',
            stderr: '',
        };
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
    assert.deepEqual(stages.command.slice(-m.argv('--run').length), m.argv('--run'));
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
    const io = createMacNativeIO(0, { now: () => 0, fs: {} });
    assert.equal(io.take(327680), true);
    assert.equal(io.take(1), false);
    assert.equal(io.state.reason, 'terminal-cap');
    assert.equal(io.state.terminalBytes, 327680);
});
test('publication rejects complete oversized buffer before opening any file', () => {
    const io = createMacNativeIO(0, {
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
function inertOwnerExports() {
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
        performance: { now: () => 0 },
        setTimeout,
        clearTimeout,
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

function genuineLegacyFunction(file, name, sandbox) {
    const source = readFileSync(
        new URL('../../basis/legacy-v052/' + file, import.meta.url),
        'utf8',
    );
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
    const text = readFileSync(
        new URL('../../basis/legacy-v052/probes.ts', import.meta.url),
        'utf8',
    );
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

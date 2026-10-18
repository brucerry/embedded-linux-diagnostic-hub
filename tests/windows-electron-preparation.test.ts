// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { dependencyFacts, fileIdentity } from '../scripts/lib/windows-preflight.mjs';
import { prepareAndFreezePilotDependencies } from '../scripts/lib/pilot-dependencies.mjs';
import {
    electronPreparation as limits,
    preparationEnvironment,
    preparationInventory,
    auditPilotLaunchPrerequisites,
    runOwnedPreparationCommand,
    preparePilotElectron,
} from '../scripts/lib/pilot-electron-preparation.mjs';
const source = path.resolve(import.meta.dirname, '..');
const temp = () =>
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-electron-preparation-'));
const now = () => Number(process.hrtime.bigint() / 1000000n);
function pe(file, machine = 0x8664) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const b = Buffer.alloc(256);
    b.write('MZ');
    b.writeUInt32LE(64, 60);
    b.writeUInt32LE(0x4550, 64);
    b.writeUInt16LE(machine, 68);
    fs.writeFileSync(file, b);
    return file;
}
function fixture() {
    const dir = temp(),
        root = path.join(dir, 'source'),
        parent = path.join(dir, 'profile-temp'),
        out = path.join(dir, 'evidence');
    for (const p of [root, parent, out, path.join(root, 'node_modules/electron')])
        fs.mkdirSync(p, { recursive: true });
    const pkgdir = path.join(root, 'node_modules/electron');
    for (const f of ['package.json', 'install.js', 'checksums.json'])
        fs.copyFileSync(path.join(source, 'node_modules/electron', f), path.join(pkgdir, f));
    fs.copyFileSync(path.join(source, 'package-lock.json'), path.join(root, 'package-lock.json'));
    const identities = {
        package: fileIdentity(path.join(pkgdir, 'package.json')),
        installer: fileIdentity(path.join(pkgdir, 'install.js')),
        checksums: fileIdentity(path.join(pkgdir, 'checksums.json')),
    };
    return {
        dir,
        root,
        parent,
        out,
        pkgdir,
        identities,
        dispose() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
function auditFixture(f) {
    const mapping = { 'electron/package.json': path.join(f.pkgdir, 'package.json') };
    const modules = [
        'tsx',
        'playwright',
        '@electron/get',
        '@electron-internal/extract-zip',
        'esbuild',
        'vite',
        'rolldown',
        'lightningcss',
    ];
    for (const m of modules) {
        const file = path.join(f.root, 'node_modules', m, 'index.js');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'export {};');
        mapping[m] = file;
    }
    for (const m of [
        '@esbuild/win32-x64/esbuild.exe',
        '@rolldown/binding-win32-x64-msvc',
        'lightningcss-win32-x64-msvc',
    ])
        mapping[m] = pe(
            path.join(f.root, 'node_modules', m, m.endsWith('.exe') ? 'binary.exe' : 'binary.node'),
        );
    pe(
        path.join(
            path.dirname(mapping['@electron-internal/extract-zip']),
            'index.win32-x64-msvc.node',
        ),
    );
    const tools = Object.fromEntries(
        ['winps', 'pwsh', 'git', 'bash', 'cygpath', 'winptyDll', 'winptyAgent'].map((n) => [
            n,
            pe(path.join(f.dir, n, n + '.exe')),
        ]),
    );
    for (const file of [
        path.join(path.dirname(tools.pwsh), 'Microsoft.CodeAnalysis.dll'),
        path.join(path.dirname(tools.pwsh), 'Microsoft.CodeAnalysis.CSharp.dll'),
        path.join(path.dirname(tools.pwsh), 'System.Management.Automation.dll'),
        path.join(path.dirname(tools.winps), 'Modules/CimCmdlets/CimCmdlets.psd1'),
    ]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'installed compiler/module fixture');
    }
    fs.mkdirSync(path.join(f.root, 'scripts/lib'), { recursive: true });
    fs.copyFileSync(
        path.join(source, 'scripts/lib/pilot-electron-install-worker.mjs'),
        path.join(f.root, 'scripts/lib/pilot-electron-install-worker.mjs'),
    );
    for (const name of [
        'ssh2',
        'asn1',
        'safer-buffer',
        'bcrypt-pbkdf',
        'tweetnacl',
        'tsx',
        'esbuild',
    ]) {
        const target = path.join(f.root, 'node_modules', name, 'package.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(source, 'node_modules', name, 'package.json'), target);
        mapping[name + '/package.json'] = target;
    }
    const runtime = {
        platform: 'win32',
        arch: 'x64',
        version: 'v24.22.0',
        executable: pe(path.join(f.dir, 'node.exe')),
    };
    const resolve = (n) => {
        assert(n in mapping, 'Unexpected module resolution ' + n);
        return mapping[n];
    };
    return { tools, mapping, runtime, resolve };
}
test('all immediate installed launch prerequisites are audited together without lazy Electron resolution', () => {
    const f = fixture();
    try {
        const a = auditFixture(f),
            r = auditPilotLaunchPrerequisites(f.root, a.tools, a);
        assert.equal(r.identities.installer.sha256, limits.installerSHA256);
        assert.equal(r.identities.extractor.pe.architecture, 'x64');
        assert.equal(r.identities.winptyAgent.pe.architecture, 'x64');
        assert.match(r.sqlite, /built-in/);
        assert.equal(r.identities.package.sha256, limits.packageSHA256);
    } finally {
        f.dispose();
    }
});
for (const missing of ['extractor', 'esbuild', 'rolldown', 'lightningcss', 'compiler', 'winpty'])
    test('missing ' + missing + ' refuses the combined audit before installer admission', () => {
        const f = fixture();
        try {
            const a = auditFixture(f);
            const file = {
                extractor: path.join(
                    path.dirname(a.mapping['@electron-internal/extract-zip']),
                    'index.win32-x64-msvc.node',
                ),
                esbuild: a.mapping['@esbuild/win32-x64/esbuild.exe'],
                rolldown: a.mapping['@rolldown/binding-win32-x64-msvc'],
                lightningcss: a.mapping['lightningcss-win32-x64-msvc'],
                compiler: path.join(
                    path.dirname(a.tools.pwsh),
                    'Microsoft.CodeAnalysis.CSharp.dll',
                ),
                winpty: a.tools.winptyAgent,
            }[missing];
            fs.unlinkSync(file);
            assert.throws(() => auditPilotLaunchPrerequisites(f.root, a.tools, a), {
                code: 'ENOENT',
            });
        } finally {
            f.dispose();
        }
    });
for (const fault of ['installer-hash', 'wrong-arch', 'existing-runtime'])
    test('pinned preparation refuses ' + fault + ' in the read-only audit', () => {
        const f = fixture();
        try {
            const a = auditFixture(f);
            if (fault === 'installer-hash')
                fs.appendFileSync(path.join(f.pkgdir, 'install.js'), 'changed');
            if (fault === 'wrong-arch') pe(a.tools.winptyAgent, 0x14c);
            if (fault === 'existing-runtime')
                fs.writeFileSync(path.join(f.pkgdir, 'path.txt'), 'electron.exe');
            assert.throws(() => auditPilotLaunchPrerequisites(f.root, a.tools, a));
        } finally {
            f.dispose();
        }
    });
test('installer environment isolates mirrors, checksum switches, loader/native overrides only in child and preserves TEMP/TMP', () => {
    const env = {
        TEMP: 'C:\\profile\\Temp',
        TMP: 'C:\\profile\\Temp',
        PSModulePath: 'existing',
        ELECTRON_MIRROR: 'https://unreviewed',
        npm_config_electron_custom_version: '99',
        electron_use_remote_checksums: '1',
        NAPI_RS_NATIVE_LIBRARY_PATH: 'other',
        NODE_OPTIONS: '--require other',
    };
    const before = { ...env },
        child = preparationEnvironment(env, 'C:\\profile\\Temp\\owned\\cache');
    assert.deepEqual(env, before);
    assert.equal(child.TEMP, env.TEMP);
    assert.equal(child.TMP, env.TMP);
    for (const k of [
        'ELECTRON_MIRROR',
        'npm_config_electron_custom_version',
        'electron_use_remote_checksums',
        'NAPI_RS_NATIVE_LIBRARY_PATH',
        'NODE_OPTIONS',
    ])
        assert(!(k in child));
    assert.equal(child.ELECTRON_INSTALL_ARCH, 'x64');
    assert.equal(child.ELECTRON_INSTALL_PLATFORM, 'win32');
    assert.equal(preparationEnvironment(env, 'cache', true).ELECTRON_RUN_AS_NODE, '1');
});
test('inventory has bounded physical traversal and refuses aliases rather than following them', () => {
    const dir = temp();
    try {
        fs.writeFileSync(path.join(dir, 'one'), 'one');
        assert.equal(preparationInventory(dir).bytes, 3);
        fs.symlinkSync(path.join(dir, 'one'), path.join(dir, 'alias'));
        assert.throws(() => preparationInventory(dir));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
function controlledPreparation(f, fault = null) {
    const rows = [],
        calls = [],
        controller = new AbortController();
    let frozen = false,
        holds = 0,
        referenced = false;
    const journal = new PilotEvidence(f.out);
    const record = (stage, data) => {
        rows.push({ stage, data });
        if (fault === 'hold-record' && stage === 'ownership-held.json')
            throw Error('hold receipt disk error');
        journal.append(stage, data);
    };
    const hold = (state, write) => {
        holds++;
        const h = createOwnershipHold(
            state,
            (...args) => {
                assert(referenced, 'Referenced handle must precede hold persistence');
                return write(...args);
            },
            {
                interval: () => ({
                    ref() {
                        referenced = true;
                    },
                }),
            },
        );
        return { ...h, outcome: Promise.resolve() };
    };
    const audit = () => ({
        dir: f.pkgdir,
        installer: path.join(f.pkgdir, 'install.js'),
        worker: 'controlled-never-executed-worker',
        identities: f.identities,
        esbuildVersion: '0.28.2',
    });
    const identity = (file, options) => {
        const id = fileIdentity(file, options);
        if (path.basename(file) === limits.artifact)
            return { ...id, sha256: fault === 'checksum' ? '0'.repeat(64) : limits.artifactSHA256 };
        return id;
    };
    const command = async (options) => {
        calls.push(options.label);
        assert(!frozen);
        assert(options.deadline < options.cleanupDeadline);
        assert(options.cleanupDeadline - options.deadline === 30000);
        if (fault === 'unknown' || fault === 'hold-record') {
            options.hold({ opaque: 'injected missing close' });
            throw Error('unknown closure');
        }
        if (fault === 'joined-failure') throw Error('known joined installer failed');
        if (options.label === 'pinned-official-electron-installer') {
            const cache = options.environment.electron_config_cache;
            fs.writeFileSync(path.join(cache, limits.artifact), 'controlled checksum fixture only');
            fs.mkdirSync(path.join(f.pkgdir, 'dist'));
            fs.writeFileSync(path.join(f.pkgdir, 'path.txt'), 'electron.exe');
            fs.writeFileSync(path.join(f.pkgdir, 'dist/version'), '44.5.1');
            pe(path.join(f.pkgdir, 'dist/electron.exe'));
            if (fault === 'residual')
                fs.mkdirSync(path.join(f.parent, 'electron-download-unclosed-controlled'));
            return {
                stdout: JSON.stringify({
                    kind: 'pilot-launch-modules-loaded',
                    esbuild: '0.28.2',
                    nativeExtractor: true,
                    playwrightElectron: true,
                    vite: true,
                    rolldown: true,
                    lightningcss: true,
                }),
            };
        }
        return {
            stdout: JSON.stringify({
                kind: 'settled-electron-version',
                version: fault === 'version' ? '44.5.0' : '44.5.1',
                platform: 'win32',
                arch: 'x64',
                sqlite: true,
            }),
        };
    };
    const run = () =>
        preparePilotElectron(
            f.root,
            {
                parent: f.parent,
                evidenceRoot: f.out,
                tools: {},
                signal: controller.signal,
                workDeadline: now() + 540000,
                environment: { TEMP: f.parent, TMP: f.parent },
                record,
                hold,
            },
            { audit, identity, command },
        );
    return {
        run,
        rows,
        calls,
        journal,
        controller,
        record,
        freeze() {
            frozen = true;
            return prepareAndFreezePilotDependencies(f.root, { environment: {}, record });
        },
        get holds() {
            return holds;
        },
        get referenced() {
            return referenced;
        },
        dispose() {
            journal.close();
        },
    };
}
test('explicit preparation joins installer/probe, verifies checksum and version, removes scratch, then freezes complete dependency identity', async () => {
    const f = fixture(),
        p = controlledPreparation(f);
    try {
        const r = await p.run();
        assert(r.completed);
        assert.equal(p.holds, 0);
        assert.deepEqual(p.calls, [
            'pinned-official-electron-installer',
            'settled-electron-version',
        ]);
        assert.deepEqual(fs.readdirSync(f.parent), []);
        const frozen = p.freeze();
        assert.equal(
            frozen.dependencies.sha256,
            dependencyFacts(path.join(f.root, 'node_modules'), () => {}).sha256,
        );
        assert(
            p.rows.findIndex((r) => r.stage === 'electron-preparation-cleanup') <
                p.rows.findIndex((r) => r.stage === 'dependency-identity-frozen'),
        );
        fs.appendFileSync(frozen.electron, 'late mutation');
        assert.notEqual(
            frozen.dependencies.sha256,
            dependencyFacts(path.join(f.root, 'node_modules'), () => {}).sha256,
        );
    } finally {
        p.dispose();
        f.dispose();
    }
});
for (const fault of ['joined-failure', 'checksum', 'version'])
    test(
        'known joined ' +
            fault +
            ' remains failed, cleans only preparation fixture and never freezes',
        async () => {
            const f = fixture(),
                p = controlledPreparation(f, fault);
            try {
                await assert.rejects(p.run());
                assert.equal(p.holds, 0);
                assert.deepEqual(fs.readdirSync(f.parent), []);
                assert(!p.rows.some((r) => r.stage === 'dependency-identity-frozen'));
                assert(!p.rows.some((r) => r.stage === 'electron-preparation-settled'));
                assert(fs.fstatSync(p.journal.entry.fd).isFile());
            } finally {
                p.dispose();
                f.dispose();
            }
        },
    );
for (const fault of ['unknown', 'hold-record', 'residual'])
    test(
        'unknown ' +
            fault +
            ' retains referenced ownership, scratch and real evidence descriptor before reporting',
        async () => {
            const f = fixture(),
                p = controlledPreparation(f, fault);
            try {
                await assert.rejects(p.run(), /unknown custody retained/);
                assert.equal(p.holds, 1);
                assert(p.referenced);
                assert(
                    fs
                        .readdirSync(f.parent)
                        .some((n) => n.startsWith('diagnostic-hub-electron-preparation-')),
                );
                assert(!p.journal.entry.attempted);
                assert(fs.fstatSync(p.journal.entry.fd).isFile());
                assert(!p.rows.some((r) => r.stage === 'dependency-identity-frozen'));
            } finally {
                p.dispose();
                f.dispose();
            }
        },
    );
const controlledWorker = (behavior) =>
    `process.send({kind:'electron-preparation-ready',pid:process.pid});process.once('message',()=>{process.disconnect();${behavior}});`;
async function ownedControl(
    behavior,
    { identityFailure = false, recordFailure = false, deadlineMs = 3000 } = {},
) {
    const dir = temp(),
        journal = new PilotEvidence(dir),
        rows = [],
        holds = [];
    const controller = new AbortController();
    let scope;
    const record = (s, d) => {
        rows.push({ stage: s, data: d });
        if (recordFailure && s === 'electron-preparation-output')
            throw Error('controlled reporting failed');
        journal.append(s, d);
    };
    const promise = runOwnedPreparationCommand(
        {
            label: 'controlled-Node-child',
            executable: process.execPath,
            args: ['-e', controlledWorker(behavior)],
            cwd: dir,
            environment: { ...process.env },
            deadline: now() + deadlineMs,
            cleanupDeadline: now() + 5000,
            signal: controller.signal,
            check: () => {},
            record,
            hold: (s) => holds.push(s),
        },
        {
            startupFactory: (o) =>
                (scope = new NativePilotStartup({
                    ...o,
                    identity: async (child) => {
                        if (identityFailure) throw Error('controlled identity unavailable');
                        return {
                            pid: child.pid,
                            created: 'controlled identity port',
                            state: 'running',
                        };
                    },
                    proveDescendants: async () => {},
                })),
        },
    );
    return {
        promise,
        controller,
        dir,
        journal,
        rows,
        holds,
        get scope() {
            return scope;
        },
        dispose() {
            journal.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
test('real harmless child retains late inherited output and actual exit/pipe-close before a complete receipt', async () => {
    const f = await ownedControl(
        `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>console.log("late inherited output"),180)'],{stdio:['ignore',1,2]}).unref();`,
    );
    try {
        const r = await f.promise;
        assert.match(r.stdout, /late inherited output/);
        assert(r.receipt.complete);
        assert(
            r.receipt.children[0].exit &&
                r.receipt.children[0].close &&
                r.receipt.children[0].observationsDrained,
        );
        assert.equal(f.holds.length, 0);
    } finally {
        f.dispose();
    }
});
for (const fault of ['output', 'report', 'deadline', 'identity'])
    test(
        'owned preparation ' +
            fault +
            ' failure fences later work and joins or explicitly holds uncertainty',
        async () => {
            const behavior =
                fault === 'output'
                    ? `console.log('x'.repeat(70000));`
                    : fault === 'report'
                      ? `console.log('bounded output');`
                      : `setInterval(()=>{},1000);`;
            const f = await ownedControl(behavior, {
                recordFailure: fault === 'report',
                identityFailure: fault === 'identity',
                deadlineMs: fault === 'deadline' ? 100 : 3000,
            });
            try {
                await assert.rejects(f.promise);
                const row = [...f.scope.children.values()][0];
                assert(row.exit && row.close);
                if (fault === 'identity') assert(f.holds.length > 0);
                const retained = f.rows
                    .filter((r) => r.stage === 'electron-preparation-output')
                    .reduce((n, r) => n + Buffer.from(r.data.base64, 'base64').length, 0);
                assert(retained <= 65536);
                assert(fs.fstatSync(f.journal.entry.fd).isFile());
            } finally {
                f.dispose();
            }
        },
    );
test('native wiring keeps fresh WinPS before explicit preparation, then complete freeze before enrollment; all existing budgets stay exact', () => {
    const code = fs.readFileSync(path.join(source, 'scripts/windows-native-pilot.mts'), 'utf8');
    assert(
        code.indexOf('await runWinpsSecurityContract(') <
            code.indexOf('await preparePilotElectron('),
    );
    assert(
        code.indexOf('await preparePilotElectron(') <
            code.indexOf('prepareAndFreezePilotDependencies(root'),
    );
    assert(
        code.indexOf('prepareAndFreezePilotDependencies(root') <
            code.indexOf('const lease = new ProductLease('),
    );
    assert.equal(limits.totalMs, 180000);
    assert.equal(limits.reserveMs, 30000);
    const worker = fs.readFileSync(
        path.join(source, 'scripts/lib/pilot-electron-install-worker.mjs'),
        'utf8',
    );
    assert.match(worker, /await go/);
    assert.doesNotMatch(worker, /require\(['"]electron['"]\)|npx|install-electron/);
    assert.match(worker, /createRequire\(import.meta.url\)\(installer\)/);
    assert.match(worker, /ELECTRON_RUN_AS_NODE/);
});

test('cancellation before preparation admits no audit, child, freeze or fixture', async () => {
    const f = fixture(),
        p = controlledPreparation(f);
    try {
        p.controller.abort(Error('controlled pre-admission cancellation'));
        await assert.rejects(p.run(), /pre-admission cancellation/);
        assert.deepEqual(p.calls, []);
        assert.equal(p.holds, 0);
        assert.deepEqual(fs.readdirSync(f.parent), []);
    } finally {
        p.dispose();
        f.dispose();
    }
});
test('inherited pipe uncertainty holds after actual root exit rather than treating exit as closure', async () => {
    const f = await ownedControl(
        `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>console.log("late pipe holder closed"),300)'],{stdio:['ignore',1,2]}).unref();`,
        { deadlineMs: 3000 },
    );
    const child = [...f.scope.children.keys()][0];
    child.once('exit', () =>
        f.controller.abort(Error('controlled cancellation after actual root exit')),
    );
    try {
        await assert.rejects(f.promise);
        assert(f.holds.length > 0);
        const row = [...f.scope.children.values()][0];
        assert(row.exit && row.close);
        assert(fs.fstatSync(f.journal.entry.fd).isFile());
    } finally {
        f.dispose();
    }
});

test('pilot native executable resolution never evaluates Electron lazy index after freeze', () => {
    const code = fs.readFileSync(
        path.join(source, 'tests/fixtures/memory-product-native-host.ts'),
        'utf8',
    );
    assert.match(code, /executablePath: options.pilot\s*\? settledElectronExecutable/);
    const f = fixture();
    try {
        const a = auditFixture(f);
        assert.throws(
            () =>
                auditPilotLaunchPrerequisites(f.root, a.tools, {
                    ...a,
                    environment: { ESBUILD_BINARY_PATH: 'unreviewed' },
                }),
            /Unreviewed launch prerequisite override/,
        );
    } finally {
        f.dispose();
    }
});

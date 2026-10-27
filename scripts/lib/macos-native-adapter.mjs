import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, installerCases } from './staged-artifact-gate.mjs';
import { assertMacInstallerHelperReturn } from './macos-installer-observation.mjs';
import { NATIVE_LIMITS } from './macos-native-contract.mjs';

export const NATIVE_WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const NATIVE_NODE = '/Users/bruce/.local/opt/node-v24.22.0-darwin-arm64/bin/node';
export const NATIVE_TSX =
    '/Users/bruce/Codex/2026-10-18/task-2/packaging-mac-1/workspace/node_modules/tsx/dist/loader.mjs';
export const NATIVE_PLAYWRIGHT =
    '/Users/bruce/Codex/2026-10-18/task-2/packaging-mac-1/workspace/node_modules/@playwright/test/index.mjs';
export const CAPTURE_ID = 'de9fe795-04ef-4f73-9495-dca0123a6dea';
export const LEGACY_V052_COMMIT = '2f84f429214633374e56159296b87c188d64c5f2';
export function legacyDiagnosticSnapshot() {
    const at = '2026-10-15T17:00:00.000Z';
    return {
        schemaVersion: 1,
        mode: 'demo',
        endpoint: 'owned synthetic legacy fixture',
        username: 'fixture',
        capturedAt: at,
        results: [
            {
                id: 'identity',
                status: 'collected',
                stdout: 'Synthetic legacy identity fixture\n',
                stderr: '',
                exitCode: 0,
                durationMs: 0,
                collectedAt: at,
                truncated: false,
            },
        ],
    };
}
export function legacyKnownHostsFixture() {
    // Actual v0.5.2 Record<string,string> storage format; never used to connect or trust a real host.
    return { 'synthetic.fixture.invalid:22': 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
}
export function validateLegacyDiagnosticReport(value) {
    const expected = legacyDiagnosticSnapshot();
    assert.equal(value.application, 'Diagnostic Hub');
    assert.equal(value.applicationVersion, '0.5.2');
    for (const field of ['schemaVersion', 'mode', 'endpoint', 'username', 'capturedAt'])
        assert.equal(value[field], expected[field]);
    for (const field of ['results', 'diagnostics']) {
        assert.ok(Array.isArray(value[field]) && value[field].length > 0);
        const matches = value[field].filter((row) => row.id === 'identity');
        assert.equal(matches.length, 1);
        for (const [key, wanted] of Object.entries(expected.results[0]))
            assert.deepEqual(matches[0][key], wanted);
    }
    return value;
}
const FIXTURE_NAMES = ['header.json', 'meta.json', 'raw.jsonl'];
export function macNativeSourcePins() {
    return [
        ['node', NATIVE_NODE],
        ['tsx', NATIVE_TSX],
        ['playwright', NATIVE_PLAYWRIGHT],
        ['cli', path.join(NATIVE_WORKSPACE, 'tests/macos-installer-native-cli.mjs')],
        ...[
            'macos-native-contract.mjs',
            'macos-native-io.mjs',
            'macos-native-adapter.mjs',
            'macos-installer-actions.mjs',
            'macos-installer-observation.mjs',
            'staged-artifact-gate.mjs',
            'macos-release.mjs',
            'release-assets.mjs',
            'windows-setup-release.mjs',
        ].map((name) => [name, path.join(NATIVE_WORKSPACE, 'scripts/lib', name)]),
        ['owner', path.join(NATIVE_WORKSPACE, 'tests/fixtures/macos-native-owned.ts')],
        ['helper', path.join(NATIVE_WORKSPACE, 'public/download-run-macos.sh')],
        ...FIXTURE_NAMES.map((name) => [
            name,
            path.join(NATIVE_WORKSPACE, 'tests/fixtures/macos-installer-data', name),
        ]),
    ].map(([role, file]) => ({ role, path: file }));
}
function encoded(value, cap = NATIVE_LIMITS.resultBytes) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    assert.ok(bytes.length <= cap);
    return bytes;
}
export function parseMacBundleInfo(bytes) {
    const text = bytes.toString('utf8');
    assert.ok(text.includes('<plist') && !text.includes('<!ENTITY'));
    const field = (key) => {
        const matches = [
            ...text.matchAll(
                new RegExp('<key>\\s*' + key + '\\s*</key>\\s*<string>([^<]+)</string>', 'g'),
            ),
        ];
        assert.equal(matches.length, 1);
        return matches[0][1];
    };
    const version = field('CFBundleShortVersionString'),
        bundleIdentifier = field('CFBundleIdentifier');
    assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
    assert.equal(bundleIdentifier, 'dev.diagnostichub.desktop');
    return { version, bundleIdentifier };
}
const mirrorProgram = `import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),url=args.find(v=>v.startsWith('https://')),out=args[args.indexOf('-o')+1];
const map=JSON.parse(fs.readFileSync(process.env.HUB_NATIVE_MAP,'utf8'));if(!url||!Object.hasOwn(map,url))throw Error('mirror-url-refused');
if(!path.isAbsolute(out)||!out.startsWith(path.resolve(process.env.TMPDIR)+'/DiagnosticHub-download.')||fs.realpathSync(path.dirname(out))!==path.dirname(out))throw Error('mirror-output-refused');
const source=fs.openSync(map[url],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),before=fs.fstatSync(source);
if(!before.isFile()||before.nlink!==1)throw Error('mirror-input-refused');
const target=fs.openSync(out,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),buf=Buffer.alloc(65536);let total=0;
for(;;){const n=fs.readSync(source,buf,0,buf.length,null);if(!n)break;total+=n;if(total>before.size)throw Error('mirror-input-growth');let at=0;while(at<n){const k=fs.writeSync(target,buf,at,n-at);if(k<=0)throw Error('mirror-write');at+=k;}}
const after=fs.fstatSync(source);if(total!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('mirror-input-change');
fs.fsyncSync(target);fs.closeSync(target);fs.closeSync(source);
`;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export function offlineHelperSource(bytes) {
    const original = bytes.toString('utf8');
    const fallback =
        "        printf '%s\\n' 'Native review is unavailable; trying the controlling terminal.' >&2";
    assert.equal(original.split(fallback).length, 2);
    // Fixed fixture consent must never fall back to an unrelated controlling terminal.
    return Buffer.from(
        original.replace(
            fallback,
            '        return 1 # isolated fixture: consent shim unavailable; refuse directly',
        ),
    );
}

// This factory needs an admitted --run context; it does not allocate or launch on construction.
// io and Desktop can be inert substitutes in unit tests. The default Desktop import is lazy.
export async function createMacNativeEffects(admission, io, dependencies = {}) {
    assert.equal(admission.parsed.mode, 'run');
    assert.equal(admission.approval.approved, true);
    assert.equal(io.state.root, admission.parsed.root);
    assert.equal(io.state.rootAllocated, true);
    const admitted = structuredClone(admission),
        root = admitted.parsed.root;
    const fixtureRecords = new WeakMap(),
        ownerRecords = new WeakMap(),
        backupRecords = new WeakMap();
    const fixtures = new Map(),
        maps = {},
        appOrder = new Map();
    let initialized = false,
        Desktop = dependencies.Desktop;
    const helper = path.join(root, 'bin/download-run-macos.sh');
    const packageIdentity = (value) => ({
        version: value.version,
        sourceCommit: value.sourceCommit,
        zipPath: value.zipPath,
        zipSHA256: value.zipSHA256,
        asarSHA256: value.asarSHA256,
    });
    const selectedPackage = (input) => {
        const found = [admitted.packages.current, admitted.packages.prior].find(
            (item) => item.zipSHA256 === input.zipSHA256,
        );
        assert.ok(found);
        assert.deepEqual(packageIdentity(input), packageIdentity(found));
        return found;
    };
    function record(fixture) {
        io.gate();
        assert.ok(initialized);
        const value = fixtureRecords.get(fixture);
        assert.ok(value);
        assert.deepEqual(fixture, value.identity);
        const stat = io.stat(fixture.root);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        assert.equal(stat.dev, value.token.dev);
        assert.equal(stat.ino, value.token.ino);
        return value;
    }
    const fileIdentity = (base, relative) => {
        const file = path.join(base, relative),
            st = io.stat(file);
        assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1);
        return { path: relative, ...io.hash(file, st.size) };
    };
    function data(fixture) {
        const value = record(fixture),
            profileFiles = [],
            reportFiles = [];
        for (const name of FIXTURE_NAMES) {
            const relative = 'profile/console-captures-v2/' + CAPTURE_ID + '/' + name;
            if (!io.absent(path.join(fixture.root, relative)))
                profileFiles.push(fileIdentity(fixture.root, relative));
        }
        if (!io.absent(path.join(fixture.root, 'profile/known-hosts.json')))
            profileFiles.push(fileIdentity(fixture.root, 'profile/known-hosts.json'));
        if (!io.absent(path.join(fixture.root, 'reports/console.json')))
            reportFiles.push(fileIdentity(fixture.root, 'reports/console.json'));
        if (!io.absent(path.join(fixture.root, 'reports/legacy-diagnostic.json')))
            reportFiles.push(fileIdentity(fixture.root, 'reports/legacy-diagnostic.json'));
        return { value, profileFiles, reportFiles };
    }
    function snapshot(fixture) {
        const { value, profileFiles, reportFiles } = data(fixture);
        if (io.absent(fixture.target))
            return { exists: false, version: null, asarSHA256: null, profileFiles, reportFiles };
        assert.ok(value.installed);
        io.tree(fixture.target, value.installed.inventory);
        const info = parseMacBundleInfo(
            io.read(path.join(fixture.target, 'Contents/Info.plist'), 65536),
        );
        assert.equal(info.version, value.installed.version);
        return {
            exists: true,
            version: info.version,
            asarSHA256: value.installed.asarSHA256,
            profileFiles,
            reportFiles,
        };
    }
    async function identity(desktop, fixture, selected) {
        return desktop.evaluate(
            ({ app, BrowserWindow }, expected) => {
                const windows = BrowserWindow.getAllWindows();
                if (windows.length !== 1) return { ready: false };
                const window = windows[0];
                if (window.webContents.getURL() !== 'app://bundle/index.html')
                    return { ready: false };
                return {
                    ready: true,
                    pid: process.pid,
                    packaged: app.isPackaged,
                    version: app.getVersion(),
                    asar: app.getAppPath(),
                    profile: app.getPath('userData'),
                    windowID: window.id,
                    offline:
                        globalThis.__hubInstallerOffline?.applied === true &&
                        globalThis.__hubInstallerOffline?.readyBeforeWindow === true,
                };
            },
            { fixture, version: selected.version },
        );
    }
    const effects = {
        kind: 'native',
        async initialize() {
            assert.ok(!initialized);
            io.gate();
            for (const name of ['bin', 'mirrors', 'evidence']) io.mkdir(path.join(root, name));
            const helperBytes = io.read(
                path.join(NATIVE_WORKSPACE, 'public/download-run-macos.sh'),
                65536,
            );
            io.publish(helper, offlineHelperSource(helperBytes), 65536, 0o700);
            io.publish(path.join(root, 'bin/curl.mjs'), Buffer.from(mirrorProgram), 65536);
            io.publish(
                path.join(root, 'bin/curl'),
                Buffer.from(
                    '#!/bin/bash\nexec ' +
                        quote(NATIVE_NODE) +
                        ' ' +
                        quote(path.join(root, 'bin/curl.mjs')) +
                        ' "$@"\n',
                ),
                65536,
                0o700,
            );
            io.publish(
                path.join(root, 'bin/osascript'),
                Buffer.from('#!/bin/bash\ncat >/dev/null\nprintf "install\\n"\n'),
                65536,
                0o700,
            );
            io.publish(
                path.join(root, 'bin/mv'),
                Buffer.from(
                    '#!/bin/bash\nset -eu\nif [ "${HUB_NATIVE_FAULT:-}" = activation-return-failure ] && [ "$2" = "$HUB_NATIVE_TARGET" ]; then\n case "$1" in "$HUB_NATIVE_APPS"/.DiagnosticHub-stage.????????/extracted/"Diagnostic Hub.app") (set -C; printf "activation-return-failure\\n" > "$HUB_NATIVE_FAULT_MARKER"); exit 70;; esac\nfi\nexec /bin/mv "$@"\n',
                ),
                65536,
                0o700,
            );
            for (const role of ['current', 'prior']) {
                const selected = admitted.packages[role],
                    dir = path.join(root, 'mirrors', role);
                io.mkdir(dir);
                const infoBytes = io.read(selected.identity.info, 65536);
                assert.equal(digest(infoBytes), selected.identity.infoSHA256);
                io.publish(path.join(dir, 'manifest.json'), infoBytes);
                io.publish(
                    path.join(dir, 'release.json'),
                    encoded({
                        tag_name: 'v' + selected.version,
                        draft: false,
                        target_commitish: selected.sourceCommit,
                    }),
                );
                io.publish(
                    path.join(dir, 'checksum'),
                    Buffer.from(selected.zipSHA256 + '  ' + selected.info.asset + '\n'),
                );
                const base =
                    'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v' +
                    selected.version;
                const map = {
                    ['https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/releases/tags/v' +
                    selected.version]: path.join(dir, 'release.json'),
                    [base + '/' + selected.info.asset]: selected.zipPath,
                    [base + '/' + selected.info.asset + '.sha256']: path.join(dir, 'checksum'),
                    [base + '/macos-build-info-' + admitted.metadata.arch + '.json']: path.join(
                        dir,
                        'manifest.json',
                    ),
                };
                maps[selected.zipSHA256] = path.join(dir, 'map.json');
                io.publish(maps[selected.zipSHA256], encoded(map));
            }
            initialized = true;
        },
        async prepare(id) {
            io.gate();
            assert.ok(
                initialized &&
                    installerCases('darwin-' + admitted.metadata.arch).includes(id) &&
                    !fixtures.has(id),
            );
            const dir = path.join(root, id.slice('macos-bundle:'.length));
            io.mkdir(dir);
            for (const leaf of [
                'Applications',
                'profile',
                'reports',
                'home',
                'temp',
                'evidence',
                'backup',
            ])
                io.mkdir(path.join(dir, leaf));
            const fixture = Object.freeze({
                id,
                root: dir,
                target: path.join(dir, 'Applications/Diagnostic Hub.app'),
                fresh: true,
            });
            fixtureRecords.set(fixture, {
                identity: { ...fixture },
                token: io.stat(dir),
                installed: null,
            });
            fixtures.set(id, fixture);
            return fixture;
        },
        async snapshot(fixture) {
            return snapshot(fixture);
        },
        async install(fixture, input, options) {
            const value = record(fixture),
                selected = selectedPackage(input);
            assert.ok(Object.keys(options).every((key) => ['expectBusy', 'fault'].includes(key)));
            if (options.fault) assert.equal(options.fault, 'activation-return-failure');
            const env = {
                PATH: path.join(root, 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
                HOME: path.join(fixture.root, 'home'),
                TMPDIR: path.join(fixture.root, 'temp'),
                LANG: 'en_US.UTF-8',
                HUB_NATIVE_MAP: maps[selected.zipSHA256],
                HUB_NATIVE_FAULT: options.fault ?? '',
                HUB_NATIVE_TARGET: fixture.target,
                HUB_NATIVE_APPS: path.dirname(fixture.target),
                HUB_NATIVE_FAULT_MARKER: path.join(fixture.root, 'evidence/fault-fired'),
            };
            const returned = await io.child(
                '/bin/bash',
                [
                    helper,
                    '--version',
                    'v' + selected.version,
                    '--directory',
                    path.dirname(fixture.target),
                    '--no-launch',
                ],
                env,
                NATIVE_WORKSPACE,
            );
            const expectation = options.expectBusy || options.fault ? 'refusal' : 'success';
            assertMacInstallerHelperReturn({
                stage: 'native-install',
                error: returned.error,
                exitCode: returned.exitCode,
                signal: returned.signal,
                expectedReturn: expectation,
            });
            const result = {
                command: returned.command,
                exitObserved: returned.exitObserved,
                exitCode: returned.exitCode,
                signal: returned.signal,
                error: returned.error,
            };
            if (options.expectBusy)
                result.busyRefusalVerified = /Quit Diagnostic Hub/.test(returned.stderr);
            else if (options.fault) {
                assert.equal(
                    io.read(env.HUB_NATIVE_FAULT_MARKER, 64).toString(),
                    'activation-return-failure\n',
                );
                result.faultObserved = options.fault;
            } else {
                io.tree(fixture.target, selected.inventory);
                const info = parseMacBundleInfo(
                    io.read(path.join(fixture.target, 'Contents/Info.plist'), 65536),
                );
                assert.equal(info.version, selected.version);
                value.installed = selected;
            }
            return result;
        },
        async launchOwned(fixture) {
            const value = record(fixture);
            assert.ok(value.installed);
            if (!Desktop)
                Desktop = (await import('../../tests/fixtures/macos-native-owned.ts')).OwnedDesktop;
            io.row();
            const desktop = new Desktop({
                executable: path.join(fixture.target, 'Contents/MacOS/Diagnostic Hub'),
                profile: path.join(fixture.root, 'profile'),
                env: {
                    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                    HOME: path.join(fixture.root, 'home'),
                    TMPDIR: path.join(fixture.root, 'temp'),
                    LANG: 'en_US.UTF-8',
                },
                artifactsDir: path.join(fixture.root, 'evidence'),
                deadline: io.state.deadline,
                offline: true,
                captureBudget: { take: io.take },
            });
            const retained = { desktop, fixture, closed: false, identity: null };
            io.state.desktops.push(retained);
            desktop.owner.publicationFDs = io.state.fds;
            await io.wait('app-launch-attach', async () => {
                desktop.launch();
                await desktop.attach();
            });
            let observed;
            for (let index = 0; index < 80; index++) {
                observed = await io.wait('owned-window-identity', () =>
                    identity(desktop, fixture, value.installed),
                );
                if (observed.ready) break;
                await io.wait(
                    'owned-window-ready',
                    () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
            }
            assert.ok(observed?.ready && observed.packaged && observed.offline);
            assert.equal(observed.pid, desktop.process().pid);
            assert.equal(observed.version, value.installed.version);
            assert.equal(observed.asar, path.join(fixture.target, 'Contents/Resources/app.asar'));
            assert.equal(observed.profile, path.join(fixture.root, 'profile'));
            const ordinal = (appOrder.get(fixture.id) ?? 0) + 1;
            appOrder.set(fixture.id, ordinal);
            const owner = Object.freeze({
                id: admitted.approval.nonce + ':' + fixture.id + ':' + ordinal + ':' + observed.pid,
                ready: true,
                offlineLaunchVerified: true,
            });
            retained.identity = structuredClone(observed);
            ownerRecords.set(owner, { retained, ordinal });
            return owner;
        },
        async quitOwned(fixture, owner) {
            record(fixture);
            const owned = ownerRecords.get(owner);
            assert.ok(owned && owned.retained.fixture === fixture && !owned.retained.closed);
            const { desktop } = owned.retained;
            const prequit = encoded({
                ownerId: owner.id,
                identity: owned.retained.identity,
                scope: 'installer-case',
                closure: desktop.snapshot(),
            });
            io.publish(
                path.join(fixture.root, 'evidence/app-' + owned.ordinal + '-prequit.json'),
                prequit,
                8192,
                0o600,
                true,
            );
            desktop.owner.preQuitReceiptVerified = true;
            await io.wait('app-normal-quit', () => desktop.normalQuit());
            owned.retained.closed =
                desktop.owner.quitComplete &&
                desktop.owner.exitObserved &&
                desktop.owner.closeObserved &&
                desktop.owner.exitCode === 0 &&
                desktop.owner.signal === null;
            desktop.owner.shutdownActive();
            io.publish(
                path.join(fixture.root, 'evidence/app-' + owned.ordinal + '-closure.json'),
                encoded({ ownerId: owner.id, closure: desktop.snapshot() }),
                8192,
                0o600,
                true,
            );
            desktop.owner.shutdownActive();
            assert.equal(desktop.owner.reason, null);
            return {
                ownerId: owner.id,
                exitObserved: desktop.owner.exitObserved,
                exitCode: desktop.owner.exitCode,
                signal: desktop.owner.signal,
                error: 'none',
                closeObserved: desktop.owner.closeObserved,
                stdoutEOF: desktop.owner.streams.stdoutEOF,
                stderrEOF: desktop.owner.streams.stderrEOF,
            };
        },
        async seedApplicationData(fixture) {
            const value = record(fixture);
            assert.ok(value.installed);
            const legacy =
                value.installed === admitted.packages.prior &&
                value.installed.version === '0.5.2' &&
                value.installed.sourceCommit === LEGACY_V052_COMMIT;
            if (legacy) {
                io.publish(
                    path.join(fixture.root, 'profile/known-hosts.json'),
                    encoded(legacyKnownHostsFixture()),
                    8192,
                );
            } else {
                const journal = path.join(fixture.root, 'profile/console-captures-v2');
                io.mkdir(journal);
                io.mkdir(path.join(journal, CAPTURE_ID));
                for (const name of FIXTURE_NAMES)
                    io.publish(
                        path.join(journal, CAPTURE_ID, name),
                        io.read(
                            path.join(
                                NATIVE_WORKSPACE,
                                'tests/fixtures/macos-installer-data',
                                name,
                            ),
                            8192,
                        ),
                        8192,
                    );
            }
            const owner = await effects.launchOwned(fixture),
                owned = ownerRecords.get(owner),
                destination = path.join(
                    fixture.root,
                    legacy ? 'reports/legacy-diagnostic.json' : 'reports/console.json',
                );
            const capabilities = await owned.retained.desktop.evaluate(({ BrowserWindow }) => {
                const windows = BrowserWindow.getAllWindows();
                if (windows.length !== 1) throw Error('window-count');
                return windows[0].webContents.executeJavaScript(
                    '({ consoleStorage: typeof window.diagnosticHub?.consoleStorage === "function", exportReport: typeof window.diagnosticHub?.exportReport === "function" })',
                    true,
                );
            });
            assert.equal(typeof capabilities.consoleStorage, 'boolean');
            assert.equal(typeof capabilities.exportReport, 'boolean');
            const unavailable = legacy
                ? capabilities.consoleStorage
                    ? 'LEGACY_SEED_API_BINDING_MISMATCH'
                    : !capabilities.exportReport
                      ? 'LEGACY_REPORT_SEED_API_UNAVAILABLE'
                      : null
                : !capabilities.consoleStorage
                  ? 'CONSOLE_STORAGE_SEED_API_UNAVAILABLE'
                  : null;
            if (unavailable) {
                await effects.quitOwned(fixture, owner); // Only a known settled unsupported return, never an uncertain owner, can be labelled unavailable.
                return { origin: 'unsupported', reason: unavailable, ownerSettled: true };
            }
            assert.ok(io.absent(destination));
            await owned.retained.desktop.evaluate(({ dialog }, file) => {
                if (globalThis.__hubInstallerDialog) throw Error('dialog-slot-used');
                const original = dialog.showSaveDialog;
                const slot = { original, calls: 0 };
                globalThis.__hubInstallerDialog = slot;
                dialog.showSaveDialog = async () => {
                    if (slot.calls++ !== 0) throw Error('dialog-limit');
                    return { canceled: false, filePath: file };
                };
                return { installed: true };
            }, destination);
            const reply = await owned.retained.desktop.evaluate(
                async ({ BrowserWindow }, request) => {
                    const windows = BrowserWindow.getAllWindows();
                    if (windows.length !== 1) throw Error('window-count');
                    return windows[0].webContents.executeJavaScript(
                        request.legacy
                            ? 'window.diagnosticHub.exportReport(' +
                                  JSON.stringify(request.snapshot) +
                                  ')'
                            : 'window.diagnosticHub.consoleStorage(' +
                                  JSON.stringify({
                                      op: 'export',
                                      owner: request.id,
                                      format: 'json',
                                      scope: { ids: [request.id] },
                                  }) +
                                  ')',
                        true,
                    );
                },
                { legacy, snapshot: legacy ? legacyDiagnosticSnapshot() : null, id: CAPTURE_ID },
            );
            if (legacy) assert.equal(reply, true);
            else assert.deepEqual(reply, { ok: true, value: { saved: true } });
            await owned.retained.desktop.evaluate(({ dialog }) => {
                const slot = globalThis.__hubInstallerDialog;
                if (!slot || slot.calls !== 1) throw Error('dialog-count');
                dialog.showSaveDialog = slot.original;
                delete globalThis.__hubInstallerDialog;
                return true;
            });
            const report = JSON.parse(io.read(destination, 65536).toString('utf8'));
            if (legacy) {
                validateLegacyDiagnosticReport(report);
                assert.deepEqual(
                    JSON.parse(
                        io
                            .read(path.join(fixture.root, 'profile/known-hosts.json'), 8192)
                            .toString('utf8'),
                    ),
                    legacyKnownHostsFixture(),
                );
            } else {
                assert.equal(report.schema, 2);
                assert.equal(report.mode, 'console');
            }
            await effects.quitOwned(fixture, owner);
            return {
                origin: 'application',
                reportFormat: legacy ? 'legacy-diagnostic-schema1' : 'console-schema2',
                profileFixture: legacy ? 'known-hosts-record-v052' : 'console-journal-schema2',
                profileUseVerified: !legacy,
            };
            // The profile file is a supported-schema fixture; legacy host trust/use is NOT exercised. The report is application-generated.
        },
        async readApplicationData(fixture, owner) {
            record(fixture);
            const owned = ownerRecords.get(owner);
            assert.ok(owned && owned.retained.fixture === fixture && !owned.retained.closed);
            const checked = await owned.retained.desktop.evaluate(
                async ({ BrowserWindow }, capture) => {
                    const windows = BrowserWindow.getAllWindows();
                    if (windows.length !== 1) throw Error('window-count');
                    const window = windows[0];
                    const call = async (request) => {
                        const reply = await window.webContents.executeJavaScript(
                            'window.diagnosticHub.consoleStorage(' + JSON.stringify(request) + ')',
                            true,
                        );
                        if (!reply?.ok) throw Error('archive-refusal');
                        return reply.value;
                    };
                    const { handle } = await call({ op: 'read', id: capture });
                    let done = false;
                    for (let index = 0; index < 64; index++) {
                        if ((await call({ op: 'pull', handle })).done) {
                            done = true;
                            break;
                        }
                    }
                    if (!done) throw Error('read-limit');
                    await call({ op: 'return', handle });
                    return true;
                },
                CAPTURE_ID,
            );
            assert.equal(checked, true);
            const { profileFiles, reportFiles } = data(fixture);
            return { origin: 'application', profileFiles, reportFiles };
        },
        async inspectOwnedIntegrations(fixture) {
            record(fixture);
            const info = parseMacBundleInfo(
                io.read(path.join(fixture.target, 'Contents/Info.plist'), 65536),
            );
            return {
                scope: 'owned-application-bundle',
                target: fixture.target,
                bundleIdentifier: info.bundleIdentifier,
                verified: true,
            };
        },
        async backupOwnedInstallation(fixture) {
            const value = record(fixture);
            assert.ok(value.installed);
            const before = snapshot(fixture),
                backupRoot = path.join(fixture.root, 'backup/Diagnostic Hub.app');
            const original = io.copyTree(fixture.target, backupRoot, value.installed.inventory);
            const manifest = original.map(({ dev, ino, ...item }) => item),
                manifestBytes = encoded(manifest, NATIVE_LIMITS.controlBytes);
            io.publish(
                path.join(fixture.root, 'backup/manifest.json'),
                manifestBytes,
                NATIVE_LIMITS.controlBytes,
                0o600,
                true,
            );
            const backup = Object.freeze({
                target: fixture.target,
                verified: true,
                completeBundle: true,
                snapshotSHA256: digest(JSON.stringify(before)),
                manifestSHA256: digest(manifestBytes),
            });
            backupRecords.set(backup, {
                fixture,
                backupRoot,
                original,
                selected: value.installed,
                manifestBytes,
            });
            return backup;
        },
        async removeOwnedInstallation(fixture, backup) {
            record(fixture);
            const value = backupRecords.get(backup);
            assert.ok(
                value &&
                    value.fixture === fixture &&
                    backup.target === fixture.target &&
                    backup.verified &&
                    backup.completeBundle,
            );
            assert.equal(digest(value.manifestBytes), backup.manifestSHA256);
            io.tree(value.backupRoot, value.selected.inventory);
            io.removeTree(fixture.target, value.selected.inventory, value.original);
            assert.ok(io.absent(fixture.target));
            io.tree(value.backupRoot, value.selected.inventory);
            return {
                target: fixture.target,
                returned: true,
                verifiedBackupRetained: true,
                manifestSHA256: backup.manifestSHA256,
            };
        },
    };
    return Object.freeze(effects);
}

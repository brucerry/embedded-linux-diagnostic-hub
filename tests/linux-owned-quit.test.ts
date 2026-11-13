/** Closed in-process inherited-pipe controls. No native/PTY/socket/process or filesystem mutation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { readFileSync, constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { EventEmitter } from 'node:events';
import * as protocol from '../electron/linux-setup-readback.ts';
import { createLinuxNativeSetupReadback } from '../electron/linux-setup-readback-native.ts';
import * as model from '../electron/linux-transaction-model.ts';
import * as installation from '../shared/installation.ts';
import * as menu from '../electron/linux-menu-ownership.ts';
import * as readiness from '../electron/linux-setup-readiness.ts';
import { linuxReviewArguments } from '../electron/linux-setup-ui.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';

function fixture() {
    let now = 11000,
        calls = 0;
    const binding = {
        root: '/home/test/installed',
        installationId: '11111111-1111-4111-8111-111111111111',
        transactionId: '22222222-2222-4222-8222-222222222222',
        manifestSHA256: 'a'.repeat(64),
        version: '0.7.0',
        profile: '/home/test/config/profile',
        executable: '/home/test/installed/app/diagnostic-hub',
        uid: 1000,
    };
    const record: any = {
        schemaVersion: 1,
        source: 'linux-main-self-observation',
        root: binding.root,
        installationId: binding.installationId,
        transactionId: binding.transactionId,
        manifestSHA256: binding.manifestSHA256,
        version: binding.version,
        process: { pid: 888, uid: 1000, executable: binding.executable, creationTimeMs: 10000 },
        profile: { path: binding.profile, lockOwned: true },
        window: {
            electronId: 1,
            nativeHandleHex: '0100000000000000',
            visible: true,
            minimized: false,
            mainFrameReady: true,
        },
        observedAtMs: now,
        payloadIntegrity: 'not-checked',
        independentProcessObservation: false,
        independentWindowObservation: false,
        descendantRetirement: false,
        finalizationAuthority: false,
    };
    const pair = linuxReadbackPair(),
        process = { pid: 888, uid: 1000, executable: binding.executable, startTicks: '10001' },
        parent = protocol.createLinuxInstallerQuit(pair.parent, binding, {
            now: () => now,
            nonce: () => Buffer.alloc(32, 1),
        }),
        main = protocol.createLinuxMainQuit(
            pair.child,
            () => {
                calls++;
            },
            () => now,
        );
    let refresh = async () => structuredClone({ ...record, observedAtMs: now });
    main.offer(record, () => refresh());
    return {
        binding,
        record,
        pair,
        process,
        parent,
        main,
        calls: () => calls,
        advance: (ms: number) => {
            now += ms;
        },
        refresh: (fn: typeof refresh) => {
            refresh = fn;
        },
    };
}
async function prepared(f: ReturnType<typeof fixture>) {
    const pending = f.parent.prepare(f.process);
    await f.pair.pump();
    assert.ok(await pending);
    assert.equal(f.calls(), 0);
}

test('plan-bound one-use selection rejects plain objects changed binding reused tokens and accessors', () => {
    const f = fixture(),
        selected = protocol.createLinuxOwnedQuitSelection(f.binding);
    assert.equal(protocol.consumeLinuxOwnedQuitSelection(selected, f.binding), true);
    assert.throws(() => protocol.consumeLinuxOwnedQuitSelection(selected, f.binding));
    assert.throws(() => protocol.consumeLinuxOwnedQuitSelection({}, f.binding));
    for (const value of [null, false, 0, ''])
        assert.throws(() => protocol.consumeLinuxOwnedQuitSelection(value as never, f.binding));
    const other = protocol.createLinuxOwnedQuitSelection(f.binding);
    assert.throws(() =>
        protocol.consumeLinuxOwnedQuitSelection(other, { ...f.binding, root: '/foreign' }),
    );
    let getter = false;
    const input = { ...f.binding };
    Object.defineProperty(input, 'root', {
        get() {
            getter = true;
            return f.binding.root;
        },
    });
    assert.throws(() => protocol.createLinuxOwnedQuitSelection(input));
    assert.equal(getter, false);
});

test('fresh prepare and accepted request close both control directions before normal callback; ACK is not root closure', async () => {
    const f = fixture();
    await prepared(f);
    const pending = f.parent.commit();
    await f.pair.pump();
    assert.equal(await pending, true);
    assert.equal(f.calls(), 1);
    assert.equal(f.main.summary().closed, true);
    assert.equal(f.parent.summary().closed, true);
    assert.equal(f.parent.summary().normalCloseObserved, false);
    assert.equal(f.parent.summary().releaseAcceptance, false);
    await f.parent.joinClosure();
    await f.main.joinClosure();
});

test('changed binding stale preparation and changed window at commit refuse without invoking quit', async () => {
    for (const mode of ['binding', 'stale', 'window']) {
        const f = fixture();
        let pending: Promise<unknown>;
        if (mode === 'binding')
            f.refresh(async () => ({
                ...f.record,
                transactionId: '33333333-3333-4333-8333-333333333333',
            }));
        if (mode === 'binding') {
            pending = f.parent.prepare(f.process);
        } else {
            await prepared(f);
            if (mode === 'stale') f.advance(2000);
            else
                f.refresh(async () => ({
                    ...f.record,
                    window: { ...f.record.window, electronId: 2 },
                }));
            pending = f.parent.commit();
        }
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await f.pair.pump();
        if (mode !== 'stale') {
            // Remote refusal retains its port; it cannot manufacture a parent reply or EOF.
            assert.equal(f.main.summary().failed, true);
            assert.equal(f.main.summary().closed, false);
            assert.equal(f.parent.summary().failed, false);
            assert.equal(f.parent.summary().closed, false);
            assert.equal(f.parent.summary().accepted, false);
            assert.equal(settled, false);
            // The existing owner's explicit stop settles its waiter without releasing custody.
            f.parent.abort();
        } else {
            assert.equal(settled, true);
            assert.equal(f.parent.summary().failed, true);
        }
        assert.equal(await pending, mode === 'binding' ? null : false);
        await assert.rejects(f.parent.joinClosure());
        assert.equal(f.calls(), 0);
    }
});

test('duplicate/reentrant frames backpressure write errors EOF and control errors never invoke normal quit', async () => {
    for (const mode of ['duplicate', 'backpressure', 'write-error', 'eof', 'error']) {
        const f = fixture();
        if (mode === 'backpressure') f.pair.parent.backpressure = true;
        if (mode === 'write-error') f.pair.parent.writeError = true;
        const p = f.parent.prepare(f.process);
        if (mode === 'duplicate')
            f.pair.parent.emit(
                'data',
                Buffer.from('{"v":1,"kind":"quit-accepted","nonce":"' + '01'.repeat(32) + '"}\n'),
            );
        if (mode === 'eof') f.pair.parent.emit('end');
        if (mode === 'error') f.pair.parent.emit('error', undefined);
        await f.pair.pump();
        assert.equal(await p, null);
        assert.equal(f.calls(), 0);
    }
});

test('callback throw undefined remains recorded and blocked rather than a successful quit result', async () => {
    const f = fixture();
    // A separate pair avoids replacing any already registered listener or failure owner.
    const pair = linuxReadbackPair(),
        parent = protocol.createLinuxInstallerQuit(pair.parent, f.binding, {
            now: () => 11000,
            nonce: () => Buffer.alloc(32, 2),
        }),
        main = protocol.createLinuxMainQuit(
            pair.child,
            () => {
                throw undefined;
            },
            () => 11000,
        );
    main.offer(f.record, async () => f.record);
    const ready = parent.prepare(f.process);
    await pair.pump();
    assert.ok(await ready);
    const accepted = parent.commit();
    await pair.pump();
    // Acceptance is intentionally weaker than the callback or actual process closure.
    assert.equal(await accepted, true);
    assert.equal(main.summary().failed, true);
    assert.equal(main.summary().requestReturned, false);
    assert.equal(main.failure().primarySet, true);
    assert.equal(main.failure().primary, undefined);
    await assert.rejects(main.joinClosure());
});

test('unsupported async callback retains rejected and late outcomes without reading thenable getters', async () => {
    for (const mode of ['rejected', 'late', 'thenable']) {
        const f = fixture(),
            pair = linuxReadbackPair();
        let reject!: (value: unknown) => void,
            getter = false;
        const returned =
            mode === 'thenable'
                ? Object.defineProperty({}, 'then', {
                      get() {
                          getter = true;
                          throw Error();
                      },
                  })
                : new Promise<void>((_resolve, fail) => {
                      reject = fail;
                  });
        const parent = protocol.createLinuxInstallerQuit(pair.parent, f.binding, {
                now: () => 11000,
                nonce: () => Buffer.alloc(32, 3),
            }),
            main = protocol.createLinuxMainQuit(
                pair.child,
                (() => {
                    if (mode === 'rejected') reject(undefined);
                    return returned;
                }) as () => void,
                () => 11000,
            );
        main.offer(f.record, async () => f.record);
        const ready = parent.prepare(f.process);
        await pair.pump();
        assert.ok(await ready);
        const accepted = parent.commit();
        await pair.pump();
        assert.equal(await accepted, true);
        assert.equal(main.summary().failed, true);
        assert.equal(main.summary().requestReturned, false);
        assert.equal(main.failure().lastReturn, returned);
        assert.equal(getter, false);
        if (mode === 'thenable') assert.equal(main.failure().returnJoinErrorSet, true);
        else {
            if (mode === 'late') {
                assert.equal(main.summary().callbackReturnPending, true);
                reject(undefined);
            }
            await main.failure().returnTask;
            assert.deepEqual(main.failure().returnOutcome, {
                settled: true,
                fulfilled: false,
                value: undefined,
            });
        }
        await assert.rejects(main.joinClosure());
    }
});

test('native opt-in refuses descriptor inode/object alias and postconstruction change without default IO', async () => {
    for (const mode of ['inode-alias', 'object-alias', 'changed', 'without-startup']) {
        const a = linuxReadbackPair(),
            b = linuxReadbackPair();
        let reads = 0;
        const value = (ino: number) => ({ dev: 1, ino, uid: 1000, isSocket: () => true });
        const owner = createLinuxNativeSetupReadback(
            {
                enabled: mode !== 'without-startup',
                cooperativeQuit: true,
                platform: 'linux',
                layout: 'linux-folder',
                packaged: true,
                uid: 1000,
                euid: 1000,
            },
            {
                stat: () => value(1),
                socket: () => a.child,
                quitStat: () =>
                    value(mode === 'inode-alias' ? 1 : mode === 'changed' && ++reads > 1 ? 3 : 2),
                quitSocket: () => (mode === 'object-alias' ? a.child : b.child),
            },
            () => {},
        );
        assert.equal(owner.summary().unknown, true, mode);
        await assert.rejects(owner.joinClosure());
    }
});

// Reuse only the exact closed-memory fixture prefix, never its old test registrations.
const baseURL = new URL('./linux-initial-finalize.test.ts', import.meta.url),
    raw = readFileSync(baseURL, 'utf8'),
    tree = ts.createSourceFile('fixed-finalize-prefix.ts', raw, ts.ScriptTarget.ES2022, true),
    registration = tree.statements.find(
        (node) =>
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'test',
    );
assert.ok(registration);
const prefix = tree.statements
    .filter((node) => node.pos < registration.pos && !ts.isImportDeclaration(node))
    .map((node) => node.getText(tree))
    .join('\n')
    .replaceAll('import.meta.url', JSON.stringify(baseURL.href));
const module = { exports: {} as any },
    root = new URL('../', import.meta.url),
    sourcePaths = new Set(
        [
            'tests/linux-initial-finalize.test.ts',
            'tests/linux-retained-generations.test.ts',
            'tests/linux-native-backend.test.ts',
            'electron/installation-maintenance.ts',
            'electron/linux-setup-readback-native.ts',
            'electron/linux-initial-uninstall.ts',
            'electron/linux-retained-cleanup.ts',
            'electron/linux-native-backend.ts',
            'electron/linux-native-driver.ts',
            'electron/linux-owned-launch.ts',
            'electron/linux-setup-readiness.ts',
            'electron/linux-setup-readback.ts',
            'electron/linux-permanent-setup.ts',
        ].map((name) => new URL(name, root).href),
    );
const compiled = ts.transpileModule(
    prefix + '\nmodule.exports={updated,start,close,join,owned,readback,backend,driver};',
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    },
);
new vm.Script(compiled.outputText, { filename: 'fixed-finalize-prefix.memory.cjs' }).runInContext(
    vm.createContext(
        {
            module,
            exports: module.exports,
            assert,
            vm,
            ts,
            path,
            constants,
            createHash,
            randomBytes,
            utilTypes,
            EventEmitter,
            model,
            installation,
            menu,
            readiness,
            linuxReviewArguments,
            linuxReadbackPair,
            Object,
            JSON,
            Map,
            Set,
            WeakMap,
            Buffer,
            Error,
            Promise,
            TextDecoder,
            URL,
            structuredClone,
            queueMicrotask,
            readFileSync(file: URL, encoding: 'utf8') {
                assert.ok(file instanceof URL && sourcePaths.has(file.href));
                return readFileSync(file, encoding);
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    ),
    { timeout: 1000 },
);

for (const paused of [false, true])
    test(
        paused
            ? 'actual owned pause checkpoint normally quits and closes without Finalize success'
            : 'actual owned Finalize and cooperative app quit require independent process pipe control and lease closure',
        async () => {
            const helpers = module.exports,
                { f, originalA, originalB } = await helpers.updated(),
                pair = linuxReadbackPair();
            let attempt: any,
                normalCalls = 0;
            const synced: string[] = [],
                fsync = f.ops.fs.fsyncSync;
            f.ops.fs.fsyncSync = (fd: number) => {
                synced.push(f.fds.get(fd).path);
                return fsync(fd);
            };
            const original = helpers.owned.createLinuxOwnedLaunch;
            helpers.owned.createLinuxOwnedLaunch = (...args: any[]) => {
                const plan = args[0];
                args[6] = helpers.readback.createLinuxOwnedQuitSelection({
                    root: plan.root,
                    installationId: plan.installationId,
                    transactionId: plan.transactionId,
                    manifestSHA256: plan.review.source.verifiedManifestSHA256,
                    version: plan.host.version,
                    profile: plan.review.root.profile,
                    executable: plan.root + '/app/diagnostic-hub',
                    uid: plan.host.uid,
                });
                if (paused) args[7] = helpers.backend.createLinuxSealInterruptionSelection();
                const spawn = args[4].spawn;
                args[4] = {
                    spawn(request: any) {
                        assert.equal(request.quitControl, true);
                        const child = spawn(request);
                        child.stdio[4] = pair.parent;
                        return child;
                    },
                };
                return Reflect.apply(original, undefined, args);
            };
            const main = helpers.readback.createLinuxMainQuit(pair.child, () => {
                normalCalls++;
                helpers.close(f, attempt);
            });
            try {
                attempt = f.run('finalize');
                await helpers.start(f, attempt);
                const refresh = f.readyIO(attempt),
                    initial = await refresh();
                assert.ok(initial);
                main.offer(initial, refresh);
                attempt.main = helpers.readback.createLinuxMainReadback(attempt.pair.child);
                attempt.main.offer(initial, refresh);
                for (let at = 0; at < 10000 && !attempt.settled; at++) {
                    await attempt.pair.pump(() => true);
                    await pair.pump(() => true);
                }
                assert.equal(attempt.settled, true);
                const result = await attempt.operation;
                assert.equal(normalCalls, 1);
                assert.equal(result.result.reservation, 'none');
                assert.equal(result.result.childOwned, false);
                assert.equal(result.result.quitControl.closed, true);
                assert.equal(result.result.readback.closed, true);
                assert.equal(result.result.exited, true);
                assert.equal(result.result.closed, true);
                assert.equal(result.result.pipes.stdout.end, true);
                assert.equal(result.result.pipes.stdout.close, true);
                assert.equal(result.result.pipes.stderr.end, true);
                assert.equal(result.result.pipes.stderr.close, true);
                assert.equal(f.servers.at(-1).listening, false);
                assert.equal(f.fds.size, 0);
                assert.equal(result.result.wholeGroupRetirement, false);
                if (paused) {
                    assert.equal(result.result.verdict, 'SEAL_PREPARATION_PAUSED');
                    assert.equal(result.result.retainedConfirmed, false);
                    const observed = attempt.controller.sealInterruptionObservation();
                    assert.ok(observed);
                    assert.equal(observed.kind, 'cooperative-seal-preparing-pause');
                    assert.equal(observed.releaseAcceptance, false);
                    assert.equal(observed.staged.bytes, 0);
                    assert.equal(observed.nativeQualified, false);
                    assert.equal(observed.abruptInterruptionObserved, false);
                    const ledger =
                        f.work +
                        '-finalize-' +
                        observed.cleanup.snapshot.configuration.transactionId;
                    assert.deepEqual(
                        Buffer.from(f.node(f.work + '/journal.json').bytes),
                        originalB,
                    );
                    assert.deepEqual(
                        Buffer.from(f.node(ledger + '/original-journal.json').bytes),
                        originalB,
                    );
                    assert.deepEqual(
                        Buffer.from(f.node(ledger + '/original-completed-journal.json').bytes),
                        originalA,
                    );
                    assert.equal(
                        f.node(ledger + '/confirmed-journal.json').ino,
                        observed.staged.ino,
                    );
                    assert.equal(f.node(ledger + '/confirmed-journal.json').bytes.length, 0);
                    assert.deepEqual(
                        Buffer.from(f.node(ledger + '/snapshot.json').bytes),
                        observed.cleanup.rawSnapshot,
                    );
                    assert.deepEqual(
                        JSON.parse(f.node(ledger + '/seal-intent.json').bytes.toString()),
                        observed.cleanup.seal.intent,
                    );
                    assert.ok(synced.includes(ledger + '/confirmed-journal.json'));
                    assert.ok(synced.includes(ledger + '/seal-intent.json'));
                } else assert.equal(result.status, 'previous-generation-finalized');
            } finally {
                helpers.owned.createLinuxOwnedLaunch = original;
                if (attempt) await helpers.join(f, attempt);
            }
        },
    );

test('actual constructors reject falsey quit or seal choices before any native host effect', async () => {
    const helpers = module.exports,
        { f } = await helpers.updated(),
        preparation = helpers.driver.prepareLinuxNativeDriver(
            {
                host: f.plan.host,
                root: f.plan.root,
                action: 'finalize',
                dataHome: '/home/test/data',
                menu: false,
            },
            { startedMs: 0, deadlineMs: 120000 },
            f.ops,
            f.plan.owner,
        ),
        view = await preparation.inspect(),
        plan = preparation.plan(view, false),
        binding = {
            root: plan.root,
            installationId: plan.installationId,
            transactionId: plan.transactionId,
            manifestSHA256: plan.review.source.verifiedManifestSHA256,
            version: plan.host.version,
            profile: plan.review.root.profile,
            executable: plan.root + '/app/diagnostic-hub',
            uid: plan.host.uid,
        };
    for (const value of [null, false, 0, '']) {
        const at = f.calls.length;
        assert.throws(() =>
            helpers.owned.createLinuxOwnedLaunch(
                plan,
                { startedMs: 0, deadlineMs: 120000 },
                { DISPLAY: ':99' },
                f.ops,
                {
                    spawn() {
                        throw Error('UNEXPECTED_SPAWN');
                    },
                },
                true,
                value,
            ),
        );
        assert.throws(() =>
            helpers.backend.createLinuxNativeBackend(
                plan,
                { startedMs: 0, deadlineMs: 120000 },
                f.ops,
                value,
            ),
        );
        const quit = helpers.readback.createLinuxOwnedQuitSelection(binding);
        assert.throws(() =>
            helpers.owned.createLinuxOwnedLaunch(
                plan,
                { startedMs: 0, deadlineMs: 120000 },
                { DISPLAY: ':99' },
                f.ops,
                {
                    spawn() {
                        throw Error('UNEXPECTED_SPAWN');
                    },
                },
                true,
                quit,
                value,
            ),
        );
        assert.equal(f.calls.length, at);
    }
});

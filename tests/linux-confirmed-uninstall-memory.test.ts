/** Real shipping install/update/Finalize/remover source with closed MapFS and
 * manual process/pipe ports only. No native load, physical deletion or OS actor. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { readFileSync, constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { EventEmitter } from 'node:events';
import * as model from '../electron/linux-transaction-model.ts';
import * as installation from '../shared/installation.ts';
import * as menu from '../electron/linux-menu-ownership.ts';
import * as readiness from '../electron/linux-setup-readiness.ts';
import { linuxReviewArguments } from '../electron/linux-setup-ui.ts';
import { linuxReadbackPair } from './fixtures/linux-readback-port.ts';

const root = new URL('../', import.meta.url),
    hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'),
    baseURL = new URL('tests/linux-initial-finalize.test.ts', root),
    raw = readFileSync(baseURL, 'utf8');
assert.equal(hash(raw), 'a242d9290ad30d871fbc7388c1fae9496914479e40abacfc42915d69276e403c');
const tree = ts.createSourceFile(
        'fixed-finalize-declarations.ts',
        raw,
        ts.ScriptTarget.ES2022,
        true,
    ),
    first = tree.statements.find(
        (node) =>
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'test',
    );
assert.ok(first);
// The old whole file is never imported or registered. Only its reviewed inert
// prefix is evaluated under this independent fixed-source read boundary.
const prefix = tree.statements
    .filter((node) => node.pos < first.pos && !ts.isImportDeclaration(node))
    .map((node) => node.getText(tree))
    .join('\n')
    .replaceAll('import.meta.url', JSON.stringify(baseURL.href));
const reads = new Set(
    [
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
const result = ts.transpileModule(
    prefix +
        '\nmodule.exports={seed,updated,start,boot,close,join,interruptedSeal,authoredSealRestart,maintenance};',
    {
        fileName: 'fixed-finalize-declarations.ts',
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    },
);
assert.equal(
    (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
        .length,
    0,
);
const module = { exports: {} as any };
new vm.Script(result.outputText, {
    filename: 'confirmed-uninstall-fixtures.memory.cjs',
}).runInContext(
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
            WeakSet,
            Buffer,
            Error,
            Promise,
            TextDecoder,
            URL,
            structuredClone,
            queueMicrotask,
            readFileSync(file: URL, encoding: 'utf8') {
                assert.ok(file instanceof URL && reads.has(file.href));
                return readFileSync(file, encoding);
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    ),
    { timeout: 1000 },
);
const helpers = module.exports,
    bytes = (f: any, file: string) => Buffer.from(f.node(file).bytes),
    json = (f: any, file: string) => JSON.parse(bytes(f, file).toString()),
    mutates = (name: string) =>
        ['write', 'truncate', 'mkdir', 'move-noreplace', 'unlink-owned'].includes(name);
function inventory(f: any, prefix: string) {
    return [...f.nodes.entries()]
        .filter(([name]) => name === prefix || name.startsWith(prefix + '/'))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, node]: [string, any]) => ({
            path: name,
            kind: node.kind,
            ino: node.ino,
            uid: node.uid,
            mode: node.mode,
            bytes: node.bytes.toString('base64'),
        }));
}
function unchanged(f: any, before: ReturnType<typeof inventory>, prefix: string) {
    assert.deepEqual(inventory(f, prefix), before);
}
/** Only the newly selected MapFS disposal slot is extended. No default FS port. */
function removalPort(f: any) {
    f.ops.unlinkOwned = (fd: number, name: string, kind: string, identity: any) => {
        const file = f.fds.get(fd).path + '/' + name,
            node = f.node(file);
        assert.equal(file, f.work + '-uninstall/disposal/entry');
        assert.equal(name, 'entry');
        assert.equal(identity.dev, 1);
        assert.equal(node.ino, identity.ino);
        assert.equal(node.uid, f.plan.host.uid);
        assert.equal(f.node(path.posix.dirname(file)).mode & 0o7777, 0o700);
        assert.equal(node.kind, kind);
        if (kind === 'directory')
            assert.equal(
                [...f.nodes.keys()].some((other) => path.posix.dirname(other) === file),
                false,
            );
        f.calls.push('unlink-owned');
        f.unlinkCalls.push(file);
        f.beforeUnlink?.(file);
        f.nodes.delete(file);
        f.afterUnlink?.(file);
    };
}
async function finalize(f: any, retained: boolean) {
    const attempt = f.run('finalize');
    try {
        await helpers.start(f, attempt);
        await helpers.boot(f, attempt);
        assert.equal(attempt.controller.summary().retainedConfirmed, retained);
        assert.equal(attempt.controller.summary().initialConfirmed, !retained);
        helpers.close(f, attempt);
        const completed = await attempt.operation;
        assert.equal(
            completed.status,
            retained ? 'previous-generation-finalized' : 'initial-finalized',
        );
        assert.equal(completed.result.wholeGroupRetirement, false);
        await attempt.main.joinClosure();
        assert.equal(f.fds.size, 0);
    } finally {
        await helpers.join(f, attempt);
    }
}
async function confirmed() {
    const { f, originalA, originalB } = await helpers.updated(),
        journal = JSON.parse(originalB.toString()),
        ledger = f.work + '-finalize-' + journal.transactionId,
        profile = journal.profile + '/keep';
    f.file(profile, 'settings-and-reports retained');
    await finalize(f, true);
    assert.equal(json(f, ledger + '/state.json').phase, 'complete');
    assert.equal(json(f, f.work + '/journal.json').phase, 'candidate-confirmed');
    assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
    assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
    assert.equal(f.nodes.has(ledger + '/confirmed-journal.json'), false);
    assert.equal(f.nodes.has(f.work + '/previous-' + journal.transactionId), false);
    const anchor = bytes(f, f.work + '/journal.json'),
        anchorIno = f.node(f.work + '/journal.json').ino;
    removalPort(f);
    return { f, ledger, profile, originalA, originalB, anchor, anchorIno };
}
async function remove(f: any) {
    const attempt = f.run('uninstall-current'),
        result = await attempt.operation;
    assert.equal(
        attempt.requests.length,
        0,
        'Uninstall cannot fall through to the app-launch port.',
    );
    return {
        attempt,
        result,
        diagnostics: attempt.api.linuxPermanentSetupDiagnostics(result.owner),
    };
}
function stopped(result: Awaited<ReturnType<typeof remove>>) {
    assert.equal(result.result.status, 'retained-unknown');
    assert.equal(result.diagnostics.phase, 'retained-unknown');
    // A returned removal failure remains owned by the remover, while an inspect
    // rejection also reaches the outer caller's catch. Neither is a successful run.
    assert.equal(result.diagnostics.primarySet || result.diagnostics.uninstall?.primarySet, true);
}
/** An explicit test-only OS-restart precondition for manual MapFS endpoints.
 * It does not call release or close any old product owner/FD, or claim retirement. */
function memoryRestart(f: any) {
    for (const server of f.servers) server.listening = false;
    f.afterCleanupMove = undefined;
    f.beforeCleanupMove = undefined;
    f.afterUnlink = undefined;
}

test('actual memory A install B update published Finalize and B uninstall preserve all cleanup originals profile and source through a fresh install', async () => {
    const { f, ledger, profile, originalA, originalB, anchor, anchorIno } = await confirmed(),
        ledgerBefore = inventory(f, ledger),
        sourceBefore = inventory(f, f.plan.host.sourceRoot),
        before = f.unlinkCalls.length,
        removed = await remove(f),
        location = f.work + '-uninstall';
    assert.equal(removed.result.status, 'current-payload-removed');
    assert.equal(f.nodes.has(f.plan.root), false);
    assert.equal(f.nodes.has(f.work), false);
    unchanged(f, ledgerBefore, ledger);
    unchanged(f, sourceBefore, f.plan.host.sourceRoot);
    assert.equal(bytes(f, profile).toString(), 'settings-and-reports retained');
    assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalB);
    assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), originalA);
    assert.deepEqual(bytes(f, location + '/original-maintenance/journal.json'), anchor);
    assert.equal(f.node(location + '/original-maintenance/journal.json').ino, anchorIno);
    const snapshot = json(f, location + '/snapshot.json');
    assert.equal(snapshot.initial.journal.phase, 'candidate-confirmed');
    assert.ok(snapshot.confirmedCleanup);
    assert.equal(snapshot.confirmedCleanup.anchor.ino, anchorIno);
    assert.equal(snapshot.confirmedCleanup.anchor.sha256, hash(anchor));
    assert.equal(f.unlinkCalls.length - before, snapshot.entries.length);
    assert.equal(json(f, location + '/state.json').phase, 'complete');
    assert.equal(removed.result.result.originalRecordsRetained, true);
    assert.equal(removed.result.result.priorRecoveryPayloadsRemoved, false);
    assert.equal(removed.result.result.finalizationAuthority, false);
    assert.equal(f.fds.size, 0);
    assert.equal(f.servers.at(-1).listening, false);
    const removalBefore = inventory(f, location),
        oldId = snapshot.initial.root.installationId,
        installed = await f.run('install').operation,
        archive = f.work + '-removed-' + oldId;
    assert.equal(installed.status, 'finished');
    assert.equal(f.nodes.has(location), false);
    for (const entry of removalBefore) {
        const node = f.node(archive + entry.path.slice(location.length));
        assert.equal(node.ino, entry.ino);
        assert.equal(node.bytes.toString('base64'), entry.bytes);
    }
    assert.notEqual(
        json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD).installationId,
        oldId,
    );
    unchanged(f, ledgerBefore, ledger);
    unchanged(f, sourceBefore, f.plan.host.sourceRoot);
    assert.equal(bytes(f, profile).toString(), 'settings-and-reports retained');
    assert.equal(f.fds.size, 0);
});

test('actual memory initial active and actually archived initial Finalize remain compatible without a confirmed-cleanup snapshot', async () => {
    for (const archived of [false, true]) {
        const f = await helpers.seed(),
            journal = json(f, f.work + '/journal.json'),
            profile = journal.profile + '/keep';
        f.file(profile, 'initial profile retained');
        if (archived) await finalize(f, false);
        const name = archived ? 'completed-journal.json' : 'journal.json',
            original = bytes(f, f.work + '/' + name);
        removalPort(f);
        const result = await remove(f),
            location = f.work + '-uninstall';
        assert.equal(result.result.status, 'current-payload-removed');
        assert.equal(json(f, location + '/snapshot.json').confirmedCleanup, undefined);
        assert.deepEqual(bytes(f, location + '/original-maintenance/' + name), original);
        assert.equal(bytes(f, profile).toString(), 'initial profile retained');
        assert.equal(f.fds.size, 0);
    }
});

test('actual memory durable preparing ready and publication-gap states cannot be uninstalled as confirmed generations', async () => {
    for (const phase of ['preparing', 'ready', 'gap']) {
        const { f, originalB } = await helpers.updated(),
            journal = JSON.parse(originalB.toString()),
            ledger = f.work + '-finalize-' + journal.transactionId;
        let injected = 0;
        if (phase === 'preparing') {
            const write = f.ops.fs.writeSync;
            f.ops.fs.writeSync = (fd: number, ...args: any[]) => {
                if (!injected && f.fds.get(fd).path === ledger + '/confirmed-journal.json') {
                    injected++;
                    throw undefined;
                }
                return write(fd, ...args);
            };
        } else {
            const interrupt = (from: string, to: string) => {
                if (
                    from === f.work + '/journal.json' &&
                    to === ledger + '/unconfirmed-journal.json'
                ) {
                    injected++;
                    throw undefined;
                }
            };
            if (phase === 'ready') f.beforeCleanupMove = interrupt;
            else f.afterCleanupMove = interrupt;
        }
        await helpers.interruptedSeal(f);
        assert.equal(injected, 1);
        assert.equal(json(f, ledger + '/state.json').phase, 'complete');
        assert.equal(
            f.node(ledger + '/confirmed-journal.json').bytes.length === 0,
            phase === 'preparing',
        );
        assert.equal(f.nodes.has(f.work + '/journal.json'), phase !== 'gap');
        assert.equal(f.nodes.has(ledger + '/unconfirmed-journal.json'), phase === 'gap');
        memoryRestart(f);
        removalPort(f);
        const before = inventory(f, ledger),
            rootBefore = inventory(f, f.plan.root),
            at = f.calls.length;
        stopped(await remove(f));
        assert.equal(f.calls.slice(at).some(mutates), false);
        unchanged(f, before, ledger);
        unchanged(f, rootBefore, f.plan.root);
        assert.equal(f.nodes.has(f.work + '-uninstall'), false);
    }
});

test('actual memory published cleanup rejects missing legacy-looking intent foreign content and changed bound anchors before removing current data', async () => {
    for (const mode of [
        'missing-intent',
        'foreign-entry',
        'original-bytes',
        'retired-inode',
        'current-inode',
        'ledger-consent-inode',
    ]) {
        const { f, ledger, profile } = await confirmed();
        if (mode === 'missing-intent') f.nodes.delete(ledger + '/seal-intent.json');
        if (mode === 'foreign-entry') f.file(ledger + '/unlisted', 'foreign');
        if (mode === 'original-bytes')
            f.node(ledger + '/original-journal.json').bytes = Buffer.from('changed');
        if (mode === 'retired-inode')
            f.file(
                ledger + '/unconfirmed-journal.json',
                bytes(f, ledger + '/unconfirmed-journal.json'),
                0o600,
            );
        if (mode === 'current-inode')
            f.file(f.work + '/journal.json', bytes(f, f.work + '/journal.json'), 0o600);
        let injected = 0;
        if (mode === 'ledger-consent-inode')
            Object.defineProperty(f, 'reply', {
                configurable: true,
                get() {
                    injected++;
                    f.node(ledger).ino += 1000;
                    return { status: 'confirmed', menu: false };
                },
            });
        const rootBefore = inventory(f, f.plan.root),
            at = f.calls.length;
        stopped(await remove(f));
        assert.equal(f.calls.slice(at).some(mutates), false);
        assert.equal(injected, mode === 'ledger-consent-inode' ? 1 : 0);
        unchanged(f, rootBefore, f.plan.root);
        assert.equal(f.nodes.has(f.work + '-uninstall'), false);
        assert.equal(bytes(f, profile).toString(), 'settings-and-reports retained');
    }
});

test('actual memory issued root move and unlink recover only their durable one-sided postimages while old owner custody stays retained', async () => {
    for (const phase of ['root-move', 'unlink']) {
        const { f, ledger, profile, anchor } = await confirmed(),
            kept = inventory(f, ledger);
        let injected = 0;
        if (phase === 'root-move')
            f.afterCleanupMove = (from: string, to: string) => {
                if (from === f.plan.root && to === f.work + '-uninstall/payload') {
                    injected++;
                    throw undefined;
                }
            };
        else
            f.afterUnlink = () => {
                if (!injected) {
                    injected++;
                    throw undefined;
                }
            };
        const failed = await remove(f);
        stopped(failed);
        assert.equal(injected, 1);
        assert.equal(failed.diagnostics.uninstall.reservation, 'held');
        assert.equal(failed.diagnostics.uninstall.primarySet, true);
        const location = f.work + '-uninstall',
            progress = json(f, location + '/state.json');
        if (phase === 'root-move') assert.equal(progress.phase, 'root-issued');
        else {
            assert.equal(progress.phase, 'deleting');
            assert.equal(progress.leaf, 'unlink-issued');
        }
        assert.equal(f.nodes.has(f.plan.root), false);
        unchanged(f, kept, ledger);
        const oldFDs = f.fds.size;
        memoryRestart(f);
        const resumed = await remove(f);
        assert.equal(resumed.result.status, 'current-payload-removed');
        assert.equal(json(f, location + '/state.json').phase, 'complete');
        assert.deepEqual(bytes(f, location + '/original-maintenance/journal.json'), anchor);
        unchanged(f, kept, ledger);
        assert.equal(bytes(f, profile).toString(), 'settings-and-reports retained');
        assert.equal(
            f.fds.size,
            oldFDs,
            'The new owner must not close retained old-owner MapFS descriptors.',
        );
        assert.equal(resumed.diagnostics.uninstall.reservation, 'none');
        assert.equal(
            failed.attempt.api.linuxPermanentSetupDiagnostics(failed.result.owner).uninstall
                .reservation,
            'held',
        );
    }
});

test('actual memory quarantined-current recovery refuses a replaced original anchor or changed external cleanup ledger', async () => {
    for (const mode of ['anchor-inode', 'ledger-bytes', 'ledger-inode']) {
        const { f, ledger, profile } = await confirmed();
        let injected = 0;
        f.afterUnlink = () => {
            if (!injected) {
                injected++;
                throw undefined;
            }
        };
        const failed = await remove(f);
        stopped(failed);
        assert.equal(injected, 1);
        const location = f.work + '-uninstall',
            anchor = location + '/original-maintenance/journal.json';
        assert.equal(json(f, location + '/state.json').leaf, 'unlink-issued');
        memoryRestart(f);
        if (mode === 'anchor-inode') f.file(anchor, bytes(f, anchor), 0o600);
        if (mode === 'ledger-bytes')
            f.node(ledger + '/original-completed-journal.json').bytes = Buffer.from('changed');
        if (mode === 'ledger-inode') f.node(ledger).ino += 1000;
        const at = f.calls.length,
            remaining = inventory(f, location);
        stopped(await remove(f));
        assert.equal(f.calls.slice(at).some(mutates), false);
        unchanged(f, remaining, location);
        assert.equal(bytes(f, profile).toString(), 'settings-and-reports retained');
        assert.equal(f.nodes.has(f.plan.root), false);
    }
});

test('actual memory original-ledger read or close throwing undefined retains descriptor custody and cannot begin uninstall', async () => {
    for (const phase of ['read', 'close']) {
        const { f, ledger, profile } = await confirmed(),
            rootBefore = inventory(f, f.plan.root),
            target = ledger + '/original-journal.json';
        let injected = 0;
        if (phase === 'read') {
            const read = f.ops.fs.readSync;
            f.ops.fs.readSync = (fd: number, ...args: any[]) => {
                if (!injected && f.fds.get(fd).path === target) {
                    injected++;
                    throw undefined;
                }
                return read(fd, ...args);
            };
        } else {
            const close = f.ops.fs.closeSync;
            f.ops.fs.closeSync = (fd: number) => {
                if (!injected && f.fds.get(fd).path === target) {
                    injected++;
                    throw undefined;
                }
                return close(fd);
            };
        }
        const at = f.calls.length,
            failed = await remove(f);
        stopped(failed);
        assert.equal(injected, 1);
        assert.equal(f.calls.slice(at).some(mutates), false);
        assert.equal(failed.diagnostics.uninstall.backend.primarySet, true);
        assert.ok(failed.diagnostics.uninstall.backend.retainedFDs > 0);
        unchanged(f, rootBefore, f.plan.root);
        assert.equal(bytes(f, profile).toString(), 'settings-and-reports retained');
        assert.equal(f.nodes.has(f.work + '-uninstall'), false);
    }
});

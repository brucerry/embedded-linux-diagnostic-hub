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
        '\nmodule.exports={seed,updated,candidate,start,boot,close,join,interruptedSeal,authoredSealRestart,maintenance};',
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
    filename: 'second-confirmed-uninstall-fixtures.memory.cjs',
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
    f.removalInodes = [];
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
        f.removalInodes.push(identity.dev + ':' + identity.ino);
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
        journalB = JSON.parse(originalB.toString()),
        parentLedger = f.work + '-finalize-' + journalB.transactionId,
        profile = journalB.profile + '/keep';
    f.file(profile, 'profile retained across both seals and removal');
    await finalize(f, true);
    const parentAnchor = bytes(f, f.work + '/journal.json'),
        parentAnchorIno = f.node(f.work + '/journal.json').ino;
    helpers.candidate(f, '0.8.0');
    assert.equal((await f.run('update').operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const originalC = bytes(f, f.work + '/journal.json'),
        journalC = JSON.parse(originalC.toString()),
        ledger = f.work + '-finalize-' + journalC.transactionId;
    await finalize(f, true);
    assert.equal(json(f, ledger + '/state.json').phase, 'complete');
    assert.equal(json(f, parentLedger + '/state.json').phase, 'complete');
    assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), parentAnchor);
    assert.equal(f.node(ledger + '/original-completed-journal.json').ino, parentAnchorIno);
    assert.deepEqual(bytes(f, parentLedger + '/original-journal.json'), originalB);
    assert.deepEqual(bytes(f, parentLedger + '/original-completed-journal.json'), originalA);
    const anchor = bytes(f, f.work + '/journal.json'),
        anchorIno = f.node(f.work + '/journal.json').ino;
    removalPort(f);
    return {
        f,
        ledger,
        parentLedger,
        profile,
        originalA,
        originalB,
        originalC,
        anchor,
        anchorIno,
        parentAnchor,
        parentAnchorIno,
    };
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

function originals(s: Awaited<ReturnType<typeof confirmed>>) {
    const {
        f,
        ledger,
        parentLedger,
        originalA,
        originalB,
        originalC,
        parentAnchor,
        parentAnchorIno,
        profile,
    } = s;
    assert.deepEqual(bytes(f, parentLedger + '/original-completed-journal.json'), originalA);
    assert.deepEqual(bytes(f, parentLedger + '/original-journal.json'), originalB);
    assert.deepEqual(bytes(f, ledger + '/original-journal.json'), originalC);
    assert.deepEqual(bytes(f, ledger + '/original-completed-journal.json'), parentAnchor);
    assert.equal(f.node(ledger + '/original-completed-journal.json').ino, parentAnchorIno);
    assert.equal(bytes(f, profile).toString(), 'profile retained across both seals and removal');
}
function bothUnchanged(s: Awaited<ReturnType<typeof confirmed>>, prior: any) {
    unchanged(s.f, prior.current, s.ledger);
    unchanged(s.f, prior.parent, s.parentLedger);
    originals(s);
}
function kept(s: Awaited<ReturnType<typeof confirmed>>) {
    return { current: inventory(s.f, s.ledger), parent: inventory(s.f, s.parentLedger) };
}

test('actual memory A B C two-seal uninstall preserves both ledgers and profile through a fresh install', async () => {
    const s = await confirmed(),
        { f, ledger, anchor, anchorIno } = s,
        before = kept(s),
        source = inventory(f, f.plan.host.sourceRoot),
        removed = await remove(f),
        location = f.work + '-uninstall';
    assert.equal(removed.result.status, 'current-payload-removed');
    assert.equal(f.nodes.has(f.plan.root), false);
    assert.equal(f.nodes.has(f.work), false);
    bothUnchanged(s, before);
    unchanged(f, source, f.plan.host.sourceRoot);
    const snapshot = json(f, location + '/snapshot.json');
    assert.deepEqual(snapshot.confirmedCleanup.parent, json(f, ledger + '/snapshot.json').parent);
    assert.equal(snapshot.confirmedCleanup.anchor.ino, anchorIno);
    assert.equal(snapshot.confirmedCleanup.parent.anchor.ino, s.parentAnchorIno);
    assert.deepEqual(bytes(f, location + '/original-maintenance/journal.json'), anchor);
    assert.equal(f.node(location + '/original-maintenance/journal.json').ino, anchorIno);
    assert.equal(f.removalInodes.length, snapshot.entries.length);
    assert.equal(new Set(f.removalInodes).size, f.removalInodes.length);
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
    for (const item of removalBefore) {
        const node = f.node(archive + item.path.slice(location.length));
        assert.equal(node.ino, item.ino);
        assert.equal(node.bytes.toString('base64'), item.bytes);
    }
    assert.notEqual(
        json(f, f.plan.root + '/' + installation.INSTALLATION_RECORD).installationId,
        oldId,
    );
    bothUnchanged(s, before);
    unchanged(f, source, f.plan.host.sourceRoot);
    assert.equal(f.fds.size, 0);
});

test('actual memory parent ledger bytes inode foreign entry and parent anchor cannot be substituted before second-seal removal', async () => {
    for (const mode of [
        'bytes',
        'ledger-inode',
        'foreign-entry',
        'parent-anchor',
        'consent-parent-inode',
    ]) {
        const s = await confirmed(),
            { f, ledger, parentLedger } = s;
        if (mode === 'bytes')
            f.node(parentLedger + '/original-journal.json').bytes = Buffer.from('changed');
        if (mode === 'ledger-inode') f.node(parentLedger).ino += 1000;
        if (mode === 'foreign-entry') f.file(parentLedger + '/foreign', 'foreign');
        if (mode === 'parent-anchor')
            f.file(ledger + '/original-completed-journal.json', s.parentAnchor, 0o600);
        let injected = 0;
        if (mode === 'consent-parent-inode')
            Object.defineProperty(f, 'reply', {
                configurable: true,
                get() {
                    injected++;
                    f.node(parentLedger).ino += 1000;
                    return { status: 'confirmed', menu: false };
                },
            });
        const rootBefore = inventory(f, f.plan.root),
            at = f.calls.length;
        stopped(await remove(f));
        assert.equal(injected, mode === 'consent-parent-inode' ? 1 : 0);
        assert.equal(f.calls.slice(at).some(mutates), false);
        unchanged(f, rootBefore, f.plan.root);
        assert.equal(f.nodes.has(f.work + '-uninstall'), false);
        assert.equal(
            bytes(f, s.profile).toString(),
            'profile retained across both seals and removal',
        );
    }
});

test('actual memory second-seal root maintenance and unlink lost acknowledgements resume without duplicate removal or closing old custody', async () => {
    for (const phase of ['root-move', 'maintenance-move', 'unlink']) {
        const s = await confirmed(),
            { f } = s,
            before = kept(s),
            location = f.work + '-uninstall';
        let injected = 0;
        if (phase !== 'unlink')
            f.afterCleanupMove = (from: string, to: string) => {
                if (
                    (phase === 'root-move' &&
                        from === f.plan.root &&
                        to === location + '/payload') ||
                    (phase === 'maintenance-move' &&
                        from === f.work &&
                        to === location + '/original-maintenance')
                ) {
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
        bothUnchanged(s, before);
        const oldFDs = f.fds.size;
        memoryRestart(f);
        const resumed = await remove(f),
            snapshot = json(f, location + '/snapshot.json');
        assert.equal(resumed.result.status, 'current-payload-removed');
        assert.equal(json(f, location + '/state.json').phase, 'complete');
        assert.deepEqual(bytes(f, location + '/original-maintenance/journal.json'), s.anchor);
        assert.equal(f.node(location + '/original-maintenance/journal.json').ino, s.anchorIno);
        bothUnchanged(s, before);
        assert.equal(f.removalInodes.length, snapshot.entries.length);
        assert.equal(new Set(f.removalInodes).size, f.removalInodes.length);
        assert.equal(f.fds.size, oldFDs);
        assert.equal(resumed.diagnostics.uninstall.reservation, 'none');
        assert.equal(
            failed.attempt.api.linuxPermanentSetupDiagnostics(failed.result.owner).uninstall
                .reservation,
            'held',
        );
    }
});

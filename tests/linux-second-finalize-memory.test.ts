/** Actual shipping lifecycle with MapFS/manual host ports only. No native load,
 * physical unlink, process, reservation, app, PTY or external observation occurs. */
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
    hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex'),
    baseURL = new URL('tests/linux-initial-finalize.test.ts', root),
    raw = readFileSync(baseURL, 'utf8');
assert.equal(hash(raw), 'a242d9290ad30d871fbc7388c1fae9496914479e40abacfc42915d69276e403c');
const tree = ts.createSourceFile('fixed-finalize-prefix.ts', raw, ts.ScriptTarget.ES2022, true),
    first = tree.statements.find(
        (node) =>
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'test',
    );
assert.ok(first);
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
const compiled = ts.transpileModule(
    prefix +
        '\nmodule.exports={seed,updated,candidate,start,boot,close,join,interruptedSeal,authoredSealRestart,readback,fixtures};',
    {
        fileName: 'fixed-finalize-prefix.ts',
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    },
);
assert.equal(
    (compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
        .length,
    0,
);
const module = { exports: {} as any };
// Preserve the existing aggregate and nested 1000 ms VM guards. Root dispatches
// this whole file serially; no host initializer, compiler cache or old registration.
new vm.Script(compiled.outputText, { filename: 'second-finalize-prefix.memory.cjs' }).runInContext(
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
const h = module.exports,
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
function preserved(f: any, prior: ReturnType<typeof inventory>, prefix: string) {
    assert.deepEqual(inventory(f, prefix), prior);
}
async function finish(f: any, action = 'finalize', retainedFDs = 0) {
    const a = f.run(action);
    try {
        await h.start(f, a);
        await h.boot(f, a);
        if (action === 'finalize') assert.equal(a.controller.summary().retainedConfirmed, true);
        h.close(f, a);
        const result = await a.operation;
        assert.equal(
            result.status,
            action === 'finalize' ? 'previous-generation-finalized' : 'launch',
        );
        assert.equal(result.result.wholeGroupRetirement, false);
        assert.equal(result.result.successorVerified, false);
        assert.equal(result.result.nativeQualified, false);
        assert.equal(f.fds.size, retainedFDs);
        await a.main.joinClosure();
        return result;
    } finally {
        await h.join(f, a);
    }
}
async function readyC() {
    const { f, originalA, originalB } = await h.updated(),
        txB = JSON.parse(originalB.toString()).transactionId,
        ledgerB = f.work + '-finalize-' + txB,
        profile = JSON.parse(originalB.toString()).profile + '/keep';
    f.file(profile, 'profile retained across A B C');
    await finish(f);
    const confirmedB = bytes(f, f.work + '/journal.json'),
        anchorB = f.node(f.work + '/journal.json').ino,
        parent = inventory(f, ledgerB);
    h.candidate(f, '0.8.0');
    assert.equal((await f.run('update').operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const originalC = bytes(f, f.work + '/journal.json'),
        journalC = JSON.parse(originalC.toString()),
        txC = journalC.transactionId,
        ledgerC = f.work + '-finalize-' + txC,
        previousB = f.work + '/previous-' + txC,
        rootC = f.node(f.plan.root).ino;
    assert.deepEqual(bytes(f, f.work + '/completed-journal.json'), confirmedB);
    assert.equal(f.node(f.work + '/completed-journal.json').ino, anchorB);
    return {
        f,
        originalA,
        originalB,
        originalC,
        confirmedB,
        anchorB,
        ledgerB,
        ledgerC,
        previousB,
        parent,
        profile,
        rootC,
    };
}
function originalRecords(s: Awaited<ReturnType<typeof readyC>>) {
    const {
        f,
        ledgerB,
        ledgerC,
        originalA,
        originalB,
        originalC,
        confirmedB,
        anchorB,
        parent,
        profile,
    } = s;
    preserved(f, parent, ledgerB);
    assert.deepEqual(bytes(f, ledgerB + '/original-completed-journal.json'), originalA);
    assert.deepEqual(bytes(f, ledgerB + '/original-journal.json'), originalB);
    assert.deepEqual(bytes(f, ledgerC + '/original-journal.json'), originalC);
    assert.deepEqual(bytes(f, ledgerC + '/original-completed-journal.json'), confirmedB);
    assert.equal(f.node(ledgerC + '/original-completed-journal.json').ino, anchorB);
    assert.equal(bytes(f, profile).toString(), 'profile retained across A B C');
}
/** Explicit memory-host restart precondition only. Original owner failure and FD
 * custody stay retained; no release, process control or retirement claim occurs. */
function restart(f: any) {
    h.authoredSealRestart(f);
    f.afterUnlink = undefined;
}
async function failedFinalize(f: any) {
    const outcome = await h.interruptedSeal(f);
    assert.equal(outcome.result.result.verdict, 'RETAINED_UNKNOWN');
    assert.equal(outcome.result.result.retainedConfirmed, false);
    return outcome;
}

test('actual memory second seal preserves A B C originals parent identities and profile, then supports relaunch D update and rollback while third seal stays closed', async () => {
    const s = await readyC(),
        { f, ledgerB, ledgerC, originalC, confirmedB, anchorB, rootC } = s;
    await finish(f);
    originalRecords(s);
    const snapshot = json(f, ledgerC + '/snapshot.json'),
        intent = json(f, ledgerC + '/seal-intent.json');
    assert.equal(
        snapshot.initial.history.cleanup.configuration.transactionId,
        JSON.parse(s.originalB.toString()).transactionId,
    );
    assert.equal(snapshot.parent.anchor.ino, anchorB);
    assert.equal(snapshot.parent.anchor.sha256, hash(confirmedB));
    assert.equal(snapshot.parent.entries.length, 8);
    assert.equal(json(f, ledgerC + '/state.json').phase, 'complete');
    assert.equal(f.node(f.plan.root).ino, rootC);
    assert.equal(f.nodes.has(s.previousB), false);
    assert.equal(f.node(f.work + '/journal.json').ino, intent.staged.ino);
    assert.deepEqual(bytes(f, ledgerC + '/unconfirmed-journal.json'), originalC);
    assert.equal(f.unlinkCalls.length, 12);
    const parentBefore = inventory(f, ledgerB),
        currentBefore = inventory(f, ledgerC);
    await finish(f, 'launch');
    const again = f.run('finalize');
    assert.equal((await again.operation).status, 'previous-generation-already-finalized');
    assert.equal(again.requests.length, 0);
    h.candidate(f, '0.9.0');
    assert.equal((await f.run('update').operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    const at = f.calls.length,
        blocked = f.run('finalize');
    assert.equal((await blocked.operation).status, 'retained-unknown');
    assert.equal(blocked.requests.length, 0);
    assert.equal(f.calls.slice(at).some(mutates), false);
    await finish(f, 'launch');
    assert.equal((await f.run('rollback').operation).result.verdict, 'ROLLED_BACK_RETAINED');
    assert.equal(f.node(f.plan.root).ino, rootC);
    preserved(f, parentBefore, ledgerB);
    preserved(f, currentBefore, ledgerC);
    originalRecords(s);
    // The reused completed slot must retain the actual C publication inode, not copied bytes.
    const completedFile = f.work + '/completed-journal.json',
        completedBytes = bytes(f, completedFile);
    assert.equal(
        JSON.parse(completedBytes.toString()).transactionId,
        snapshot.configuration.transactionId,
    );
    assert.equal(f.node(completedFile).ino, intent.staged.ino);
    assert.equal(f.node(ledgerC + '/original-completed-journal.json').ino, anchorB);
    assert.notEqual(intent.staged.ino, anchorB);
    f.file(completedFile, completedBytes, 0o600);
    const afterForeignAnchor = f.calls.length,
        priorFDs = f.fds.size,
        priorUnlinks = f.unlinkCalls.length,
        refused = f.run('launch');
    assert.equal((await refused.operation).status, 'retained-unknown');
    assert.equal(refused.requests.length, 0);
    assert.equal(f.calls.slice(afterForeignAnchor).some(mutates), false);
    assert.equal(f.unlinkCalls.length, priorUnlinks);
    assert.equal(f.node(f.plan.root).ino, rootC);
    assert.ok(f.fds.size >= priorFDs);
    preserved(f, parentBefore, ledgerB);
    preserved(f, currentBefore, ledgerC);
});

test('actual memory C refuses changed bound parent anchors foreign entry and oversized original before creating a cleanup cursor', async () => {
    for (const mode of [
        'retired-inode',
        'anchor-inode',
        'original-bytes',
        'foreign-entry',
        'oversized-original',
    ]) {
        const s = await readyC(),
            { f, ledgerB, ledgerC } = s;
        let oversizedReads = 0;
        if (mode === 'retired-inode')
            f.file(
                ledgerB + '/unconfirmed-journal.json',
                bytes(f, ledgerB + '/unconfirmed-journal.json'),
                0o600,
            );
        if (mode === 'anchor-inode')
            f.file(f.work + '/completed-journal.json', s.confirmedB, 0o600);
        if (mode === 'original-bytes')
            f.node(ledgerB + '/original-journal.json').bytes = Buffer.from('changed');
        if (mode === 'foreign-entry') f.file(ledgerB + '/foreign', 'foreign');
        if (mode === 'oversized-original') {
            const file = ledgerB + '/original-journal.json',
                read = f.ops.fs.readSync;
            f.node(file).bytes = Buffer.alloc(8193, 32);
            f.ops.fs.readSync = (fd: number, ...args: any[]) => {
                if (f.fds.get(fd).path === file) oversizedReads++;
                return read(fd, ...args);
            };
        }
        const rootBefore = inventory(f, f.plan.root),
            previousBefore = inventory(f, s.previousB),
            at = f.calls.length,
            a = f.run('finalize');
        assert.equal((await a.operation).status, 'retained-unknown');
        assert.equal(a.requests.length, 0);
        assert.equal(f.calls.slice(at).some(mutates), false);
        assert.equal(f.nodes.has(ledgerC), false);
        if (mode === 'oversized-original')
            assert.equal(
                oversizedReads,
                0,
                'Size refusal precedes reading the oversized original.',
            );
        preserved(f, rootBefore, f.plan.root);
        preserved(f, previousBefore, s.previousB);
    }
});

test('actual memory admitted C stops after one member on parent source or owned-process birth change', async () => {
    for (const mode of ['parent', 'parent-inode', 'source', 'birth']) {
        const s = await readyC(),
            { f, ledgerB, ledgerC } = s,
            a = f.run('finalize');
        let injected = 0;
        f.afterUnlink = () => {
            if (injected) return;
            injected++;
            if (mode === 'parent')
                f.node(ledgerB + '/unconfirmed-journal.json').bytes = Buffer.from('changed parent');
            if (mode === 'parent-inode') f.node(ledgerB).ino += 1000;
            if (mode === 'source')
                f.node(f.plan.host.sourceRoot + '/app/diagnostic-hub').bytes =
                    Buffer.from('changed source');
            if (mode === 'birth')
                f.node('/proc/888/stat').bytes = Buffer.from(
                    h.fixtures.procStat(888, '10002').replace(' S 0 ', ' S 777 '),
                );
        };
        try {
            await h.start(f, a);
            const refresh = f.readyIO(a),
                record = await refresh();
            assert.ok(record);
            a.main = h.readback.createLinuxMainReadback(a.pair.child);
            a.main.offer(record, refresh);
            await a.pair.pump(() => a.settled);
            const result = await a.operation;
            assert.equal(injected, 1);
            assert.equal(result.status, 'retained-unknown');
            assert.equal(result.result.retainedConfirmed, false);
            assert.equal(f.unlinkCalls.length, 7);
            assert.equal(json(f, ledgerC + '/state.json').leaf, 'unlink-issued');
            assert.deepEqual(bytes(f, f.work + '/journal.json'), s.originalC);
            assert.deepEqual(bytes(f, f.work + '/completed-journal.json'), s.confirmedB);
            h.close(f, a);
        } finally {
            await h.join(f, a);
        }
    }
});

test('actual memory C refuses active unknown predecessor and missing unlink authority before a new app or mutation', async () => {
    for (const mode of ['active', 'unknown', 'capability']) {
        const s = await readyC(),
            { f, ledgerC } = s;
        if (mode === 'capability') f.ops.unlinkOwned = null;
        else {
            f.directory('/proc/999', 1000);
            f.file(
                '/proc/999/stat',
                h.fixtures.procStat(999, '20001').replace(' S 0 ', ' S 777 '),
                0o444,
            ).proc = true;
            if (mode === 'active') {
                const exe = f.file('/proc/999/exe', '', 0o777);
                exe.kind = 'link';
                exe.target = s.previousB + '/app/diagnostic-hub';
            }
        }
        const at = f.calls.length,
            a = f.run('finalize');
        assert.equal((await a.operation).status, 'retained-unknown');
        assert.equal(a.requests.length, 0);
        assert.equal(f.calls.slice(at).some(mutates), false);
        assert.equal(f.nodes.has(ledgerC), false);
        assert.equal(f.unlinkCalls.length, 6);
        preserved(f, s.parent, s.ledgerB);
    }
});

test('actual memory C stale initial startup cannot admit cleanup despite a complete published parent', async () => {
    const s = await readyC(),
        { f, ledgerC } = s,
        a = f.run('finalize');
    try {
        await h.start(f, a);
        const refresh = f.readyIO(a),
            record = await refresh();
        assert.ok(record);
        record.observedAtMs -= 3000;
        a.main = h.readback.createLinuxMainReadback(a.pair.child);
        a.main.offer(record, async () => record);
        await a.pair.pump();
        for (const expire of Array.from(f.timers.values()) as (() => void)[]) expire();
        assert.equal((await a.operation).status, 'retained-unknown');
        assert.equal(f.nodes.has(ledgerC), false);
        assert.equal(f.unlinkCalls.length, 6);
        preserved(f, s.parent, s.ledgerB);
        assert.deepEqual(bytes(f, f.work + '/journal.json'), s.originalC);
        h.close(f, a);
    } finally {
        await h.join(f, a);
    }
});

test('actual memory C issued previous move unlink or cursor-sync recovery never removes a retired member twice', async () => {
    for (const mode of ['previous-move', 'unlink', 'cursor-sync']) {
        const s = await readyC(),
            { f, ledgerC } = s,
            retired: number[] = [];
        let injected = 0;
        f.beforeUnlink = (file: string) => {
            retired.push(f.node(file).ino);
        };
        if (mode === 'previous-move')
            f.afterCleanupMove = (from: string, to: string) => {
                if (from === s.previousB && to === ledgerC + '/payload') {
                    injected++;
                    throw undefined;
                }
            };
        if (mode === 'unlink')
            f.afterUnlink = () => {
                if (!injected) {
                    injected++;
                    throw undefined;
                }
            };
        const sync = f.ops.fs.fsyncSync;
        if (mode === 'cursor-sync')
            f.ops.fs.fsyncSync = (fd: number) => {
                const answer = sync(fd),
                    file = f.fds.get(fd).path;
                if (!injected && file === ledgerC + '/state.json') {
                    const state = json(f, file);
                    if (
                        state.phase === 'deleting' &&
                        state.index === 1 &&
                        state.leaf === 'source'
                    ) {
                        injected++;
                        throw undefined;
                    }
                }
                return answer;
            };
        await failedFinalize(f);
        assert.equal(injected, 1);
        assert.equal(f.unlinkCalls.length, mode === 'previous-move' ? 6 : 7);
        const failedState = json(f, ledgerC + '/state.json');
        if (mode === 'previous-move') assert.equal(failedState.phase, 'previous-issued');
        if (mode === 'unlink') assert.equal(failedState.leaf, 'unlink-issued');
        if (mode === 'cursor-sync') {
            assert.equal(failedState.index, 1);
            assert.equal(failedState.leaf, 'source');
        }
        const oldFDs = f.fds.size;
        restart(f);
        f.ops.fs.fsyncSync = sync;
        await finish(f, 'finalize', oldFDs);
        assert.equal(f.unlinkCalls.length, 12);
        assert.equal(retired.length, 6);
        assert.equal(new Set(retired).size, 6);
        assert.equal(
            f.fds.size,
            oldFDs,
            'Fresh recovery does not close old failed-owner MapFS descriptors.',
        );
        originalRecords(s);
    }
});

test('actual memory C lost baseline-anchor move ACK resumes its exact B inode without repeating predecessor removal', async () => {
    const s = await readyC(),
        { f, ledgerC } = s;
    let injected = 0;
    f.afterCleanupMove = (from: string, to: string) => {
        if (
            from === f.work + '/completed-journal.json' &&
            to === ledgerC + '/original-completed-journal.json'
        ) {
            injected++;
            throw undefined;
        }
    };
    await failedFinalize(f);
    assert.equal(injected, 1);
    assert.equal(f.unlinkCalls.length, 12);
    assert.equal(f.nodes.has(f.work + '/completed-journal.json'), false);
    assert.equal(f.node(ledgerC + '/original-completed-journal.json').ino, s.anchorB);
    const oldFDs = f.fds.size;
    restart(f);
    await finish(f, 'finalize', oldFDs);
    assert.equal(f.unlinkCalls.length, 12);
    originalRecords(s);
});

test('actual memory C pinned stage or lost seal-rename ACK recovers without a new app or changed B parent', async () => {
    for (const mode of ['stage-prefix', 'retire-ack', 'publish-ack']) {
        const s = await readyC(),
            { f, ledgerC } = s,
            write = f.ops.fs.writeSync;
        let injected = 0,
            retiredMoves = 0,
            publishedMoves = 0;
        if (mode === 'stage-prefix')
            f.ops.fs.writeSync = (
                fd: number,
                buffer: Buffer,
                offset: number,
                length: number,
                position: number,
            ) => {
                if (f.fds.get(fd).path !== ledgerC + '/confirmed-journal.json')
                    return write(fd, buffer, offset, length, position);
                const count = write(
                    fd,
                    buffer,
                    offset,
                    Math.min(length, s.originalC.length - position),
                    position,
                );
                if (!injected && position + count === s.originalC.length) {
                    injected++;
                    throw undefined;
                }
                return count;
            };
        f.afterCleanupMove = (from: string, to: string) => {
            const retire =
                    from === f.work + '/journal.json' &&
                    to === ledgerC + '/unconfirmed-journal.json',
                publish =
                    from === ledgerC + '/confirmed-journal.json' && to === f.work + '/journal.json';
            if (retire) retiredMoves++;
            if (publish) publishedMoves++;
            if (
                !injected &&
                ((mode === 'retire-ack' && retire) || (mode === 'publish-ack' && publish))
            ) {
                injected++;
                throw undefined;
            }
        };
        await failedFinalize(f);
        assert.equal(injected, 1);
        assert.equal(f.unlinkCalls.length, 12);
        if (mode === 'stage-prefix') {
            const confirmed = Buffer.from(
                JSON.stringify({
                    ...JSON.parse(s.originalC.toString()),
                    phase: 'candidate-confirmed',
                }),
            );
            assert.deepEqual(
                bytes(f, ledgerC + '/confirmed-journal.json'),
                confirmed.subarray(0, s.originalC.length),
            );
            assert.deepEqual(bytes(f, f.work + '/journal.json'), s.originalC);
        }
        restart(f);
        f.ops.fs.writeSync = write;
        f.afterCleanupMove = (from: string, to: string) => {
            if (from === f.work + '/journal.json' && to === ledgerC + '/unconfirmed-journal.json')
                retiredMoves++;
            if (from === ledgerC + '/confirmed-journal.json' && to === f.work + '/journal.json')
                publishedMoves++;
        };
        const recovery = f.run('finalize'),
            result = await recovery.operation;
        assert.equal(recovery.requests.length, 0);
        if (mode === 'publish-ack') {
            assert.equal(result.status, 'previous-generation-already-finalized');
            assert.equal(result.result, undefined);
        } else {
            assert.equal(result.status, 'previous-generation-seal-recovered');
            assert.equal(result.result.verdict, 'SEAL_RECOVERED_NO_LAUNCH');
            assert.equal(result.result.spawned, false);
            assert.equal(result.result.childOwned, false);
        }
        assert.equal(retiredMoves, 1);
        assert.equal(publishedMoves, 1);
        assert.equal(f.unlinkCalls.length, 12);
        originalRecords(s);
    }
});

test('actual memory menu and physical retained-lineage cases remain outside the bounded second-seal operation', async () => {
    const selected = await h.seed(true);
    h.candidate(selected, '0.7.0');
    assert.equal(
        (await selected.run('update').operation).result.verdict,
        'ACTIVE_PREVIOUS_RETAINED',
    );
    let at = selected.calls.length;
    const menuAttempt = selected.run('finalize');
    assert.equal((await menuAttempt.operation).status, 'retained-unknown');
    assert.equal(menuAttempt.requests.length, 0);
    assert.equal(selected.calls.slice(at).some(mutates), false);
    const s = await readyC(),
        { f } = s;
    h.candidate(f, '0.9.0');
    assert.equal((await f.run('update').operation).result.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    at = f.calls.length;
    const physicalLineage = f.run('finalize');
    assert.equal((await physicalLineage.operation).status, 'retained-unknown');
    assert.equal(physicalLineage.requests.length, 0);
    assert.equal(f.calls.slice(at).some(mutates), false);
    preserved(f, s.parent, s.ledgerB);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createQueryContractEvidence } from '../scripts/lib/query-contract-failure-evidence.mjs';
import {
    runSecurityCommand,
    firstCollectorSecurityQuery,
} from '../scripts/lib/pilot-security-command.mjs';
import { QueryLifecycle } from '../scripts/lib/security-query-diagnostic.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const root = path.resolve(import.meta.dirname, '..');
const raw = JSON.stringify([{ path: root, kind: 'directory' }]);
function harness() {
    const events = [],
        holds = [],
        file = {
            bytes: Buffer.alloc(0),
            named: 1,
            fd: 1,
            link: 1,
            namedLink: 1,
            owner: process.getuid?.() ?? 0,
            symlink: false,
            writeFail: false,
            syncFail: false,
            closeFail: false,
            closed: false,
            writes: 0,
            syncs: 0,
        };
    const stat = (named) => ({
        dev: 1n,
        ino: BigInt(named ? file.named : file.fd),
        uid: BigInt(file.owner),
        nlink: BigInt(named ? file.namedLink : file.link),
        size: BigInt(file.bytes.length),
        isFile: () => true,
        isSymbolicLink: () => named && file.symlink,
    });
    const io = {
        openSync: () => 91,
        fstatSync: () => {
            assert(!file.closed);
            return stat(false);
        },
        lstatSync: () => stat(true),
        writeSync(_fd, b, offset, length) {
            file.writes++;
            if (file.writeFail) throw Error('injected write failure');
            file.bytes = Buffer.concat([file.bytes, b.subarray(offset, offset + length)]);
            file.afterWrite?.();
            return length;
        },
        fsyncSync() {
            file.syncs++;
            file.afterSync?.();
            if (file.syncFail) throw Error('injected sync failure');
        },
        closeSync() {
            if (file.closeFail) throw Error('injected close failure');
            file.closed = true;
        },
    };
    let time = 0,
        identityOK = true,
        budget = Infinity,
        rowsLeft = Infinity;
    const life = new QueryLifecycle(0, { now: () => time });
    const hold = (state) => {
        holds.push(state);
        life.held = true;
        life.cancel('Custody held');
        events.push('hold');
    };
    const ledger = createQueryContractEvidence('/injected-contract', {
        io,
        check: () => {
            assert(identityOK, 'identity');
            life.check();
        },
        failureCheck: () => {
            assert(life.held && life.cancelled);
            assert(identityOK, 'identity');
            assert(!life.workClosed && life.tick() < life.workDeadline, 'owner deadline');
            events.push('failure-check');
        },
        admit: (n) => {
            assert(n <= budget, 'budget');
            if (n) assert(rowsLeft-- > 0, 'row budget');
        },
        hold,
    });
    const record = (stage, data) => {
        events.push(stage);
        ledger.append(stage, { case: 'one-directory', ...data });
    };
    const bind = () => {
        life.admit('contract');
        return ledger.bindCommand({
            record,
            check: () => assert(time < 150000, 'contract deadline'),
            onProcessState: (state) => {
                events.push('classified');
                if (!state.closed) hold({ phase: 'contract-query-unknown', state });
            },
        });
    };
    const execute = (reply, { diagnostic = false, spawnHook = () => {}, clock = () => 5 } = {}) => {
        const run = bind();
        const command = diagnostic
            ? firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true, clock })
            : runSecurityCommand;
        return run((callbacks) =>
            command(root, '/injected-powershell', raw, {
                ...callbacks,
                environment: {},
                check: () => assert(time < 150000),
                identity: (p) => ({ path: p, pe: { architecture: 'x64' } }),
                spawn: () => {
                    events.push('spawn');
                    spawnHook();
                    if (reply instanceof Error) throw reply;
                    return reply;
                },
            }),
        );
    };
    return {
        ledger,
        events,
        holds,
        life,
        file,
        bind,
        execute,
        record,
        rows: () =>
            file.bytes
                .toString()
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((s) => JSON.parse(s)),
        time: (n) => {
            time = n;
        },
        identity: (ok) => {
            identityOK = ok;
        },
        budget: (n) => {
            budget = n;
        },
        rowsLeft: (n) => {
            rowsLeft = n;
        },
    };
}
const unknown = (stdout = '', stderr = '') => ({
    stdout,
    stderr,
    status: null,
    signal: 'SIGTERM',
    error: Error('injected unknown'),
    pid: 42,
});
const state = {
    attempted: true,
    closed: false,
    status: null,
    signal: 'SIGTERM',
    errorPresent: true,
};
const input = { json: raw };
const fragment = (text, offset = 0) => ({
    stream: 'stdout',
    offset,
    bytes: Buffer.byteLength(text),
    base64: Buffer.from(text).toString('base64'),
});
const result = (stdout = '') => ({
    status: null,
    signal: 'SIGTERM',
    error: 'injected',
    streams: Object.fromEntries(
        ['stdout', 'stderr'].map((name) => {
            const b = Buffer.from(name === 'stdout' ? stdout : '');
            return [
                name,
                { bytes: b.length, retainedBytes: b.length, truncated: false, sha256: sha(b) },
            ];
        }),
    ),
});

for (const [name, out, err] of [
    ['nonempty', 'raw λ\n', 'fixed stderr\r\n'],
    ['empty', '', ''],
    ['max streams', 'x'.repeat(65536), 'y'.repeat(65536)],
])
    test(`custody-first bounded failure snapshot: ${name}`, () => {
        const h = harness();
        assert.throws(() => h.execute(unknown(out, err)), /Unknown contract custody/);
        const rows = h.rows(),
            final = rows.at(-1);
        assert.equal(final.stage, 'security-command-closed');
        assert(
            h.events.indexOf('hold') <
                h.events.indexOf(out || err ? 'security-output' : 'security-command-closed'),
        );
        assert.deepEqual(h.holds[0].state, state);
        for (const stream of ['stdout', 'stderr']) {
            const b = Buffer.concat(
                rows
                    .filter((r) => r.stage === 'security-output' && r.data.stream === stream)
                    .map((r) => Buffer.from(r.data.base64, 'base64')),
            );
            assert.equal(b.toString(), stream === 'stdout' ? out : err);
            assert.equal(final.data.streams[stream].sha256, sha(b));
        }
        assert.equal(h.file.writes, h.file.syncs);
        assert(h.life.held && h.life.cancelled);
        assert.equal(h.life.counts.contract, 1);
        assert.throws(() => h.bind());
        assert.throws(() => h.ledger.append('ordinary', {}));
        assert.throws(() => h.ledger.close());
        assert.throws(() =>
            h.life.proof({
                logsClosed: true,
                receiptClosed: true,
                inputsUnchanged: true,
                evidenceClosed: true,
            }),
        );
    });
test('thrown launch and missing PID retain actual classification without fabricated PID', () => {
    const h = harness();
    assert.throws(() => h.execute(Error('injected launch refused')));
    assert.deepEqual(h.holds[0].state, {
        attempted: true,
        closed: false,
        status: null,
        signal: null,
        errorPresent: true,
    });
    const final = h.rows().at(-1).data;
    assert.equal(final.status, null);
    assert.equal(final.signal, null);
    assert(!Object.hasOwn(final, 'diagnostic'));
});
test('diagnostic partial witness bytes preserved undecoded; clock failure does not erase capture', () => {
    const h = harness();
    let count = 0;
    assert.throws(() =>
        h.execute(unknown('incomplete witness\n', 'entry\n'), {
            diagnostic: true,
            clock: () => {
                if (++count === 3) throw Error('clock');
                return count;
            },
        }),
    );
    const final = h.rows().at(-1).data;
    assert.equal(final.diagnostic.returnedPID, 42);
    assert.equal(final.diagnostic.actualExitOrPipeCloseObserved, false);
    assert.equal(final.diagnostic.clockComplete, false);
    assert.equal(final.streams.stdout.sha256, sha('incomplete witness\n'));
});
for (const [name, change] of [
    [
        'writer throw',
        (h) => {
            h.file.writeFail = true;
        },
    ],
    [
        'sync throw',
        (h) => {
            h.file.syncFail = true;
        },
    ],
    ['byte budget', (h) => h.budget(0)],
    ['row budget', (h) => h.rowsLeft(0)],
    ['owner deadline', (h) => h.time(540000)],
    ['contract deadline', (h) => h.time(150000)],
    ['closed work', (h) => h.life.closeWork()],
    ['owner identity', (h) => h.identity(false)],
    [
        'named inode',
        (h) => {
            h.file.named = 2;
        },
    ],
    [
        'descriptor inode',
        (h) => {
            h.file.fd = 2;
        },
    ],
    [
        'hardlink',
        (h) => {
            h.file.namedLink = 2;
        },
    ],
    [
        'symlink',
        (h) => {
            h.file.symlink = true;
        },
    ],
    [
        'wrong owner',
        (h) => {
            h.file.owner++;
        },
    ],
    [
        'unexpected ledger bytes',
        (h) => {
            h.file.bytes = Buffer.concat([h.file.bytes, Buffer.from('altered')]);
        },
    ],
])
    test(`failure persistence refuses ${name} without release or retry`, () => {
        const h = harness();
        assert.throws(() => h.execute(unknown('raw'), { spawnHook: () => change(h) }));
        assert(h.life.held && h.life.cancelled);
        assert(!h.file.bytes.toString().includes('"stage":"security-command-closed"'));
        const writes = h.file.writes;
        assert.throws(() => h.ledger.append('retry', {}));
        assert.equal(h.file.writes, writes);
        assert.throws(() => h.bind());
        assert.throws(() => h.ledger.close());
    });
test('successful/default command behavior and original ledger closure remain', () => {
    const h = harness();
    const r = h.execute({ stdout: 'original report', stderr: '', status: 0, signal: null });
    assert.equal(r.stdout, 'original report');
    assert(!Object.hasOwn(r.result, 'diagnostic'));
    assert.equal(h.holds.length, 0);
    assert.equal(h.rows().at(-1).data.status, 0);
    h.ledger.append('original-next-contract-record', {});
    assert.equal(h.ledger.close().complete, true);
});
test('close failure remains incomplete and is never retried', () => {
    const h = harness();
    h.execute({ stdout: '', stderr: '', status: 0, signal: null });
    h.file.closeFail = true;
    const result = h.ledger.close();
    assert.equal(result.complete, false);
    assert(h.life.held);
    assert.throws(() => h.bind());
});
test('reused invocation and expired callbacks cannot write or classify again', () => {
    const h = harness();
    const run = h.bind();
    let saved;
    assert.throws(() =>
        run((c) => {
            saved = c;
            c.record('security-input', input);
            c.onProcessState(state);
            c.record('security-command-closed', result());
        }),
    );
    const bytes = h.file.bytes.length;
    assert.throws(() => run(() => {}));
    assert.throws(() => saved.record('security-command-closed', result()));
    assert.throws(() => saved.onProcessState(state));
    assert.equal(h.file.bytes.length, bytes);
});
test('a second unconsumed capability is refused', () => {
    const h = harness();
    h.bind();
    assert.throws(() => h.bind());
});
for (const [name, mutate] of [
    ['wrong stage', (c) => c.record('contract-case-passed', {})],
    ['offset', (c) => c.record('security-output', fragment('a', 1))],
    ['invalid base64', (c) => c.record('security-output', { ...fragment('a'), base64: '??' })],
    ['oversized fragment', (c) => c.record('security-output', fragment('x'.repeat(24577)))],
    ['raw digest mismatch', (c) => c.record('security-command-closed', result('unretained'))],
    [
        'state/result mismatch',
        (c) => c.record('security-command-closed', { ...result(), status: 0 }),
    ],
    [
        'unknown result key',
        (c) => c.record('security-command-closed', { ...result(), arbitrary: 'no' }),
    ],
    [
        'duplicate outcome',
        (c) => {
            c.record('security-command-closed', result());
            c.record('security-command-closed', result());
        },
    ],
    ['duplicate state', (c) => c.onProcessState(state)],
])
    test(`command-bound channel rejects ${name}`, () => {
        const h = harness();
        const run = h.bind();
        assert.throws(() =>
            run((c) => {
                c.record('security-input', input);
                c.onProcessState(state);
                mutate(c);
            }),
        );
        assert(h.life.held);
        assert.throws(() => h.ledger.close());
    });
test('runtime wiring preserves immediate classified hold, identity/time/accounting checks and source gates', () => {
    const text = fs.readFileSync(
        path.join(root, 'scripts/lib/security-query-diagnostic-runtime.mjs'),
        'utf8',
    );
    assert(text.includes("retain({ phase: 'contract-query-unknown', state })"));
    for (const anchor of [
        'contractEvidence.bindCommand',
        "life.admit('contract')",
        'opts.onProcessState?.(state)',
        'context.check();',
        'checkTree();',
        'requireQueryJobAdmission(jobTime.admission',
        'life.workDeadline',
        'identity(node.path)',
        'identity(powershell, { pe: true })',
        'identity(provider.path)',
        'accounting.scan();',
        'life.contract(contract);',
    ])
        assert(text.includes(anchor));
    assert(text.indexOf('life.contract(contract);') < text.indexOf("life.admit('node')"));
});

for (const kind of ['cancelled', 'held-and-cancelled'])
    test(`already ${kind} command preserves failure-only capture`, () => {
        const h = harness();
        assert.throws(() =>
            h.execute(unknown('raw'), {
                spawnHook: () => {
                    h.life.cancel('injected cancellation');
                    if (kind === 'held-and-cancelled') h.life.held = true;
                },
            }),
        );
        assert.equal(h.rows().at(-1).stage, 'security-command-closed');
        assert(h.life.held);
        assert.throws(() => h.bind());
    });
test('cancellation never authorizes successful ordinary completion writes', () => {
    const h = harness();
    assert.throws(() =>
        h.execute(
            { status: 0, signal: null, stdout: 'report', stderr: '' },
            { spawnHook: () => h.life.cancel('injected') },
        ),
    );
    assert(h.life.held);
    assert(!h.file.bytes.toString().includes('"stage":"security-command-closed"'));
});
test('known negative status remains a normal closed command', () => {
    const h = harness();
    const r = h.execute({ status: 1, signal: null, stdout: 'expected negative', stderr: '' });
    assert.equal(r.result.status, 1);
    assert.equal(h.holds.length, 0);
    assert.equal(h.ledger.close().complete, true);
});

for (const [name, hook] of [
    [
        'inode changes during append',
        (h) => {
            h.file.afterWrite = () => {
                h.file.named = 2;
            };
        },
    ],
    [
        'deadline reached during sync',
        (h) => {
            h.file.afterSync = () => h.time(150000);
        },
    ],
])
    test(`partial evidence stays held when ${name}`, () => {
        const h = harness();
        assert.throws(() => h.execute(unknown('raw'), { spawnHook: () => hook(h) }));
        assert(h.life.held);
        assert(!h.file.bytes.toString().includes('"stage":"security-command-closed"'));
        assert.throws(() => h.bind());
    });
test('invocation throwing without process state retains uncertainty without fabricated classification', () => {
    const h = harness();
    const run = h.bind();
    assert.throws(() =>
        run((c) => {
            c.record('security-input', input);
            throw Error('injected abrupt command');
        }),
    );
    assert(h.life.held);
    assert(!h.holds.some((v) => Object.hasOwn(v, 'state')));
    assert.throws(() => h.bind());
});
test('completion missing after known closed state cannot retire evidence or authorize later admission', () => {
    const h = harness();
    const run = h.bind();
    assert.throws(() =>
        run((c) => {
            c.record('security-input', input);
            c.onProcessState({
                attempted: true,
                closed: true,
                status: 0,
                signal: null,
                errorPresent: false,
            });
        }),
    );
    assert(h.life.held);
    assert.throws(() => h.bind());
    assert.throws(() => h.ledger.close());
});

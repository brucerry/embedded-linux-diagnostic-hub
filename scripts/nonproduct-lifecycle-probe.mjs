/** Nonproduct probe. Importing this module never launches anything. Real execution remains opt-in. */
import assert from 'node:assert/strict';
import fs, { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { observeOwnedChild, requireObservedClosure } from './lib/owned-child.mjs';

export const probeLimits = Object.freeze({
    totalMs: 8000,
    reserveMs: 1000,
    bytes: 16384,
    records: 32,
    reservations: Object.freeze([4096, 2048, 256, 256, 512, 1024, 1024]),
});
export function validatePeerAck(message, nonce, role, seq) {
    assert.deepEqual(Object.keys(message).sort(), ['kind', 'nonce', 'role', 'seq']);
    assert.equal(message.kind, 'ack');
    assert.equal(message.nonce, nonce);
    assert.equal(message.role, role);
    assert.equal(message.seq, seq);
}
export function validateProbeClient(owner, yielded, resumed) {
    assert.equal(owner.status, 'OWNER_COMPLETE_PENDING_CLIENT');
    assert.equal(owner.ownerVerdict, 'PASS_NARROW');
    assert.ok(
        owner.markerReleased &&
            owner.journalClosed &&
            owner.journalDurable &&
            owner.closureReceiptClosed &&
            !owner.failure,
    );
    assert.ok(Number.isSafeInteger(owner.ownerPID) && owner.ownerPID > 0);
    assert.equal(owner.outcomes.length, 2);
    for (const row of owner.outcomes) {
        requireObservedClosure(row);
        assert.equal(row.code, 0);
    }
    assert.deepEqual(owner.sequences, { work: 5, observer: 2 });
    for (const record of [yielded, resumed]) {
        assert.equal(record.nonce, owner.nonce);
        assert.equal(record.ownerPID, owner.ownerPID);
        assert.ok(record.sessionId && typeof record.sessionId === 'string');
    }
    assert.equal(yielded.phase, 'yield');
    assert.equal(yielded.state, 'running');
    assert.equal(yielded.exitCode, null);
    assert.equal(resumed.phase, 'resume');
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.exitCode, 0);
    assert.equal(yielded.sessionId, resumed.sessionId);
    return {
        status: 'PASS_NARROW',
        nonce: owner.nonce,
        sessionId: yielded.sessionId,
        scope: 'Supported yielded-session completion retrieval and dummy observer separation; live-resume overlap/outage survival not established.',
    };
}
/** Only for failures before any spawn admission. Unknown runtime ownership never uses this path. */
export function cleanupUnstartedProbe(journal, lease) {
    const errors = [];
    if (journal && !journal.closed) {
        try {
            journal.close();
        } catch (error) {
            errors.push(String(error));
        }
    }
    let markerReleased = false;
    if (!journal || journal.closed) {
        try {
            lease.release();
            markerReleased = true;
        } catch (error) {
            errors.push(String(error));
        }
    }
    return { journalClosed: !journal || journal.closed, markerReleased, errors };
}
export class EvidenceBudget {
    bytes = 0;
    records = 0;
    reserve(bytes) {
        assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid evidence reservation.');
        assert.ok(
            this.records + 1 <= probeLimits.records && this.bytes + bytes <= probeLimits.bytes,
            'Probe evidence budget exceeded.',
        );
        this.records++;
        this.bytes += bytes;
    }
}
/** Short-write-safe synchronous bounded journal; flush and closure are explicit acknowledgements. */
export class ProbeJournal {
    closed = false;
    failed = false;
    constructor(io, budget) {
        this.io = io;
        this.budget = budget;
    }
    append(event, data) {
        assert.ok(!this.closed && !this.failed, 'Journal unavailable.');
        const bytes = Buffer.from(JSON.stringify({ event, data }) + '\n');
        try {
            this.budget.reserve(bytes.length);
            let offset = 0;
            while (offset < bytes.length) {
                const written = this.io.write(bytes, offset, bytes.length - offset);
                assert.ok(
                    Number.isSafeInteger(written) &&
                        written > 0 &&
                        written <= bytes.length - offset,
                    'Journal write made invalid progress.',
                );
                offset += written;
            }
            this.io.sync();
        } catch (error) {
            this.failed = true;
            throw error;
        }
    }
    close() {
        assert.equal(this.closed, false);
        try {
            this.io.sync();
        } catch (error) {
            this.failed = true;
            throw error;
        } finally {
            try {
                this.io.close();
                this.closed = true;
            } catch (error) {
                this.failed = true;
                throw error;
            }
        }
    }
}

/** Injectable transport/clock tests exercise the same owner without creating dummy processes. */
export async function runProbeOwner({
    spawnChild,
    clock,
    journal,
    lease,
    commitClosure,
    nonce,
    inputs,
    started = clock.now(),
}) {
    const deadline = started + probeLimits.totalMs;
    const roles = ['work', 'observer'],
        watchers = [],
        pending = new Set(),
        sequences = { work: 0, observer: 0 };
    let failure = null,
        observerDisconnectedAt = null,
        workExitedAt = null,
        spawnUncertain = false;
    const fail = (error) => {
        failure ??= String(error).slice(0, 512);
        for (const owned of watchers) owned.abort(failure);
    };
    const append = (event, data) => {
        try {
            journal.append(event, data);
        } catch (error) {
            fail(error);
            throw error;
        }
    };
    const sendAck = (child, role, seq) =>
        new Promise((resolve, reject) => {
            const timer = clock.set(
                () => reject(Error('IPC acknowledgement deadline.')),
                Math.max(0, deadline - clock.now()),
            );
            try {
                child.send({ kind: 'ack', nonce, role, seq }, (error) => {
                    clock.clear(timer);
                    if (error) reject(error);
                    else resolve();
                });
            } catch (error) {
                clock.clear(timer);
                reject(error);
            }
        });
    let outcomes = [];
    try {
        append('inputs', { nonce, ...inputs });
        assert.ok(
            deadline - clock.now() > probeLimits.reserveMs,
            'Probe setup exhausted its work budget.',
        );
        for (const role of roles) {
            let child;
            try {
                child = spawnChild(role, nonce);
            } catch (error) {
                // detached:false is mandatory in the real port.
                spawnUncertain = true;
                throw error;
            }
            const owned = observeOwnedChild(child, {
                totalMs: Math.max(0, deadline - clock.now()),
                reserveMs: probeLimits.reserveMs,
                clock,
                onEvent: (event, row) => {
                    if (role === 'work' && event === 'exit') workExitedAt = clock.now();
                    append(event, { role, ...row });
                },
            });
            watchers.push(owned);
            assert.ok(
                Number.isSafeInteger(child.pid) && child.pid > 0,
                'Missing directly owned PID.',
            );
            child.on('message', (message) => {
                const task = (async () => {
                    assert.deepEqual(Object.keys(message).sort(), [
                        'kind',
                        'nonce',
                        'pid',
                        'role',
                        'seq',
                    ]);
                    assert.equal(message.nonce, nonce);
                    assert.equal(message.role, role);
                    assert.equal(message.pid, child.pid);
                    const expected =
                        role === 'work'
                            ? ['ready', 'progress', 'progress', 'progress', 'done']
                            : ['ready', 'unsubscribe'];
                    assert.equal(message.seq, sequences[role]);
                    assert.equal(message.kind, expected[message.seq]);
                    sequences[role]++;
                    await sendAck(child, role, message.seq);
                    append('message-acknowledged', message);
                })().catch(fail);
                pending.add(task);
                void task.finally(() => pending.delete(task));
            });
            child.once('disconnect', () => {
                if (role === 'observer') observerDisconnectedAt = clock.now();
                try {
                    append('disconnect', { role, sequenceCount: sequences[role] });
                } catch {}
            });
            // Bound all output in the same budget; normal peers produce none.
            child.stderr?.on('data', (bytes) => {
                try {
                    append('peer-stderr', { role, text: bytes.toString() });
                } catch {}
            });
        }
    } catch (error) {
        fail(error);
    }
    outcomes = await Promise.all(watchers.map((w) => w.outcome));
    await Promise.allSettled([...pending]); // Every send has the same absolute deadline.
    let valid = !failure && outcomes.length === 2;
    try {
        for (const row of outcomes) {
            requireObservedClosure(row);
            assert.equal(row.code, 0);
        }
        assert.deepEqual(sequences, { work: 5, observer: 2 });
        assert.ok(
            observerDisconnectedAt !== null &&
                workExitedAt !== null &&
                observerDisconnectedAt < workExitedAt,
        );
        assert.ok(clock.now() - started < probeLimits.totalMs, 'Owner total deadline exceeded.');
    } catch (error) {
        failure ??= String(error).slice(0, 512);
        valid = false;
    }
    try {
        append('owner-outcomes', { valid, failure, sequences });
    } catch {
        valid = false;
    }
    try {
        journal.close();
    } catch (error) {
        failure ??= String(error).slice(0, 512);
        valid = false;
    }
    let certain =
        !spawnUncertain &&
        outcomes.length === watchers.length &&
        outcomes.every((r) => r.closeObserved) &&
        journal.closed;
    let closureReceiptClosed = false;
    if (certain) {
        try {
            assert.equal(
                commitClosure({
                    nonce,
                    outcomes,
                    sequences,
                    valid,
                    failure,
                    journalClosed: journal.closed,
                    journalDurable: !journal.failed,
                }),
                true,
            );
            closureReceiptClosed = true;
        } catch (error) {
            failure ??= String(error).slice(0, 512);
            valid = false;
            certain = false;
        }
    }
    let released = false;
    if (certain) {
        try {
            lease.release();
            released = true;
        } catch (error) {
            failure ??= String(error).slice(0, 512);
            valid = false;
        }
    }
    const status = !certain
        ? 'INVALID'
        : valid && !journal.failed && released
          ? 'PASS_NARROW'
          : 'FAIL';
    return {
        status,
        nonce,
        outcomes,
        sequences,
        observerDisconnectedAt,
        workExitedAt,
        failure,
        spawnUncertain,
        journalClosed: journal.closed,
        journalDurable: !journal.failed,
        markerReleased: released,
        closureReceiptClosed,
        elapsedMs: clock.now() - started,
        capability:
            'Supported attached owner/observer separation only; exec-server outage survival unproved.',
    };
}

async function peer(role, nonce) {
    let waiting,
        expected = 0,
        completed = false,
        timer;
    const send = (kind, seq) =>
        new Promise((resolve, reject) => {
            let sent = false,
                acknowledged = false;
            waiting = {
                seq,
                reject,
                ack: () => {
                    acknowledged = true;
                    if (sent) resolve();
                },
            };
            process.send({ kind, nonce, role, seq, pid: process.pid }, (error) => {
                if (error) reject(error);
                else {
                    sent = true;
                    if (acknowledged) resolve();
                }
            });
        });
    process.on('message', (message) => {
        try {
            assert.ok(waiting);
            validatePeerAck(message, nonce, role, expected);
        } catch (error) {
            clearTimeout(timer);
            waiting?.reject(error);
            process.exitCode = 1;
            if (process.connected) process.disconnect();
            return;
        }
        expected++;
        waiting.ack();
        waiting = null;
    });
    const delay = (ms) =>
        new Promise((resolve) => {
            timer = setTimeout(resolve, ms);
        });
    process.once('disconnect', () => {
        if (!completed) {
            clearTimeout(timer);
            waiting?.reject(Error('Owner IPC lost.'));
            process.exitCode = 1;
        }
    });
    await send('ready', 0);
    if (role === 'observer') {
        await delay(100);
        await send('unsubscribe', 1);
    } else {
        for (let seq = 1; seq <= 3; seq++) {
            await delay(600);
            await send('progress', seq);
        }
        await delay(600);
        await send('done', 4);
    }
    completed = true;
    process.disconnect();
}
async function fileHash(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) hash.update(chunk);
    return hash.digest('hex');
}
const clientFiles = [
    'journal.jsonl',
    'receipt.json',
    'owner-closure.json',
    'client-yield.json',
    'client-resume.json',
    'client-verdict.json',
];
/** Bound before opening and again during read; parse only this single validated snapshot. */
export function readProbeClientInputs(directory, reservedBytes, reservedRecords, io = fs) {
    let totalBytes = 2048 + reservedBytes,
        totalRecords = 2 + reservedRecords;
    assert.ok(totalBytes <= probeLimits.bytes && totalRecords <= probeLimits.records);
    const result = new Map(),
        names = io.readdirSync(directory);
    assert.ok(
        names.length <= clientFiles.length && names.every((name) => clientFiles.includes(name)),
    );
    for (const name of names) {
        const file = path.join(directory, name),
            before = io.lstatSync(file);
        const remaining = probeLimits.bytes - totalBytes;
        assert.ok(
            before.isFile() && !before.isSymbolicLink(),
            'Aliased/nonregular client evidence.',
        );
        assert.ok(
            Number.isSafeInteger(before.size) && before.size >= 0 && before.size <= remaining,
            'Client evidence size exceeds remaining budget before read.',
        );
        const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let bytes;
        try {
            const opened = io.fstatSync(fd);
            assert.ok(
                opened.isFile() &&
                    opened.dev === before.dev &&
                    opened.ino === before.ino &&
                    opened.size === before.size,
                'Client evidence changed before read.',
            );
            const buffer = Buffer.alloc(remaining + 1);
            let offset = 0;
            while (offset < buffer.length) {
                const n = io.readSync(fd, buffer, offset, buffer.length - offset, null);
                assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= buffer.length - offset);
                if (n === 0) break;
                offset += n;
            }
            assert.ok(offset <= remaining, 'Client evidence grew beyond remaining budget.');
            const after = io.fstatSync(fd);
            assert.ok(
                after.isFile() &&
                    after.dev === before.dev &&
                    after.ino === before.ino &&
                    after.size === before.size &&
                    offset === before.size,
                'Client evidence changed during read.',
            );
            bytes = buffer.subarray(0, offset);
        } finally {
            io.closeSync(fd);
        }
        const text = bytes.toString('utf8');
        assert.ok(!text || text.endsWith('\n'), 'Partial client evidence row.');
        const records = text ? text.trimEnd().split('\n').length : 0;
        totalBytes += bytes.length;
        totalRecords += records;
        assert.ok(
            totalBytes <= probeLimits.bytes && totalRecords <= probeLimits.records,
            'Client evidence aggregate budget exceeded.',
        );
        result.set(name, text);
    }
    return result;
}
export function writeProbeClient(directory, args, io = fs) {
    const phase = args.get('client-phase');
    assert.ok(['yield', 'resume'].includes(phase));
    const inputs = readProbeClientInputs(
        directory,
        phase === 'yield' ? 256 : 768,
        phase === 'yield' ? 1 : 2,
        io,
    );
    const first = JSON.parse(inputs.get('journal.jsonl')?.split('\n')[0]);
    assert.equal(first.event, 'inputs');
    assert.equal(first.data.nonce, args.get('nonce'));
    const record = {
        phase,
        nonce: args.get('nonce'),
        ownerPID: Number(args.get('owner-pid')),
        sessionId: args.get('session'),
        state: phase === 'yield' ? 'running' : 'completed',
        exitCode: phase === 'yield' ? null : Number(args.get('owner-exit-code')),
    };
    const planned = [['client-' + phase + '.json', record, 256]];
    if (phase === 'resume')
        planned.push([
            'client-verdict.json',
            validateProbeClient(
                JSON.parse(inputs.get('receipt.json')),
                JSON.parse(inputs.get('client-yield.json')),
                record,
            ),
            512,
        ]);
    const output = planned.map(([name, value, cap]) => {
        assert.ok(!inputs.has(name), 'Client evidence already exists.');
        const bytes = Buffer.from(JSON.stringify(value) + '\n');
        assert.ok(bytes.length <= cap);
        return { name, bytes };
    });
    for (const { name, bytes } of output) {
        const fd = io.openSync(path.join(directory, name), 'wx', 0o600);
        try {
            io.writeFileSync(fd, bytes);
            io.fsyncSync(fd);
        } finally {
            io.closeSync(fd);
        }
    }
}
async function main() {
    const args = new Map(
        process.argv.slice(2).map((v) => {
            const [k, ...x] = v.replace(/^--/, '').split('=');
            return [k, x.join('=')];
        }),
    );
    if (args.has('peer')) {
        assert.ok(['work', 'observer'].includes(args.get('peer')));
        await peer(args.get('peer'), args.get('nonce'));
        return;
    }
    if (args.has('client-directory')) {
        const directory = fs.realpathSync(args.get('client-directory'));
        const roots = [fs.realpathSync(process.cwd()), fs.realpathSync(os.tmpdir())];
        assert.ok(roots.some((base) => directory.startsWith(base + path.sep)));
        writeProbeClient(directory, args);
        return;
    }
    assert.equal(
        args.get('run'),
        '1',
        'Real probe is opt-in and must be independently reviewed before --run=1.',
    );
    const started = performance.now(),
        nonce = randomUUID();
    const marker = path.join(os.tmpdir(), 'diagnostic-hub-v060-check.lock'),
        owner = { owner: 'nonproduct-lifecycle', nonce, pid: process.pid };
    try {
        fs.writeFileSync(marker, JSON.stringify(owner), { flag: 'wx' });
    } catch (error) {
        if (error.code === 'EEXIST') {
            console.log(JSON.stringify({ status: 'BLOCKED', childCount: 0 }));
            process.exitCode = 1;
            return;
        }
        throw error;
    }
    let journal,
        directory,
        admitted = false;
    const lease = {
        release() {
            assert.deepEqual(JSON.parse(fs.readFileSync(marker)), owner);
            fs.unlinkSync(marker);
        },
    };
    try {
        const out = args.get('out');
        assert.ok(
            out && path.isAbsolute(out) && out.length <= 512,
            'Provide a bounded absolute private --out directory.',
        );
        let ancestor = out;
        while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
        const real = fs.realpathSync(ancestor),
            roots = [fs.realpathSync(process.cwd()), fs.realpathSync(os.tmpdir())];
        assert.ok(
            roots.some((base) => real === base || real.startsWith(base + path.sep)),
            'Output escapes task/temporary roots.',
        );
        fs.mkdirSync(out, { recursive: true });
        directory = fs.mkdtempSync(path.join(fs.realpathSync(out), 'lifecycle-'));
        const budget = new EvidenceBudget();
        // Reserve the final file, two client records/verdict, and two bounded console frames.
        for (const bytes of probeLimits.reservations) budget.reserve(bytes);
        const fd = fs.openSync(path.join(directory, 'journal.jsonl'), 'wx', 0o600);
        journal = new ProbeJournal(
            {
                write: (b, o, n) => fs.writeSync(fd, b, o, n),
                sync: () => fs.fsyncSync(fd),
                close: () => fs.closeSync(fd),
            },
            budget,
        );
        const fixture = fileURLToPath(import.meta.url),
            executable = fs.realpathSync(process.execPath);
        const inputs = {
            executable,
            executableSHA256: await fileHash(executable),
            node: process.version,
            fixtureSHA256: await fileHash(fixture),
            lifecycleSHA256: await fileHash(
                fileURLToPath(new URL('./lib/owned-child.mjs', import.meta.url)),
            ),
        };
        console.log(
            JSON.stringify({ kind: 'owner-ready', directory, nonce, ownerPID: process.pid }),
        );
        admitted = true;
        const result = await runProbeOwner({
            started,
            nonce,
            inputs,
            journal,
            lease,
            commitClosure: (record) => {
                const bytes = Buffer.from(JSON.stringify(record) + '\n');
                assert.ok(bytes.length <= 2048);
                const fd = fs.openSync(path.join(directory, 'owner-closure.json'), 'wx', 0o600);
                try {
                    fs.writeFileSync(fd, bytes);
                    fs.fsyncSync(fd);
                } finally {
                    fs.closeSync(fd);
                }
                return true;
            },
            clock: { now: () => performance.now(), set: setTimeout, clear: clearTimeout },
            spawnChild: (role, run) =>
                fork(fixture, ['--peer=' + role, '--nonce=' + run], {
                    execPath: executable,
                    execArgv: [],
                    detached: false,
                    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                }),
        });
        const ownerRecord = {
            ...result,
            ownerPID: process.pid,
            ownerVerdict: result.status,
            status:
                result.status === 'PASS_NARROW' ? 'OWNER_COMPLETE_PENDING_CLIENT' : result.status,
            clientEvidenceVerified: false,
        };
        const bytes = Buffer.from(JSON.stringify(ownerRecord) + '\n');
        assert.ok(bytes.length <= 4096);
        const final = fs.openSync(path.join(directory, 'receipt.json'), 'wx', 0o600);
        try {
            fs.writeFileSync(final, bytes);
            fs.fsyncSync(final);
        } finally {
            fs.closeSync(final);
        }
        console.log(
            JSON.stringify({
                status: ownerRecord.status,
                directory,
                nonce,
                childCount: result.outcomes.length,
                finalReceiptClosed: true,
            }),
        );
        if (result.status !== 'PASS_NARROW') process.exitCode = 1;
    } catch (error) {
        // Setup errors have no dummy handles. Runtime uncertain ownership is retained by runProbeOwner.
        if (!admitted) cleanupUnstartedProbe(journal, lease);
        throw error;
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void main().catch((error) => {
        console.error(String(error).slice(0, 512));
        process.exitCode = 1;
    });

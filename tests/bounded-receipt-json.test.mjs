import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedReceiptReader } from '../scripts/lib/bounded-receipt-json.mjs';

function fixture(options = {}) {
    const bytes = options.bytes ?? Buffer.from('{"status":"fixture-only"}');
    const original = {
        dev: 1n,
        ino: 2n,
        mode: 0o100600n,
        nlink: 1n,
        size: BigInt(options.size ?? bytes.length),
        mtimeNs: 123456789n,
        ctimeNs: 123456789n,
        isFile: () => true,
        isSymbolicLink: () => false,
    };
    const calls = { lstat: 0, open: 0, stat: 0, reads: [], close: 0 };
    const io = {
        flags: 123,
        async lstat(file, settings) {
            calls.lstat++;
            assert.equal(file, '/synthetic/receipt.json');
            assert.deepEqual(settings, { bigint: true });
            return options.lstat
                ? options.lstat(calls.lstat, original)
                : { ...original, ...options.preflight };
        },
        async open(file, flags) {
            calls.open++;
            assert.equal(file, '/synthetic/receipt.json');
            assert.equal(flags, 123);
            if (options.openFailure) throw options.openFailure;
            return {
                async stat(settings) {
                    calls.stat++;
                    assert.deepEqual(settings, { bigint: true });
                    return options.stat ? options.stat(calls.stat, original) : original;
                },
                async read(buffer, offset, length, position) {
                    calls.reads.push({ capacity: buffer.length, offset, length, position });
                    assert.equal(offset, position);
                    assert.ok(length > 0 && length <= 65536);
                    if (options.read) return options.read(buffer, offset, length, position);
                    const available = Math.max(0, bytes.length - position);
                    const count = Math.min(available, length, options.chunk ?? Infinity);
                    bytes.copy(buffer, offset, position, position + count);
                    return { buffer, bytesRead: count };
                },
                async close() {
                    calls.close++;
                    if (options.close) await options.close();
                },
            };
        },
    };
    return { calls, bytes, read: createBoundedReceiptReader(io, options.decode) };
}
const file = '/synthetic/receipt.json';

test('stable descriptor yields JSON only after bounded reads and close', async () => {
    const f = fixture();
    assert.deepEqual(await f.read(file), { status: 'fixture-only' });
    assert.equal(f.calls.lstat, 2);
    assert.equal(f.calls.stat, 2);
    assert.equal(f.calls.close, 1);
    assert.equal(f.calls.reads.at(-1).length, 1);
    assert.ok(f.calls.reads.every((read) => read.capacity === f.bytes.length + 1));
});

test('exact byte limit, multibyte UTF-8 and partial descriptor reads remain valid', async () => {
    const bytes = Buffer.from(JSON.stringify({ value: '測試'.repeat(20000) }));
    const f = fixture({ bytes, chunk: 73 });
    assert.deepEqual(await f.read(file, bytes.length), JSON.parse(bytes));
    assert.ok(f.calls.reads.length > 2);
    assert.equal(f.calls.close, 1);
});

test('invalid path and byte bounds fail before acquiring IO', async () => {
    for (const name of ['', null, 1, '\0']) {
        const f = fixture();
        await assert.rejects(f.read(name));
        assert.equal(f.calls.lstat + f.calls.open, 0);
    }
    for (const limit of [0, -1, NaN, Infinity, 1.5, '100', Number.MAX_SAFE_INTEGER]) {
        const f = fixture();
        await assert.rejects(f.read(file, limit));
        assert.equal(f.calls.lstat + f.calls.open, 0);
    }
});

test('empty, oversized and nonregular/link preflight fails before open', async () => {
    for (const preflight of [
        { size: 0n },
        { size: 1024n * 1024n + 1n },
        { isFile: () => false },
        { isSymbolicLink: () => true },
        { nlink: 2n },
        { mtimeNs: undefined },
    ]) {
        const f = fixture({ preflight });
        await assert.rejects(f.read(file));
        assert.equal(f.calls.open, 0);
    }
});

test('replacement before open rejects without reading and closes owned descriptor', async () => {
    const f = fixture({ stat: (_, original) => ({ ...original, ino: 3n }) });
    await assert.rejects(f.read(file), /before descriptor acquisition/);
    assert.equal(f.calls.reads.length, 0);
    assert.equal(f.calls.close, 1);
});

test('raced symlink, special file and hardlink descriptors are refused before read', async () => {
    for (const change of [{ isSymbolicLink: () => true }, { isFile: () => false }, { nlink: 2n }]) {
        const f = fixture({ stat: (_, original) => ({ ...original, ...change }) });
        await assert.rejects(f.read(file));
        assert.equal(f.calls.reads.length, 0);
        assert.equal(f.calls.close, 1);
    }
});

test('failed open is retained without inventing a returned descriptor', async () => {
    const error = Error('synthetic open failure');
    const f = fixture({ openFailure: error });
    await assert.rejects(f.read(file), (actual) => actual === error);
    assert.equal(f.calls.close, 0);
});

test('growth past original size fails after at most the one-byte witness', async () => {
    const f = fixture({ size: 2, bytes: Buffer.from('{"larger":true}') });
    await assert.rejects(f.read(file), /grew during read/);
    assert.deepEqual(f.calls.reads, [{ capacity: 3, offset: 0, length: 3, position: 0 }]);
    assert.equal(f.calls.close, 1);
});

test('an endless synthetic reader cannot exceed the initial byte allowance', async () => {
    const f = fixture({
        size: 70000,
        read: async (buffer, offset, length) => {
            buffer.fill(32, offset, offset + length);
            return { buffer, bytesRead: length };
        },
    });
    await assert.rejects(f.read(file), /grew during read/);
    assert.equal(
        f.calls.reads.reduce((sum, read) => sum + read.length, 0),
        70001,
    );
    assert.equal(f.calls.close, 1);
});

test('short EOF cannot silently truncate a receipt', async () => {
    const f = fixture({ size: 10, bytes: Buffer.from('{}') });
    await assert.rejects(f.read(file), /shrank during read/);
    assert.equal(f.calls.close, 1);
});

test('same-size writes and metadata changes on the opened descriptor are rejected', async () => {
    for (const field of ['dev', 'ino', 'mode', 'mtimeNs', 'ctimeNs', 'size']) {
        const f = fixture({
            stat: (call, original) =>
                call === 1 ? original : { ...original, [field]: original[field] + 1n },
        });
        await assert.rejects(f.read(file), /descriptor changed during read/);
        assert.equal(f.calls.close, 1);
    }
});

test('late pathname replacement is rejected despite a stable descriptor', async () => {
    const f = fixture({
        lstat: (call, original) => (call === 1 ? original : { ...original, ino: 3n }),
    });
    await assert.rejects(f.read(file), /path changed during read/);
    assert.equal(f.calls.stat, 2);
    assert.equal(f.calls.close, 1);
});

test('observer errors retain failure and close the acquired descriptor', async () => {
    const error = Error('synthetic observer error');
    for (const options of [
        {
            stat: () => {
                throw error;
            },
        },
        {
            stat: (call, original) => {
                if (call === 2) throw error;
                return original;
            },
        },
        {
            read: () => {
                throw error;
            },
        },
        {
            lstat: (call, original) => {
                if (call === 2) throw error;
                return original;
            },
        },
    ]) {
        const f = fixture(options);
        await assert.rejects(f.read(file), (actual) => actual === error);
        assert.equal(f.calls.close, 1);
    }
});

test('invalid descriptor acknowledgements do not reach JSON acceptance', async () => {
    for (const result of [
        (buffer) => ({ buffer, bytesRead: -1 }),
        (buffer) => ({ buffer, bytesRead: 0.5 }),
        (buffer) => ({ buffer, bytesRead: NaN }),
        (buffer, _, length) => ({ buffer, bytesRead: length + 1 }),
        () => ({ buffer: Buffer.alloc(1), bytesRead: 0 }),
    ]) {
        const f = fixture({ read: result });
        await assert.rejects(f.read(file), /Invalid receipt descriptor read acknowledgement/);
        assert.equal(f.calls.close, 1);
    }
});

test('malformed UTF-8, BOM and invalid JSON fail with descriptor cleanup', async () => {
    for (const bytes of [Buffer.from([34, 0xff, 34]), Buffer.from('\ufeff{}'), Buffer.from('{')]) {
        const f = fixture({ bytes });
        await assert.rejects(f.read(file));
        assert.equal(f.calls.close, 1);
    }
});

test('successful parse waits for the actual close acknowledgement', async () => {
    let acknowledge;
    const closed = new Promise((resolve) => {
        acknowledge = resolve;
    });
    const f = fixture({ close: () => closed });
    let settled = false;
    const result = f.read(file).finally(() => {
        settled = true;
    });
    for (let n = 0; n < 20 && !f.calls.close; n++) await Promise.resolve();
    assert.equal(f.calls.close, 1);
    assert.equal(settled, false);
    acknowledge();
    assert.deepEqual(await result, { status: 'fixture-only' });
});

test('a failed close blocks successful JSON return', async () => {
    const failure = Error('synthetic close failure');
    const f = fixture({
        close: () => {
            throw failure;
        },
    });
    await assert.rejects(f.read(file), (actual) => actual === failure);
    assert.equal(f.calls.close, 1);
});

test('primary read failure and close failure are both retained without retry', async () => {
    const primary = Error('synthetic read failure');
    const cleanup = Error('synthetic close failure');
    const f = fixture({
        read: () => {
            throw primary;
        },
        close: () => {
            throw cleanup;
        },
    });
    await assert.rejects(f.read(file), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
    });
    assert.equal(f.calls.close, 1);
});

test('non-Error rejection is not mistaken for successful completion', async () => {
    const f = fixture({
        read: () => {
            throw undefined;
        },
    });
    let rejected = false;
    await f.read(file).then(
        () => assert.fail('Expected the original rejection.'),
        (error) => {
            rejected = true;
            assert.equal(error, undefined);
        },
    );
    assert.equal(rejected, true);
    assert.equal(f.calls.close, 1);
});

test('raw timeline decoder preserves exact bytes and still waits for descriptor close', async () => {
    const bytes = Buffer.from('{"stage":"fixture"}\n{"stage":"receipt"}\n');
    const f = fixture({ bytes, decode: (value) => value });
    assert.deepEqual(await f.read(file), bytes);
    assert.equal(f.calls.close, 1);
});
test('raw timeline close failure cannot release bytes', async () => {
    const failure = Error('Synthetic raw close failure');
    const f = fixture({
        bytes: Buffer.from('fixture\n'),
        decode: (value) => value,
        close: async () => {
            throw failure;
        },
    });
    await assert.rejects(f.read(file), (error) => error === failure);
    assert.equal(f.calls.close, 1);
});

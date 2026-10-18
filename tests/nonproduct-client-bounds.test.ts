import assert from 'node:assert/strict';
import test from 'node:test';
import {
    readProbeClientInputs,
    writeProbeClient,
    probeLimits,
} from '../scripts/nonproduct-lifecycle-probe.mjs';

function fixture(contents: Record<string, string>, grow = false, alias = false) {
    const reads: any[] = [],
        opens: string[] = [],
        closed: number[] = [],
        files = new Map<number, string>();
    let fd = 0;
    const names = Object.keys(contents),
        initial = Object.fromEntries(names.map((n) => [n, Buffer.byteLength(contents[n])]));
    const stat = (name: string, size = initial[name]) => ({
        size,
        dev: 1,
        ino: names.indexOf(name) + 1,
        isFile: () => true,
        isSymbolicLink: () => alias,
    });
    const io = {
        readdirSync: () => names,
        lstatSync: (p: string) => stat(p.split('/').at(-1)!),
        openSync(p: string) {
            const name = p.split('/').at(-1)!;
            opens.push(name);
            files.set(++fd, name);
            return fd;
        },
        fstatSync(n: number) {
            const name = files.get(n)!;
            const count = reads.filter((r) => r.fd === n).length;
            return stat(name, grow && count ? initial[name] + probeLimits.bytes : initial[name]);
        },
        readSync(n: number, buffer: Buffer, offset: number, length: number) {
            const name = files.get(n)!,
                data = Buffer.from(contents[name] + (grow ? 'x'.repeat(probeLimits.bytes) : ''));
            const position = reads.filter((r) => r.fd === n).reduce((n, r) => n + r.bytes, 0),
                size = Math.min(length, data.length - position);
            data.copy(buffer, offset, position, position + size);
            reads.push({ fd: n, requested: length, bytes: size });
            return size;
        },
        closeSync(n: number) {
            closed.push(n);
        },
    };
    return { io, reads, opens, closed };
}
test('oversized client evidence is rejected by size before open/read; aliases are refused', () => {
    for (const alias of [false, true]) {
        const f = fixture({ 'journal.jsonl': 'x'.repeat(probeLimits.bytes + 1) }, false, alias);
        assert.throws(() => readProbeClientInputs('/fixture', 256, 1, f.io as any));
        assert.equal(f.reads.length, 0);
        assert.equal(f.opens.length, 0);
    }
});
test('growth after stat is bounded to remaining+1 bytes and closes its descriptor before rejection', () => {
    const f = fixture({ 'journal.jsonl': '{}\n' }, true);
    assert.throws(() => readProbeClientInputs('/fixture', 256, 1, f.io as any), /grew/);
    assert.equal(
        f.reads.reduce((n, r) => n + r.bytes, 0),
        probeLimits.bytes - 2048 - 256 + 1,
    );
    assert.deepEqual(f.closed, [1]);
});
test('aggregate bytes/records are checked from bounded content, which is read only once and reused', () => {
    const journal = JSON.stringify({ event: 'inputs', data: { nonce: 'n' } }) + '\n';
    const f = fixture({ 'journal.jsonl': journal, 'receipt.json': '{}\n' });
    const rows = readProbeClientInputs('/fixture', 768, 2, f.io as any);
    assert.equal(rows.get('journal.jsonl'), journal);
    assert.deepEqual(f.opens, ['journal.jsonl', 'receipt.json']);
    assert.deepEqual(f.closed, [1, 2]);
    assert.equal(f.reads.filter((r) => r.bytes > 0).length, 2);
    const tooMany = fixture({ 'journal.jsonl': '{}\n'.repeat(32) });
    assert.throws(() => readProbeClientInputs('/fixture', 256, 1, tooMany.io as any), /aggregate/);
    const aggregate = fixture({
        'journal.jsonl': 'x'.repeat(8000) + '\n',
        'receipt.json': 'x'.repeat(8000) + '\n',
    });
    assert.throws(
        () => readProbeClientInputs('/fixture', 768, 2, aggregate.io as any),
        /before read/,
    );
    assert.deepEqual(aggregate.opens, ['journal.jsonl']);
});
test('actual client consumer uses one bounded snapshot and never writes after an oversized/growing input', () => {
    for (const mode of ['normal', 'oversized', 'growing']) {
        const journal = JSON.stringify({ event: 'inputs', data: { nonce: 'n' } }) + '\n';
        const f = fixture(
            { 'journal.jsonl': mode === 'oversized' ? 'x'.repeat(probeLimits.bytes + 1) : journal },
            mode === 'growing',
        );
        const writes: string[] = [],
            data: Buffer[] = [];
        const io = {
            ...f.io,
            openSync(file: string, flags: any) {
                if (flags === 'wx') {
                    writes.push(file);
                    return 100;
                }
                return f.io.openSync(file);
            },
            writeFileSync(_fd: number, bytes: Buffer) {
                data.push(bytes);
            },
            fsyncSync() {},
            closeSync(fd: number) {
                if (fd !== 100) f.io.closeSync(fd);
            },
            readFileSync() {
                assert.fail('Unbounded read forbidden.');
            },
        };
        const args = new Map([
            ['client-phase', 'yield'],
            ['nonce', 'n'],
            ['owner-pid', '10'],
            ['session', 'tool-fixture'],
        ]);
        if (mode === 'normal') {
            writeProbeClient('/fixture', args, io as any);
            assert.deepEqual(f.opens, ['journal.jsonl']);
            assert.equal(writes.length, 1);
            assert.equal(JSON.parse(data[0].toString()).phase, 'yield');
        } else {
            assert.throws(() => writeProbeClient('/fixture', args, io as any));
            assert.equal(writes.length, 0);
        }
    }
});

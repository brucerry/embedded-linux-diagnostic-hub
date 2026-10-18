import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Executable contract/API model, not a C# interpreter or Windows qualification.
// The oracle below comes from the documented structures and the bounded x64 profile.
const fixed = [8, 9, 18, 20, 21, 24, 26, 27, 29];
const expected = new Map<number, [number, number]>([
    ...fixed.map((kind): [number, [number, number]] => [kind, [4, 4]]),
    [10, [56, 56]],
    [1, [0, 16]],
    [2, [0, 4]],
    [3, [0, 4]],
    [4, [0, 8]],
    [5, [0, 8]],
    [6, [0, 8]],
    [11, [0, 4]],
    [25, [0, 16]],
    [33, [0, 16]],
    [34, [0, 16]],
    [37, [0, 4]],
    [38, [0, 4]],
]);
const native = fs.readFileSync(
    new URL('../scripts/lib/windows-ownership-snapshot.cs', import.meta.url),
    'utf8',
);
const layouts = new Map(
    [...native.matchAll(/case (\d+): return new TokenLayout\((\d+),(\d+)\)/g)].map((m) => [
        +m[1],
        [+m[2], +m[3]] as [number, number],
    ]),
);
type Call = { kind: number; phase: string; buffer: Buffer | null; capacity: number };
type Reply = { ok: boolean; returned: number; error?: number };
type Allocations = { allocated: number; freed: number };
function queryModel<T>(
    kind: number,
    invoke: (call: Call) => Reply,
    read: (bytes: Buffer) => T,
    allocations: Allocations = { allocated: 0, freed: 0 },
) {
    const layout = layouts.get(kind);
    assert(layout, 'Unreviewed token class; no query');
    const [known, minimum] = layout;
    const call = (phase: string, buffer: Buffer | null, capacity: number) => {
        const reply = invoke({ kind, phase, buffer, capacity });
        // API success makes last-error undefined/stale. Never read it on success.
        const error = reply.ok ? null : reply.error;
        return { ok: reply.ok, returned: reply.returned, error };
    };
    const state = (phase: string, reply: ReturnType<typeof call>, capacity: number) =>
        `GetTokenInformation kind=${kind} phase=${phase} ok=${reply.ok ? 1 : 0} capacity=${capacity} returned=${reply.returned} win32=${reply.ok ? 'n/a' : reply.error}; no retry`;
    const capacity = known || 16384;
    allocations.allocated++;
    const bytes = Buffer.alloc(capacity);
    try {
        const phase = known ? 'fixed' : 'bounded',
            reply = call(phase, bytes, capacity);
        assert(
            reply.ok &&
                reply.returned >= minimum &&
                reply.returned <= capacity &&
                (!known || reply.returned === known),
            state(phase, reply, capacity),
        );
        return read(bytes.subarray(0, reply.returned));
    } finally {
        allocations.freed++;
    }
}
function noStaleError(reply: Omit<Reply, 'error'>): Reply {
    return Object.defineProperty(reply, 'error', {
        get() {
            throw Error('Success inspected stale last-error');
        },
    });
}

test('native class table covers exactly all22queried documented classes with audited fixed/header sizes', () => {
    assert.deepEqual(
        [...layouts].sort((a, b) => a[0] - b[0]),
        [...expected].sort((a, b) => a[0] - b[0]),
    );
    const actual = new Set(
        [...native.matchAll(/(?:Scalar|PointerSid|Groups|TokenValue)\(token,(\d+)/g)].map(
            (m) => +m[1],
        ),
    );
    for (const kind of [3, 6, 33, 34, 37, 38]) actual.add(kind); // Specialized privilege/default-DACL and fixed documented-count list.
    assert.deepEqual(
        [...actual].sort((a, b) => a - b),
        [...expected.keys()].sort((a, b) => a - b),
    );
    assert(!layouts.has(19)); // Never query linked tokens.
    for (const kind of [35, 36, 39]) assert(!layouts.has(kind)); // Reserved, not silently certified absent.
});
for (const [kind, [known, minimum]] of expected) {
    test(`token class${kind} uses ${known ? 'one exact fixed-buffer call' : 'one16KiBbounded-buffer call'}`, () => {
        const calls: Call[] = [],
            a = { allocated: 0, freed: 0 };
        const value = queryModel(
            kind,
            (call) => {
                calls.push(call);
                assert(call.buffer);
                call.buffer.fill(7);
                return noStaleError({ ok: true, returned: known || minimum });
            },
            (bytes) => ({ bytes: bytes.length, first: bytes[0] }),
            a,
        );
        assert.deepEqual(value, { bytes: known || minimum, first: 7 });
        assert.deepEqual(
            calls.map((c) => [c.phase, c.capacity, c.buffer === null]),
            known ? [['fixed', known, false]] : [['bounded', 16384, false]],
        );
        assert.deepEqual(a, { allocated: 1, freed: 1 });
    });
    for (const returned of [0, minimum - 1, (known || 16384) + 1])
        test(`token class${kind} refuses invalid returned byte bound${returned} before decoding`, () => {
            let decoded = false,
                calls = 0;
            const a = { allocated: 0, freed: 0 };
            assert.throws(() =>
                queryModel(
                    kind,
                    (call) => {
                        calls++;
                        return { ok: true, returned };
                    },
                    () => {
                        decoded = true;
                    },
                    a,
                ),
            );
            assert.equal(decoded, false);
            assert.equal(calls, 1);
            assert.equal(a.allocated, a.freed);
        });
}
test('modeled class20null-sizing incompatibility demonstrates old guard failure; proposed query uses4bytes directly', () => {
    // Synthetic trace, not reconstructed Win32 return values from run39098706408.
    const api = (capacity: number): Reply =>
        capacity === 0
            ? { ok: false, error: 87, returned: 0 }
            : noStaleError({ ok: true, returned: 4 });
    const old = api(0);
    assert.equal(!old.ok && old.error === 122 && old.returned > 0, false);
    let calls = 0;
    assert.equal(
        queryModel(
            20,
            (c) => {
                calls++;
                assert.equal(c.capacity, 4);
                return api(c.capacity);
            },
            (b) => b.length,
        ),
        4,
    );
    assert.equal(calls, 1);
});
for (const kind of fixed.concat(10))
    test(`fixed class${kind}API failure preserves actual numeric last-error and never retries`, () => {
        let calls = 0,
            decoded = false;
        const a = { allocated: 0, freed: 0 };
        assert.throws(
            () =>
                queryModel(
                    kind,
                    (c) => {
                        calls++;
                        return { ok: false, error: 5, returned: c.capacity + 4 };
                    },
                    () => {
                        decoded = true;
                    },
                    a,
                ),
            new RegExp(
                `kind=${kind} phase=fixed ok=0 capacity=${layouts.get(kind)![0]} returned=\\d+ win32=5`,
            ),
        );
        assert.equal(calls, 1);
        assert.equal(decoded, false);
        assert.deepEqual(a, { allocated: 1, freed: 1 });
    });
for (const reply of [
    { ok: false, error: 122, returned: 16385 },
    { ok: false, error: 87, returned: 0 },
    { ok: true, returned: 16385 },
    { ok: true, returned: 15 },
])
    test('bounded variable failure/oversize/truncation frees once without retry or decode', () => {
        const a = { allocated: 0, freed: 0 };
        let calls = 0;
        assert.throws(() =>
            queryModel(
                1,
                () => {
                    calls++;
                    return reply;
                },
                () => {
                    throw Error('Decoder called');
                },
                a,
            ),
        );
        assert.equal(calls, 1);
        assert.deepEqual(a, { allocated: 1, freed: 1 });
    });
test('variable success at16KiBcap and smaller result uses returned extent; decoder throw still frees once', () => {
    const a = { allocated: 0, freed: 0 };
    assert.throws(
        () =>
            queryModel(
                1,
                (c) => {
                    assert.equal(c.capacity, 16384);
                    return noStaleError({ ok: true, returned: 16 });
                },
                (b) => {
                    assert.equal(b.length, 16);
                    throw Error('Decoder failure');
                },
                a,
            ),
        /Decoder failure/,
    );
    assert.deepEqual(a, { allocated: 1, freed: 1 });
    assert.equal(
        queryModel(
            33,
            () => noStaleError({ ok: true, returned: 16384 }),
            (b) => b.length,
        ),
        16384,
    );
});
test('unknown/reserved/linked class does not invoke API or allocate', () => {
    for (const kind of [0, 7, 19, 35, 36, 39, 999]) {
        const a = { allocated: 0, freed: 0 };
        assert.throws(
            () =>
                queryModel(
                    kind,
                    () => {
                        throw Error('API called');
                    },
                    () => null,
                    a,
                ),
            /Unreviewed/,
        );
        assert.deepEqual(a, { allocated: 0, freed: 0 });
    }
});
test('native wrapper captures last-error immediately only after BOOL failure and frees before propagation', () => {
    const body = native.slice(
        native.indexOf('static T TokenValue<T>'),
        native.indexOf('static void Within'),
    );
    assert.equal(
        (
            body.match(
                /bool ok=Native.GetTokenInformation[^;]+;\s*int error=ok\?0:Marshal.GetLastWin32Error\(\);/g,
            ) || []
        ).length,
        1,
    );
    assert.match(body, /layout.Fixed==0\?\(uint\)MaxBuffer:layout.Fixed/);
    assert.doesNotMatch(body, /IntPtr.Zero|out needed/);
    assert.match(body, /layout.Fixed==0 \|\| actual==layout.Fixed/);
    assert.match(body, /return read\(memory,actual\)/);
    assert.match(body, /finally \{ Marshal.FreeHGlobal\(memory\); \}/);
    assert.doesNotMatch(body, /while|for\s*\(/);
    assert.match(native, /win32=.*ok\?"n\/a"/);
});

// Buffer decoder boundary model: pointer offsets represent addresses relative to the returned buffer.
function within(length: number, offset: number, bytes: number, min: number) {
    assert(
        Number.isInteger(offset) && offset >= min && bytes <= length && offset <= length - bytes,
        'outside returned token buffer',
    );
}
function sidExtent(bytes: Buffer, offset: number, min: number) {
    within(bytes.length, offset, 8, min);
    const count = bytes[offset + 1];
    assert.equal(bytes[offset], 1);
    assert(count <= 15);
    within(bytes.length, offset, 8 + 4 * count, min);
}
test('SID boundaries reject header/body escape, array overlap and subauthority overflow before conversion', () => {
    const bytes = Buffer.alloc(84);
    bytes[16] = 1;
    bytes[17] = 15;
    sidExtent(bytes, 16, 16);
    for (const [length, offset, min] of [
        [83, 16, 16],
        [16, 16, 16],
        [84, 15, 16],
        [84, -1, 16],
        [84, 85, 16],
    ])
        assert.throws(() => sidExtent(bytes.subarray(0, length), offset, min));
    bytes[17] = 16;
    assert.throws(() => sidExtent(bytes, 16, 16));
    assert.match(native, /Within\(buffer,length,value,8,minimumOffset,"SID header"\)/);
    assert.match(native, /Within\(buffer,length,value,bytes,minimumOffset,"SID body"\)/);
    assert.match(native, /new SecurityIdentifier\(copy,0\)/);
});
test('zero group/privilege count fits count header; populated arrays need x64stride and remain bounded', () => {
    const group = (count: number, length: number) =>
        assert(
            count >= 0 && count <= 128 && (count === 0 ? length >= 4 : 8 + count * 16 <= length),
        );
    const privilege = (count: number, length: number) =>
        assert(count >= 0 && count <= 64 && 4 + count * 12 <= length);
    group(0, 4);
    group(128, 2056);
    privilege(0, 4);
    privilege(64, 772);
    for (const args of [
        [129, 16384],
        [1, 23],
        [128, 2055],
        [-1, 4],
    ])
        assert.throws(() => group(args[0], args[1]));
    for (const args of [
        [65, 16384],
        [1, 15],
        [64, 771],
        [-1, 4],
    ])
        assert.throws(() => privilege(args[0], args[1]));
    assert.match(native, /count == 0 \|\| 8L \+ count \* 16L <= n/);
    assert.match(native, /4L\+12L\*count<=n/);
});
test('default DACL pointer/header/full ACL stays within returned bytes; null pointer remains valid', () => {
    within(16, 8, 8, 8);
    within(16384, 8, 16376, 8);
    for (const args of [
        [8, 8, 8, 8],
        [16, 7, 8, 8],
        [16, 8, 9, 8],
        [16384, 8, 16384, 8],
    ])
        assert.throws(() => within(...(args as [number, number, number, number])));
    assert.match(native, /if\(acl==IntPtr.Zero\)return null/);
    assert.match(native, /Within\(p,n,acl,8,8,"Default DACL header"\)/);
    assert.match(native, /Within\(p,n,acl,\(uint\)length,8,"Default DACL body"\)/);
});

test('failure reads its saved numeric error once; success never reads error even when a stale value exists', () => {
    let reads = 0,
        calls = 0;
    const a = { allocated: 0, freed: 0 };
    const failure = Object.defineProperty({ ok: false, returned: 0 }, 'error', {
        get() {
            reads++;
            return 87;
        },
    });
    assert.throws(
        () =>
            queryModel(
                20,
                () => {
                    calls++;
                    return failure;
                },
                () => null,
                a,
            ),
        /kind=20 phase=fixed ok=0 capacity=4 returned=0 win32=87/,
    );
    assert.equal(reads, 1);
    assert.equal(calls, 1);
    assert.deepEqual(a, { allocated: 1, freed: 1 });
    assert.equal(
        queryModel(
            20,
            () => ({ ok: true, returned: 4, error: 5 }),
            (bytes) => bytes.length,
        ),
        4,
    );
    assert.match(native, /uint actual=0; bool ok=Native.GetTokenInformation/);
});

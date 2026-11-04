import assert from 'node:assert/strict';
import test from 'node:test';
import { networkJson } from '../shared/diagnostics/network/json';
import { lanSummary } from '../shared/diagnostics/network/lan';
import type { Snapshot } from '../shared/types';

const unsafe = ['9007199254740992', '-9007199254740992', '18446744073709551615', '9'.repeat(400)];

test('precision preservation cannot turn bare numeric object keys into valid JSON', () => {
    for (const key of unsafe) {
        for (const raw of [`{${key}:1}`, `[{"ifname":"eth0",${key}:1}]`, `{"x":{${key}:[]}}`]) {
            assert.throws(() => JSON.parse(raw), SyntaxError);
            assert.throws(() => networkJson(raw), SyntaxError, raw);
        }
    }
});

test('malformed numeric syntax remains rejected beside preserved integer values', () => {
    for (const raw of [
        '[01,18446744073709551615]',
        '[18446744073709551615,]',
        '{"x":18446744073709551615 "y":1}',
        '[+18446744073709551615]',
        '[18446744073709551615.]',
        '[18446744073709551615e]',
        '[18446744073709551615] false',
        '[18446744073709551615 /* comment */]',
    ]) {
        assert.throws(() => JSON.parse(raw), SyntaxError);
        assert.throws(() => networkJson(raw), SyntaxError, raw);
    }
});

test('valid integers keep exact decimal values without changing safe numbers or numeric keys', () => {
    for (const value of unsafe) {
        assert.equal(networkJson(value), value);
        assert.deepEqual(networkJson('[' + value + ']'), [value]);
        const raw = `{"${value}":${value},"safe":9007199254740991,"negative":-9007199254740991,"zero":-0}`;
        const parsed = networkJson(raw) as Record<string, unknown>;
        assert.equal(parsed[value], value);
        assert.equal(parsed.safe, Number.MAX_SAFE_INTEGER);
        assert.equal(parsed.negative, Number.MIN_SAFE_INTEGER);
        assert.ok(Object.is(parsed.zero, -0));
    }
    assert.deepEqual(networkJson('[1.5,1e3,1E-3,true,null,[]]'), [
        1.5,
        1000,
        0.001,
        true,
        null,
        [],
    ]);
});

test('quoted escapes and large-number-looking strings are preserved verbatim', () => {
    const text = '18446744073709551615 \\" \\ {9007199254740992:1} café 家庭';
    const raw = `{"text":${JSON.stringify(text)},"count":18446744073709551615}`;
    assert.deepEqual(networkJson(raw), { text, count: '18446744073709551615' });
});

test('original byte, nesting and container bounds remain enforced', () => {
    const maximum = 262144;
    assert.equal((networkJson('"' + 'a'.repeat(maximum - 2) + '"') as string).length, maximum - 2);
    assert.throws(() => networkJson('"' + 'a'.repeat(maximum - 1) + '"'), /evidence bound/);
    assert.throws(() => networkJson('"' + 'é'.repeat(maximum / 2) + '"'), /evidence bound/);
    const prefix = '[' + unsafe[0] + ',"';
    const bounded = prefix + 'a'.repeat(maximum - prefix.length - 2) + '"]';
    assert.equal(new TextEncoder().encode(bounded).length, maximum);
    assert.doesNotThrow(() => networkJson(bounded));
    assert.throws(() => networkJson(bounded + ' '), /evidence bound/);
    assert.doesNotThrow(() => networkJson('['.repeat(32) + unsafe[0] + ']'.repeat(32)));
    assert.throws(() => networkJson('['.repeat(33) + unsafe[0] + ']'.repeat(33)), /evidence bound/);
    assert.doesNotThrow(() => networkJson('[' + Array(8191).fill('{}').join(',') + ']'));
    assert.throws(
        () => networkJson('[' + Array(8192).fill('{}').join(',') + ']'),
        /evidence bound/,
    );
    assert.doesNotThrow(() =>
        networkJson('[' + unsafe[0] + ',' + Array(8191).fill('{}').join(',') + ']'),
    );
    assert.throws(
        () => networkJson('[' + unsafe[0] + ',' + Array(8192).fill('{}').join(',') + ']'),
        /evidence bound/,
    );
});

const stamp = '2026-11-04T12:00:00.000Z';
function snapshot(kind: 'ethernet' | 'interfaces', stdout: string): Snapshot {
    return {
        schemaVersion: 1,
        mode: 'demo',
        endpoint: 'synthetic.invalid:22',
        username: 'fixture',
        capturedAt: stamp,
        results: [
            {
                id: kind,
                status: 'collected',
                stdout:
                    kind === 'interfaces'
                        ? '7: eth0: <UP> mtu 1500 state UP\n    inet 192.0.2.7/24 scope global eth0\n'
                        : '',
                stderr: '',
                exitCode: 0,
                durationMs: 1,
                collectedAt: stamp,
                truncated: false,
                networkEvidence: {
                    version: 1,
                    omissions: [],
                    sections: [
                        {
                            id: 'synthetic-json',
                            operation: kind === 'ethernet' ? 'ip-link-json' : 'ip-address-json',
                            scope: 'all',
                            source: 'live',
                            command: 'synthetic evidence only',
                            status: 'collected',
                            stdout,
                            stderr: '',
                            exitCode: 0,
                            durationMs: 1,
                            collectedAt: stamp,
                            truncated: false,
                        },
                    ],
                },
            },
        ],
    };
}

test('invalid link JSON cannot produce a structured interface or erase the warning', () => {
    const input = snapshot('ethernet', '[{"ifname":"eth0","ifindex":7,18446744073709551615:1}]');
    const before = structuredClone(input);
    const model = lanSummary(input);
    assert.deepEqual(model.interfaces, []);
    assert.deepEqual(model.warnings, [
        'Some synthetic-json JSON could not be interpreted; raw evidence is retained.',
    ]);
    assert.deepEqual(input, before);
});

test('invalid optional address JSON keeps primary text fallback and raw evidence intact', () => {
    const input = snapshot('interfaces', '[{18446744073709551615:1}]');
    const before = structuredClone(input);
    const model = lanSummary(input);
    assert.equal(model.interfaces.length, 1);
    assert.equal(model.interfaces[0].name, 'eth0');
    assert.equal(model.interfaces[0].ifindex, 7);
    assert.ok(
        model.interfaces[0].groups.some((group) =>
            group.fields.some((field) => field.value === 'inet 192.0.2.7/24 scope global eth0'),
        ),
    );
    assert.deepEqual(model.warnings, [
        'Some synthetic-json JSON could not be interpreted; raw evidence is retained.',
    ]);
    assert.deepEqual(input, before);
});

test('valid 64-bit counters retain their visible exact text and source evidence', () => {
    const input = snapshot(
        'ethernet',
        '[{"ifname":"eth0","ifindex":7,"stats64":{"rx":{"bytes":18446744073709551615}}}]',
    );
    const before = structuredClone(input);
    const model = lanSummary(input);
    assert.equal(model.interfaces.length, 1);
    assert.ok(
        model.interfaces[0].groups.some((group) =>
            group.fields.some((field) => field.value === '18446744073709551615'),
        ),
    );
    assert.deepEqual(model.warnings, []);
    assert.deepEqual(input, before);
});

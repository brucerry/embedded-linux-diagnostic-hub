import assert from 'node:assert/strict';
import test from 'node:test';
import { evidencePresentation } from '../shared/diagnostics/evidence';
import type { ProbeResult } from '../shared/types';

const unavailable = 'Number exceeds exact display range; inspect Standard output.';
const result = (stdout: string): ProbeResult => ({
    id: 'services',
    status: 'collected',
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    collectedAt: '2026-11-04T00:00:00Z',
    truncated: false,
});

test('JSON evidence does not publish rounded large integers or overflow as null', () => {
    for (const token of ['18446744073709551615', '-9007199254740993', '1e309', '-1e309']) {
        const input = result('{"counter":' + token + '}');
        const before = structuredClone(input);
        assert.deepEqual(
            evidencePresentation('services', input).tree,
            [{ key: '["counter"]', label: 'counter', value: unavailable }],
            token,
        );
        assert.deepEqual(
            evidencePresentation('board', input).table?.rows,
            [['counter', unavailable]],
            token,
        );
        assert.deepEqual(input, before, 'The exact raw token remains available.');
    }
});

test('safe numeric evidence and explicitly quoted decimals preserve their scalar types', () => {
    const input = result(
        '{"maximum":9007199254740991,"minimum":-9007199254740991,' +
            '"zero":0,"fraction":1.25,"boolean":false,"nil":null,"text":"18446744073709551615"}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
        evidencePresentation('services', input).tree?.map((node) => node.value),
        [
            '9007199254740991',
            '-9007199254740991',
            '0',
            '1.25',
            'false',
            'null',
            '"18446744073709551615"',
        ],
    );
    assert.equal(
        evidencePresentation('board', input).table?.rows.at(-1)?.[1],
        '18446744073709551615',
    );
    assert.deepEqual(input, before);
});

test('nested and array numeric values are checked without altering JSON display limits', () => {
    const input = result('{"nested":[{"unsafe":9007199254740993},1e309,7]}');
    const tree = evidencePresentation('services', input).tree!;
    assert.equal(tree[0].children![0].children![0].value, unavailable);
    assert.equal(tree[0].children![1].value, unavailable);
    assert.equal(tree[0].children![2].value, '7');
    assert.match(
        evidencePresentation('services', result('{"a":'.repeat(100) + '0' + '}'.repeat(100))).note!,
        /32 levels/,
    );
    const large = result(
        JSON.stringify(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['key' + i, i]))),
    );
    assert.equal(evidencePresentation('services', large).tree!.length, 4000);
    assert.match(evidencePresentation('services', large).note!, /4,000 fields/);
});

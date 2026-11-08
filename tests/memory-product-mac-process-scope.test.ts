/** Pure join/refusal controls. Actual libproc evidence comes from the native run. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDarwinProcessFacts } from './fixtures/memory-product-aggregate-scope';
import type { ProcessSample } from './fixtures/memory-resource-verdict';
const samples: ProcessSample[] = [
    {
        pid: 123,
        created: 'model creation',
        role: 'model-only',
        state: 'running',
        rssBytes: 1,
        heapUsedBytes: null,
        externalBytes: null,
        arrayBuffersBytes: null,
        unsupported: [],
    },
];
function input() {
    return {
        before: [{ pid: 123, parent: 12, created: 'model creation', rssBytes: 1 }],
        after: [{ pid: 123, parent: 12, created: 'model creation', rssBytes: 1 }],
        paths: [{ pid: 123, executablePath: '/model path/Application Helper' }],
        commands: ' 123 argv name --model-only\n',
    };
}
test('Mac facts join the kernel executable path separately from full argv and stable creation', () => {
    const v = input();
    const result = verifyDarwinProcessFacts(samples, v.before, v.after, v.paths, v.commands);
    assert.equal(result[0].executablePath, '/model path/Application Helper');
    assert.equal(result[0].commandLine, 'argv name --model-only');
    assert.equal(result[0].created, samples[0].created);
});
for (const fault of [
    'missing-before',
    'missing-after',
    'reused-after',
    'missing-path',
    'foreign-path',
    'duplicate-path',
    'relative-path',
    'nul-path',
    'missing-command',
    'duplicate-command',
] as const) {
    test('Mac fact join refuses ' + fault, () => {
        const v = input();
        if (fault === 'missing-before') v.before = [];
        if (fault === 'missing-after') v.after = [];
        if (fault === 'reused-after') v.after[0].created = 'replacement';
        if (fault === 'missing-path') v.paths = [];
        if (fault === 'foreign-path') v.paths.push({ pid: 999, executablePath: '/foreign' });
        if (fault === 'duplicate-path') v.paths.push({ ...v.paths[0] });
        if (fault === 'relative-path') v.paths[0].executablePath = 'relative';
        if (fault === 'nul-path') v.paths[0].executablePath = '/invalid\0path';
        if (fault === 'missing-command') v.commands = '';
        if (fault === 'duplicate-command') v.commands += v.commands;
        assert.throws(() =>
            verifyDarwinProcessFacts(samples, v.before, v.after, v.paths, v.commands),
        );
    });
}

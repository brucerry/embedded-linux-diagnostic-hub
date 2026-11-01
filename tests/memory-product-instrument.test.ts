import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    instrumentProductSource,
    productProbePreimages,
} from './fixtures/memory-product-instrument';

test('private product probes reject changed lifetime source before compilation', async () => {
    for (const [name] of productProbePreimages) {
        const file = path.resolve(import.meta.dirname, '..', name);
        const source = await fs.readFile(file, 'utf8');
        assert.ok(instrumentProductSource(source, file)?.code.includes('__qualificationProbe'));
        assert.throws(() => instrumentProductSource(source + '\n', file), /probe preimage changed/);
    }
    assert.equal(instrumentProductSource('export class Other {}', '/src/other.ts'), null);
});

test('actual page export RPC probe preserves retirement semantics and rejects changed preimages', async () => {
    // Canonical worktree cwd is explicit for direct compiled selection; no app is imported.
    const file = path.resolve('src/features/automation/capture/browser-export.ts');
    const source = await fs.readFile(file, 'utf8');
    const transformed = instrumentProductSource(source, file);
    assert.ok(transformed);
    const begin = '    return new Promise((resolve, reject) => {',
        wrappedBegin = '    return __memoryTrackExportRpc(new Promise((resolve, reject) => {',
        end = '    });\n}\nexport interface BrowserExportDiagnostic {',
        wrappedEnd = '    }));\n}\nexport interface BrowserExportDiagnostic {';
    const suffix = transformed.code.slice(transformed.code.indexOf('\nlet __memoryExportRpcs=0;'));
    assert.ok(suffix.startsWith('\nlet __memoryExportRpcs=0;'));
    assert.equal(transformed.code.split(wrappedBegin).length, 2);
    assert.equal(transformed.code.split(wrappedEnd).length, 2);
    assert.equal(transformed.code.slice(0, -suffix.length).replace(wrappedBegin, begin).replace(wrappedEnd, end), source,
        'Only the actual RPC promise is wrapped; retirement/admission code is byte-preserved');
    assert.ok(suffix.includes('void task.then(release,release);return task;'));
    assert.ok(suffix.includes('active:activeExports'));
    assert.ok(suffix.includes('busyHelpers:helpers.filter(helper=>helper.busy).length'));
    assert.throws(() => instrumentProductSource(source + '\n', file), /preimage changed/);
    assert.throws(() => instrumentProductSource(source.replace('retirementProtocol !== 1', 'retirementProtocol !== 0'), file), /preimage changed/);
    const compiledSource = process.env.DIAGNOSTIC_HUB_INSTRUMENT_SOURCE;
    if (compiledSource) {
        const staged = await fs.readFile(compiledSource, 'utf8');
        const originalImport = "from '../../../../shared/capture-store'";
        const explicitImport = 'from ' + JSON.stringify(path.resolve('shared/capture-store.ts'));
        assert.equal(staged.replace(explicitImport, originalImport), transformed.code,
            'The separately compiled observation entry is the actual transform with one reviewed import retarget');
    }
});

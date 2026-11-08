import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { retainedPageReader } from './fixtures/memory-product-e5-page';
import {
    instrumentProductSource,
    productProbePreimages,
} from './fixtures/memory-product-current-instrument';

test('private product probes reject changed lifetime source before compilation', async () => {
    for (const [name] of productProbePreimages) {
        const file = path.resolve(process.cwd(), name);
        const source = await fs.readFile(file, 'utf8');
        assert.ok(instrumentProductSource(source, file)?.code.includes('__qualificationProbe'));
        assert.throws(() => instrumentProductSource(source + '\n', file), /probe preimage changed/);
    }
    assert.equal(instrumentProductSource('export class Other {}', '/src/other.ts'), null);
});

test('retained e9 Page data rederives refs and complete Start boundary with byte-preserving inverse', async () => {
    const file = path.resolve('src/features/automation/AutomationPage.tsx');
    const source = (await retainedPageReader(process.cwd())(file)).toString('utf8');
    const result = instrumentProductSource(source, file)!;
    const prefix =
        "import {trackProductPageRefs as __observeProductPageRefs,trackProductPageRun as __trackProductPageRun} from '/tests/fixtures/memory-product-page-refs';\n";
    const call =
        '\n    __observeProductPageRefs(flowInspectionId, activityEpoch, {arming, armAttempt, cleanupActivity, cleanupActivityRetirement, cleanupClock, cleanupConsoleResults, pendingClockSamples});';
    assert.ok(result.code.startsWith(prefix));
    assert.equal(result.code.split(call).length, 2);
    assert.equal(
        result.code
            .slice(prefix.length)
            .replace(call, '')
            .replace(
                '    const start = __trackProductPageRun(async (once = false) => {',
                '    const start = async (once = false) => {',
            )
            .replace(
                '    });\n    const edit = (id: string, patch: Partial<CommandStep>) =>',
                '    };\n    const edit = (id: string, patch: Partial<CommandStep>) =>',
            ),
        source,
    );
    for (const name of [
        'flowInspectionId',
        'activityEpoch',
        'arming',
        'armAttempt',
        'cleanupActivity',
        'cleanupActivityRetirement',
        'cleanupClock',
        'cleanupConsoleResults',
        'pendingClockSamples',
    ])
        assert.ok(source.indexOf(name) < source.indexOf('    latest.current = props;'));
    for (const changed of [
        source + '\n',
        result.code,
        source.replace('armAttempt.current = null;', 'armAttempt.current = Symbol();'),
    ])
        assert.throws(() => instrumentProductSource(changed, file), /preimage changed/);
    const live = await fs.readFile(file, 'utf8');
    assert.notEqual(live, source, 'The live Page is newer than this retained e9 input.');
    assert.throws(() => instrumentProductSource(live, file), /preimage changed/);
    const transform = productQualificationPlugin().transform as (
        code: string,
        id: string,
        options: unknown,
    ) => unknown;
    assert.throws(() => transform(live, file, {}), /preimage changed/);
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
    assert.equal(
        transformed.code
            .slice(0, -suffix.length)
            .replace(wrappedBegin, begin)
            .replace(wrappedEnd, end),
        source,
        'Only the actual RPC promise is wrapped; retirement/admission code is byte-preserved',
    );
    assert.ok(suffix.includes('void task.then(release,release);return task;'));
    assert.ok(suffix.includes('active:activeExports'));
    assert.ok(suffix.includes('busyHelpers:helpers.filter(helper=>helper.busy).length'));
    assert.throws(() => instrumentProductSource(source + '\n', file), /preimage changed/);
    assert.throws(
        () =>
            instrumentProductSource(
                source.replace('retirementProtocol !== 1', 'retirementProtocol !== 0'),
                file,
            ),
        /preimage changed/,
    );
    const compiledSource = process.env.DIAGNOSTIC_HUB_INSTRUMENT_SOURCE;
    if (compiledSource) {
        const staged = await fs.readFile(compiledSource, 'utf8');
        const originalImport = "from '../../../../shared/capture-store'";
        const explicitImport = 'from ' + JSON.stringify(path.resolve('shared/capture-store.ts'));
        assert.equal(
            staged.replace(explicitImport, originalImport),
            transformed.code,
            'The separately compiled observation entry is the actual transform with one reviewed import retarget',
        );
    }
});

// The legacy helper remains deliberately source-bound to its historical preimages.
import * as historical from './fixtures/memory-product-instrument';
import {
    productQualificationPlugin,
    currentObserverSource,
} from './fixtures/memory-product-current-instrument';
import ts from 'typescript';

test('retained e9 renderer preparation preserves historical pins and rejects stale or mixed source selection', async () => {
    assert.equal(currentObserverSource.commit, 'e9bb9bc2c599fc47f7f422d7dcae291337b55478');
    assert.equal(currentObserverSource.tree, 'f1119793f8109d4d81faba07ace52f43e346e4e4');
    assert.equal(productProbePreimages.length, 9);
    assert.ok(Object.isFrozen(productProbePreimages));
    assert.equal(
        historical.productProbePreimages.find(
            ([name]) => name === 'src/features/automation/activity-release.ts',
        )![3],
        '5620edfd25a683e3ce82a01ab151896fe69314600f38ea0d88219bd2e66dc68b',
    );
    for (const file of [
        'src/features/automation/activity-release.ts',
        'src/features/automation/AutomationPage.tsx',
        'src/features/automation/capture/browser-export.ts',
    ]) {
        const source = (await retainedPageReader(process.cwd())(path.resolve(file))).toString(
            'utf8',
        );
        assert.throws(
            () => historical.instrumentProductSource(source, path.resolve(file)),
            /preimage changed/,
        );
        assert.ok(instrumentProductSource(source, path.resolve(file)));
        assert.throws(
            () =>
                historical.instrumentProductSource(source, path.resolve(file), 'unreviewed' as any),
            /Unsupported observer source/,
        );
    }
});

test('all current constructor probes restore exact source and preserve special reader and cleanup wrapping', async () => {
    const prefix =
        "import {trackProduct as __trackProduct,trackProductTask as __trackProductTask} from '/tests/fixtures/memory-product-registry';\n";
    for (const [name, _class, kind] of productProbePreimages) {
        const source = await fs.readFile(name, 'utf8');
        const result = instrumentProductSource(source, path.resolve(name))!;
        assert.ok(result.code.startsWith(prefix));
        const insertion = `\n private readonly __qualificationProbe = __trackProduct('${kind}', this);`;
        assert.equal(result.code.split(insertion).length, 2);
        let restored = result.code.slice(prefix.length).replace(insertion, '');
        if (kind === 'gateway')
            restored = restored
                .replace(
                    "        void __trackProductTask(this, 'httpReader', (async () => {",
                    '        void (async () => {',
                )
                .replace(
                    '        })());\n        return ready;',
                    '        })();\n        return ready;',
                );
        if (kind === 'repository')
            restored = restored
                .replace(
                    "            this.releasing = __trackProductTask(this, 'cleanup', (async () => {",
                    '            this.releasing = (async () => {',
                )
                .replace(
                    '            })());\n            void this.releasing.catch(() => {});',
                    '            })();\n            void this.releasing.catch(() => {});',
                );
        assert.equal(restored, source);
        assert.throws(
            () => instrumentProductSource(result.code, path.resolve(name)),
            /preimage changed/,
        );
        const diagnostics =
            ts.transpileModule(result.code, {
                fileName: name,
                reportDiagnostics: true,
                compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
            }).diagnostics ?? [];
        assert.deepEqual(
            diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error),
            [],
        );
    }
});

test('actual private plugin selects the current profile and cannot take a profile from Vite options', async () => {
    const plugin = productQualificationPlugin();
    const transform = plugin.transform;
    assert.equal(typeof transform, 'function');
    const file = path.resolve('src/features/automation/activity-release.ts');
    const source = await fs.readFile(file, 'utf8');
    const invoke = transform as (code: string, id: string, options: unknown) => { code: string };
    assert.deepEqual(
        invoke(source, file, { ssr: true, profile: 'historical-96a56cd' }),
        instrumentProductSource(source, file),
    );
    assert.throws(() => invoke(source + '\n', file, {}), /preimage changed/);
    assert.throws(
        () => historical.productQualificationPlugin('unreviewed' as any),
        /Unsupported observer source/,
    );
    const config = await fs.readFile('tests/fixtures/memory-product.vite.mts', 'utf8');
    assert.ok(config.includes("from './memory-product-current-instrument'"));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { retainedPageReader, retainedPageSource } from './fixtures/memory-product-e5-page';
import historical from './fixtures/memory-product-96a-sources.json';
import {
    decodeHistoricalProductSources,
    historicalProductSourceRoot,
} from './fixtures/memory-product-96a-sources';
import { hostOwnerSourcePins, validateHostBinding } from './fixtures/memory-product-host-ownership';
import { nativeMainSourcePins } from './fixtures/memory-product-native-main-transform';
import { productProbePreimages } from './fixtures/memory-product-instrument';
import { nativeObserverBuildPlugin } from './fixtures/memory-product-native-build-plugin';
import { assertNativeMainRetired } from './fixtures/memory-product-native-main-state';
import {
    currentProductSourceManifest,
    verifyCurrentSourceSubset,
    validateCurrentSourceSubsetBinding,
    sourceSubsetReceipt,
    verifySourceSubsetReceipt,
} from './fixtures/memory-product-e5-source';

test('frozen historical corpus is exact, complete for every legacy pin and rejects wrong archive bytes', async () => {
    const archive = await fs.readFile(
        new URL('./fixtures/memory-product-96a-sources.blobs.gz', import.meta.url),
    );
    const sources = decodeHistoricalProductSources(archive);
    const pins = {
        ...hostOwnerSourcePins,
        ...nativeMainSourcePins,
        ...Object.fromEntries(productProbePreimages.map(([file, , , hash]) => [file, hash])),
        'src/features/automation/AutomationPage.tsx':
            'ea978e8dfe36aaedaf763db7102892c82ca0ac298fbd36d9994cc1d72456cab4',
        'src/features/automation/capture/browser-export.ts':
            'c7122f17851177d7eebc1dd9cdca4978812756f7ab5881fb9d6428507de8de6b',
    };
    assert.equal(sources.size, 25);
    assert.deepEqual(
        Object.fromEntries(historical.files.map((file) => [file.path, file.sha256])),
        Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b))),
    );
    const root = await historicalProductSourceRoot();
    for (const [file, expected] of Object.entries(pins)) {
        const source = await fs.readFile(path.join(root, file));
        assert.equal(createHash('sha256').update(source).digest('hex'), expected);
        assert.equal(source.toString(), sources.get(file));
    }
    const changed = Buffer.from(archive);
    changed[changed.length - 1] ^= 1;
    for (const value of [changed, archive.subarray(1), Buffer.concat([archive, Buffer.from('\n')])])
        assert.throws(() => decodeHistoricalProductSources(value), /archive changed/);
});

test('retained e5 v2 data checks all 26 targets and carries exact source-only identity through its receipt', async () => {
    const reads: string[] = [];
    const read = retainedPageReader(process.cwd());
    const binding = await verifyCurrentSourceSubset(process.cwd(), async (file) => {
        reads.push(path.relative(process.cwd(), file).split(path.sep).join('/'));
        return read(file);
    });
    assert.equal(currentProductSourceManifest.files.length, 26);
    assert.deepEqual(
        reads,
        currentProductSourceManifest.files.map((file) => file.path),
    );
    assert.deepEqual(Object.keys(binding.pins), reads);
    assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.pins));
    assert.equal(binding.version, 2);
    assert.equal(binding.sourceCommit, 'e5fb2fd71209b9d321020cae8feb9326bb49af19');
    assert.equal(binding.realm, 'source-only');
    assert.equal(binding.completeDependencyClosure, false);
    assert.equal(binding.nativeAdmission, false);
    assert.equal(binding.runtimeAttestation, false);
    const receipt = sourceSubsetReceipt(binding);
    assert.deepEqual(verifySourceSubsetReceipt(structuredClone(receipt), binding), receipt);
    assert.equal(receipt.binding.manifestSHA256, binding.manifestSHA256);
    assert.equal(receipt.sourceFiles, 26);
    assert.ok(!Object.hasOwn(receipt, 'sourceMain') && !Object.hasOwn(receipt, 'verified'));
});

test('each retained e5 target rejects changed and missing input bytes, while wrong roots and older historical bytes refuse v2', async () => {
    const read = retainedPageReader(process.cwd());
    await verifyCurrentSourceSubset(process.cwd(), read);
    for (const target of currentProductSourceManifest.files) {
        await assert.rejects(
            verifyCurrentSourceSubset(process.cwd(), async (file) => {
                const bytes = await read(file);
                if (file !== path.join(process.cwd(), target.path)) return bytes;
                const changed = Buffer.from(bytes);
                changed[0] ^= 1;
                return changed;
            }),
            /preimage changed/,
        );
        await assert.rejects(
            verifyCurrentSourceSubset(process.cwd(), async (file) => {
                const bytes = await read(file);
                if (file === path.join(process.cwd(), target.path)) throw Error('Missing source');
                return bytes;
            }),
            /Missing source/,
        );
    }
    await assert.rejects(verifyCurrentSourceSubset('relative'), /absolute/);
    await assert.rejects(verifyCurrentSourceSubset(path.resolve('tests/fixtures')));
    await assert.rejects(
        verifyCurrentSourceSubset(await historicalProductSourceRoot()),
        /preimage changed/,
    );
    await assert.rejects(
        verifyCurrentSourceSubset(process.cwd(), async () => 'not bytes' as any),
        /preimage changed/,
    );
});

test('v2 refuses missing, inherited, unassessed, mixed-version and promoted binding or receipt claims', async () => {
    const binding = await verifyCurrentSourceSubset(
        process.cwd(),
        retainedPageReader(process.cwd()),
    );
    const receipt = sourceSubsetReceipt(binding);
    for (const key of Object.keys(binding)) {
        const missing = { ...binding } as Record<string, unknown>;
        delete missing[key];
        assert.throws(() => validateCurrentSourceSubsetBinding(missing));
        assert.throws(() =>
            validateCurrentSourceSubsetBinding(
                Object.assign(
                    Object.create({ [key]: binding[key as keyof typeof binding] }),
                    missing,
                ),
            ),
        );
    }
    for (const patch of [
        { version: 1 },
        { manifestSHA256: '0'.repeat(64) },
        { sourceCommit: historical.sourceCommit },
        { realm: 'native' },
        { realm: 'gateway' },
        { scope: 'native-owner-snapshot-and-terminal-downloads' },
        { completeDependencyClosure: true },
        { nativeAdmission: true },
        { runtimeAttestation: true },
        { production: historical.sourceCommit },
        { protocol: 1 },
        { pins: { ...binding.pins, extra: '0'.repeat(64) } },
    ])
        assert.throws(() => validateCurrentSourceSubsetBinding({ ...binding, ...patch }));
    for (const file of Object.keys(binding.pins)) {
        const missing = { ...binding.pins };
        delete missing[file];
        for (const pins of [missing, { ...binding.pins, [file]: '0'.repeat(64) }])
            assert.throws(() => validateCurrentSourceSubsetBinding({ ...binding, pins }));
    }
    for (const patch of [
        { disposition: 'native-retired' },
        { sourceFiles: 25 },
        { runtimeAttestation: true },
        { nativeAdmission: true },
        { verified: true },
        { sourceMain: nativeMainSourcePins['electron/main.ts'] },
        { binding: { ...binding, version: 1 } },
    ])
        assert.throws(() => verifySourceSubsetReceipt({ ...receipt, ...patch }, binding));
    assert.throws(() => verifySourceSubsetReceipt(receipt, { ...binding, realm: 'native' }));
    assert.throws(() => validateHostBinding(binding, 'native'));
    assert.throws(() => validateHostBinding(binding, 'gateway'));
    assert.throws(() => nativeObserverBuildPlugin(process.cwd(), binding, 'ssh2'));
    assert.throws(() => assertNativeMainRetired(receipt));
});

test('retained e5 exact-source data confirms unique insertion boundaries without generating a runtime observer', async () => {
    const read = retainedPageReader(process.cwd());
    await verifyCurrentSourceSubset(process.cwd(), read);
    const checks: [string, string[]][] = [
        [
            'electron/main.ts',
            [
                "    app.on('window-all-closed', () => app.quit());",
                '        return (captureHostPromise ??= NativeCaptureHost.open(',
                '        }));\n    };\n    const resetCaptureRenderer',
            ],
        ],
        [
            'src/features/automation/AutomationPage.tsx',
            [
                '    latest.current = props;',
                '    const start = async (once = false) => {',
                '    };\n    const edit = (id: string, patch: Partial<CommandStep>) =>',
            ],
        ],
        [
            'src/features/automation/capture/browser-export.ts',
            [
                '    return new Promise((resolve, reject) => {',
                '    });\n}\nexport interface BrowserExportDiagnostic {',
            ],
        ],
        ['electron/capture-host.ts', ['export class NativeCaptureHost {']],
        ['electron/automation-activity.ts', ['export class AutomationActivity {']],
    ];
    const clauses: Record<string, string> = {
        IndexedDbCaptureStore: ' implements CaptureRepository',
        NativeCaptureRepository: ' implements CaptureRepository',
        IndexedDbConsoleJournal: ' implements ConsoleRepository, ConsoleArchive',
        GatewayClient: ' implements TerminalTransport',
    };
    for (const [file, name] of productProbePreimages)
        checks.push([file, [`export class ${name}${clauses[name] ?? ''} {`]]);
    for (const [file, boundaries] of checks) {
        const bytes = await read(path.resolve(file));
        assert.equal(
            createHash('sha256').update(bytes).digest('hex'),
            currentProductSourceManifest.files.find((row) => row.path === file)?.sha256,
        );
        const source = bytes.toString();
        for (const boundary of boundaries) assert.equal(source.split(boundary).length, 2, file);
    }
});

test('immutable e5 source subset refuses the live newer Page through its default reader', async () => {
    const file = path.resolve(retainedPageSource.path);
    const live = await fs.readFile(file);
    assert.notEqual(createHash('sha256').update(live).digest('hex'), retainedPageSource.sha256);
    await assert.rejects(
        verifyCurrentSourceSubset(process.cwd()),
        /Current source-subset preimage changed: src\/features\/automation\/AutomationPage\.tsx/,
    );
});

// A newer source-only subset does not rebind or admit either historical runtime observer.
test('immutable afd source subset and e9 runtime observer refuse this newer source', async () => {
    const afd = await import('./fixtures/memory-product-current-source');
    await assert.rejects(afd.verifyCurrentSourceSubset(process.cwd()), /preimage changed/);
    const observer = await import('./fixtures/memory-product-current-observer');
    await assert.rejects(observer.verifyNativeMainSources(process.cwd()), /preimage/);
});

test('retained e9 Gateway source guards still admit unchanged source and reject mutation', async () => {
    const current = await import('./fixtures/memory-product-current-observer');
    const binding = await current.verifyProductHostSources(process.cwd(), 'gateway');
    assert.equal(binding.production, 'e9bb9bc2c599fc47f7f422d7dcae291337b55478');
    for (const name of Object.keys(current.hostPins('gateway'))) {
        await assert.rejects(
            current.verifyProductHostSources(process.cwd(), 'gateway', async (file) => {
                const raw = await fs.readFile(file, 'utf8');
                return file === path.join(process.cwd(), name) ? raw + '\n' : raw;
            }),
            /preimage/,
        );
    }
});

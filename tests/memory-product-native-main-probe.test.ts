import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeMainSourcePins, verifyNativeMainSources, transformNativeOwnedSource } from './fixtures/memory-product-native-main-transform';
import { hostPins } from './fixtures/memory-product-host-ownership';
import { nativeMainPreimage } from './fixtures/memory-product-native-main-state';
const binding = { protocol: 1, production: '96a56cdbb462320c54fe74022d7436e665a31d31', realm: 'native', pins: hostPins('native') };

test('reviewed native main/dependency preimages admit only exact current source', async () => {
    assert.equal(nativeMainSourcePins['electron/main.ts'], nativeMainPreimage);
    await verifyNativeMainSources(process.cwd());
    for (const file of Object.keys(nativeMainSourcePins)) {
        const source = await fs.readFile(file, 'utf8');
        assert.ok(transformNativeOwnedSource(source, file, binding));
        for (const changed of [source + '\n', source.replace(/[A-Za-z]/, c => c === 'X' ? 'Y' : 'X')])
            assert.throws(() => transformNativeOwnedSource(changed, file, binding), /preimage/);
        await assert.rejects(verifyNativeMainSources(process.cwd(), async name => {
            const value = await fs.readFile(name, 'utf8'); return name === path.resolve(file) ? value + '\n' : value;
        }), /preimage/);
    }
    assert.throws(() => transformNativeOwnedSource('', 'unknown.ts', binding));
    await assert.rejects(verifyNativeMainSources('relative'));
});

test('main observation inverse preserves production admission, update and quit code byte-for-byte', async () => {
    const source = await fs.readFile('electron/main.ts', 'utf8');
    const value = transformNativeOwnedSource(source, 'electron/main.ts', binding);
    const original = value.code.slice(value.importPrefix.length).replace(value.observation + '\n', '')
        .replace('        return (captureHostPromise ??= __memoryCaptureOpening.run(() => NativeCaptureHost.open(',
            '        return (captureHostPromise ??= NativeCaptureHost.open(')
        .replace('        })));\n    };\n    const resetCaptureRenderer', '        }));\n    };\n    const resetCaptureRenderer');
    assert.equal(original, source);
    assert.match(value.observation, /__memoryObserveMain\(\{quit,captureOpening:/);
    assert.match(value.observation, /reportExports,updateOwnership,ownsProfile/);
    assert.match(value.observation, /__memoryAssertShutdown\(value.snapshot/);
    assert.match(value.observation, /app.on\('will-quit',__memoryNativeQuit.observeWillQuit\)/);
    assert.ok(value.observation.includes('item.setSavePath(row.file)'));
    assert.ok(value.observation.includes('readFault:'));
    assert.ok(value.observation.includes('prepareReport(file:string)'));
    assert.throws(() => transformNativeOwnedSource(value.code, 'electron/main.ts', binding));
    assert.throws(() => transformNativeOwnedSource(source, 'electron/main.ts', { ...binding, realm: 'gateway' }));
    for (const file of ['electron/capture-host.ts', 'electron/automation-activity.ts']) {
        const raw = await fs.readFile(file, 'utf8'), transformed = transformNativeOwnedSource(raw, file, binding);
        assert.equal(transformed.code.replace(transformed.observation, ''), raw);
        assert.throws(() => transformNativeOwnedSource(transformed.code, file, binding));
    }
});

test('private native adapter verifies dependencies before output and applies reviewed transformations at build reads', async () => {
    const source = await fs.readFile('tests/fixtures/memory-product-native-host.ts', 'utf8');
    assert.ok(source.indexOf('await verifyNativeMainSources(sourceRoot)') < source.indexOf('await fs.mkdir(desktop'));
    const plugin = await fs.readFile('tests/fixtures/memory-product-native-build-plugin.ts', 'utf8');
    assert.ok(plugin.includes('Object.hasOwn(nativeMainSourcePins, file)'));
    assert.ok(plugin.includes('transformNativeOwnedSource(source, file, accepted).code'));
    assert.ok(source.includes('await prepareNativeBuild('));
    assert.ok(source.includes('if (observation.error) throw Error(observation.error)'));
    assert.ok(!source.includes('005de35d840bcc87567c4530677359986886137c293eb79327305bd6b25c1a9d'));
});

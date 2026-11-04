import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareNativeBuild, type NativeBuildPorts } from './fixtures/memory-product-native-preparation';
import { nativeObserverBuildPlugin } from './fixtures/memory-product-native-build-plugin';
import { hostPins } from './fixtures/memory-product-host-ownership';
const names = ['verify', 'directories', 'renderer', 'main', 'syntax', 'metadata'] as const;
function fixture() {
    const calls: string[] = [];
    const ports = Object.fromEntries(names.map(name => [name, async () => { calls.push(name); }])) as unknown as NativeBuildPorts;
    ports.admit = () => { calls.push('admit'); };
    return { calls, ports };
}
test('explicit preparation sequences verified builds and returns without a runtime capability', async () => {
    const f = fixture(), value = await prepareNativeBuild(f.ports);
    assert.deepEqual(value, { scope: 'private-build-only', runtimeStarted: false });
    assert.deepEqual(f.calls.filter(name => name !== 'admit'), names);
    let executed = false;
    await assert.rejects(prepareNativeBuild({ ...fixture().ports, launch() { executed = true; } } as NativeBuildPorts), /capability/);
    assert.equal(executed, false);
    for (const extra of ['network', 'package', 'server', 'runtime', 'cleanup'])
        await assert.rejects(prepareNativeBuild({ ...fixture().ports, [extra]: () => {} } as NativeBuildPorts));
});
test('preflight and every build failure stop dependent steps and preserve the original failure', async () => {
    for (const stage of names) {
        const f = fixture(), failure = Error('Synthetic ' + stage);
        f.ports[stage] = async () => { f.calls.push(stage); throw failure; };
        await assert.rejects(prepareNativeBuild(f.ports), error => error === failure);
        assert.deepEqual(f.calls.filter(name => name !== 'admit'), names.slice(0, names.indexOf(stage) + 1));
    }
    const f = fixture(); f.ports.admit = () => { throw Error('Admission closed'); };
    await assert.rejects(prepareNativeBuild(f.ports)); assert.deepEqual(f.calls, []);
});
test('native compiler plugin guards actual source and keeps SSH external without loading it', async () => {
    const binding = { protocol: 1, production: '96a56cdbb462320c54fe74022d7436e665a31d31', realm: 'native', pins: hostPins('native') };
    let resolve!: (args: any) => any, load!: (args: any) => any;
    const plugin = nativeObserverBuildPlugin(process.cwd(), binding, 'ssh2');
    plugin.setup({ onResolve(_options: unknown, callback: typeof resolve) { resolve = callback; },
        onLoad(_options: unknown, callback: typeof load) { load = callback; } } as any);
    assert.deepEqual(resolve({ path: 'ssh2' }), { path: 'ssh2', external: true });
    const transformed = await load({ path: path.resolve('electron/main.ts') });
    assert.ok(transformed.contents.includes('__memoryCreateQuitObserver'));
    assert.equal(await load({ path: '/outside/unknown.ts' }), undefined);
    assert.throws(() => nativeObserverBuildPlugin('relative', binding, 'ssh2'));
    assert.throws(() => nativeObserverBuildPlugin(process.cwd(), binding, './unverified-ssh'));
    assert.throws(() => nativeObserverBuildPlugin(process.cwd(), { ...binding, realm: 'gateway' }, 'ssh2'));
});
test('preparation import/effect surface excludes runtime and combined creator invokes it before launch', async () => {
    const source = await fs.readFile('tests/fixtures/memory-product-native-preparation.ts', 'utf8');
    assert.ok(!/^import /m.test(source));
    const host = await fs.readFile('tests/fixtures/memory-product-native-host.ts', 'utf8');
    assert.ok(host.indexOf('await prepareNativeBuild(') < host.indexOf('await _electron.launch('));
    assert.ok(host.includes('plugins: [nativeObserverBuildPlugin(sourceRoot, hostBinding, profile.sshEntry)]'));
});

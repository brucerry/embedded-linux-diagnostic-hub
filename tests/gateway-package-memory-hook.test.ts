import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
    gatewayPackageMemoryHook,
    type GatewayPackageMemoryPorts,
} from './fixtures/gateway-package-memory-hook';

const probe = pathToFileURL(path.resolve('tests/fixtures/gateway-package-memory-probe.mjs'));
let sequence = 0;
function prepare() {
    const id = ++sequence;
    const key = '__gatewayPackageLockTest' + id;
    const target = probe.href + '?case=' + id;
    let calls = 0;
    const ports = Object.fromEntries(
        [
            'readFile',
            'writeFile',
            'mkdtemp',
            'mkdir',
            'cp',
            'rm',
            'realpath',
            'lstat',
            'open',
            'spawnSync',
            'tmpdir',
        ].map((name) => [
            name,
            () => {
                calls++;
                assert.fail('Inert probe called ' + name);
            },
        ]),
    ) as unknown as GatewayPackageMemoryPorts;
    (globalThis as any)[key] = ports;
    const hook = gatewayPackageMemoryHook(target, key, ports);
    return { key, target, ports, hook, calls: () => calls };
}

test('ordinary loader binds every inert probe export to the supplied memory port', async () => {
    const p = prepare();
    const hooks = registerHooks(p.hook);
    try {
        const value = await import(p.target);
        assert.deepEqual(Object.keys(value.observedPorts).sort(), Object.keys(p.ports).sort());
        for (const name of Object.keys(p.ports))
            assert.equal(value.observedPorts[name], p.ports[name as keyof typeof p.ports]);
        assert.equal(p.calls(), 0);
    } finally {
        hooks.deregister();
        delete (globalThis as any)[p.key];
    }
});

test('wrong parent, aliases and unreviewed effects never reach the fallback resolver', () => {
    const p = prepare();
    let fallback = 0;
    const next = () => {
        fallback++;
        assert.fail('Effectful fallback was reached');
    };
    try {
        for (const specifier of ['node:fs/promises', 'node:child_process', 'node:os'])
            for (const parentURL of [
                undefined,
                p.target.replace('?case=', '?foreign='),
                p.target + '&tsx=changed',
            ])
                assert.throws(
                    () =>
                        p.hook.resolve!(
                            specifier,
                            { parentURL, conditions: [], importAttributes: {} },
                            next,
                        ),
                    /Unadmitted effectful import parent/,
                );
        for (const specifier of [
            'fs',
            'fs/promises',
            'child_process',
            'os',
            'node:fs',
            'node:net',
            'node:worker_threads',
            'node:module',
        ])
            assert.throws(
                () =>
                    p.hook.resolve!(
                        specifier,
                        { parentURL: p.target, conditions: [], importAttributes: {} },
                        next,
                    ),
                /Unadmitted effectful import/,
            );
        assert.throws(
            () =>
                p.hook.resolve!(
                    'foreign-package',
                    { parentURL: p.target, conditions: [], importAttributes: {} },
                    next,
                ),
            /Unreviewed packaging script import/,
        );
        assert.equal(fallback, 0);
        assert.equal(p.calls(), 0);
    } finally {
        delete (globalThis as any)[p.key];
    }
});

test('actual loader refuses effect imports from an inert foreign module', async () => {
    const p = prepare();
    const hooks = registerHooks(p.hook);
    try {
        for (const specifier of ['node:fs/promises', 'node:child_process', 'fs/promises']) {
            const foreign =
                'data:text/javascript,' +
                encodeURIComponent(`export * from ${JSON.stringify(specifier)};\n// case ${p.key}`);
            await assert.rejects(import(foreign), /Unadmitted effectful import parent/);
        }
        assert.equal(p.calls(), 0);
    } finally {
        hooks.deregister();
        delete (globalThis as any)[p.key];
    }
});

test('missing or replaced memory ports refuse admission without registering hooks', () => {
    const p = prepare();
    try {
        const incomplete = { ...p.ports };
        delete (incomplete as any).spawnSync;
        (globalThis as any)[p.key] = incomplete;
        assert.throws(() => gatewayPackageMemoryHook(p.target, p.key, incomplete));
        (globalThis as any)[p.key] = {};
        assert.throws(() => gatewayPackageMemoryHook(p.target, p.key, p.ports));
        assert.throws(
            () =>
                p.hook.resolve!(
                    'node:fs/promises',
                    { parentURL: p.target, conditions: [], importAttributes: {} },
                    () => assert.fail('fallback'),
                ),
            /Memory ports lost custody/,
        );
        assert.equal(p.calls(), 0);
    } finally {
        delete (globalThis as any)[p.key];
    }
});

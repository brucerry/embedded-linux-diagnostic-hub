import assert from 'node:assert/strict';
import type { ResolveHookSync } from 'node:module';

const exportsByModule = {
    'node:fs/promises': [
        'readFile',
        'writeFile',
        'mkdtemp',
        'mkdir',
        'cp',
        'rm',
        'realpath',
        'lstat',
        'open',
    ],
    'node:child_process': ['spawnSync'],
    'node:os': ['tmpdir'],
} as const;
type PortName = (typeof exportsByModule)[keyof typeof exportsByModule][number];
export type GatewayPackageMemoryPorts = Record<PortName, (...args: any[]) => any>;
const effectful = new Set([
    'fs',
    'fs/promises',
    'child_process',
    'os',
    'net',
    'http',
    'http2',
    'https',
    'dgram',
    'dns',
    'dns/promises',
    'tls',
    'worker_threads',
    'cluster',
    'inspector',
    'inspector/promises',
    'vm',
    'module',
    'process',
    'readline',
    'readline/promises',
    'repl',
]);
const scriptImports = new Set([
    'node:assert/strict',
    'node:zlib',
    'node:path',
    './lib/gateway-lock-plan.mjs',
    './lib/gateway-tar.mjs',
    './lib/stable-artifact-file.mjs',
    './lib/web-archive-limits.mjs',
]);

// Test-only synchronous hook. An unmatched effectful import must never delegate
// to the ordinary loader: that could give the shipping CLI real filesystem/npm ports.
export function gatewayPackageMemoryHook(
    target: string,
    key: string,
    ports: GatewayPackageMemoryPorts,
): { resolve: ResolveHookSync } {
    const url = new URL(target);
    assert.equal(url.protocol, 'file:');
    assert.ok(!url.hash && /^\?case=[1-9][0-9]*$/.test(url.search));
    assert.match(key, /^__gatewayPackageLockTest[1-9][0-9]*$/);
    assert.equal((globalThis as any)[key], ports);
    const names = Object.values(exportsByModule).flat().sort();
    assert.deepEqual(Object.keys(ports).sort(), names);
    for (const name of names) assert.equal(typeof ports[name], 'function');
    return {
        resolve(specifier, context, nextResolve) {
            const builtin = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
            if (effectful.has(builtin)) {
                assert.equal(context.parentURL, target, 'Unadmitted effectful import parent.');
                assert.ok(
                    Object.hasOwn(exportsByModule, specifier),
                    'Unadmitted effectful import.',
                );
                const names = exportsByModule[specifier as keyof typeof exportsByModule];
                assert.equal((globalThis as any)[key], ports, 'Memory ports lost custody.');
                return {
                    url:
                        'data:text/javascript,' +
                        encodeURIComponent(
                            names
                                .map(
                                    (name) =>
                                        `export const ${name} = globalThis[${JSON.stringify(key)}].${name};`,
                                )
                                .join('\n'),
                        ),
                    shortCircuit: true,
                };
            }
            if (context.parentURL === target)
                assert.ok(scriptImports.has(specifier), 'Unreviewed packaging script import.');
            return nextResolve(specifier, context);
        },
    };
}

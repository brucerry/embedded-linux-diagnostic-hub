import assert from 'node:assert/strict';
import test from 'node:test';
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
    createShippingGatewayResolver,
    assertShippingGatewayLifetime,
} from './fixtures/shipping-gateway-resolver.mjs';

const root = '/owned/gateway';
const paths = [
    'ssh2/lib/index.js',
    'asn1/lib/index.js',
    'bcrypt-pbkdf/index.js',
    'safer-buffer/safer.js',
    'tweetnacl/nacl-fast.js',
    'ssh2/lib/protocol/constants.js',
    'ssh2/lib/protocol/crypto.js',
    'ssh2/lib/protocol/utils.js',
    'ssh2/package.json',
];
const files = paths.map((p) => ({ path: 'node_modules/' + p, sha256: 'a'.repeat(64) }));
const url = (p: string) => pathToFileURL(root + '/' + p).href;
function fixture(change: any = {}) {
    let hook: any;
    let violations = 0,
        deregisters = 0;
    const owner = createShippingGatewayResolver(root, files, {
        isBuiltin,
        onFailure() {
            violations++;
        },
        registerHooks(h: any) {
            hook = h.resolve;
            return {
                deregister() {
                    deregisters++;
                },
            };
        },
        ...change,
    });
    const resolve = (
        specifier: string,
        parent = 'dist-gateway/main.cjs',
        next: any = () => {
            throw Error('Ancestor lookup was attempted');
        },
    ) => hook(specifier, { parentURL: url(parent) }, next);
    return { owner, resolve, violations: () => violations, deregisters: () => deregisters };
}
test('required bare entries resolve directly without ancestor lookup or native hook execution', () => {
    const f = fixture();
    assert.deepEqual(f.resolve('ssh2'), {
        url: url('node_modules/ssh2/lib/index.js'),
        format: 'commonjs',
        shortCircuit: true,
    });
    f.owner.assertActive();
    assert.equal(f.owner.snapshot().releaseAcceptance, false);
});
test('only exact admitted relative file and canonical builtin results are accepted', () => {
    const f = fixture();
    assert.equal(
        f.resolve('./utils.js', 'node_modules/ssh2/lib/protocol/crypto.js', () => ({
            url: url('node_modules/ssh2/lib/protocol/utils.js'),
            format: 'commonjs',
        })).format,
        'commonjs',
    );
    assert.equal(
        f.resolve('fs', 'node_modules/ssh2/lib/protocol/crypto.js', () => ({
            url: 'node:fs',
            format: 'builtin',
        })).url,
        'node:fs',
    );
});
for (const [specifier, parent] of [
    ['cpu-features', 'node_modules/ssh2/lib/protocol/constants.js'],
    ['./crypto/build/Release/sshcrypto.node', 'node_modules/ssh2/lib/protocol/crypto.js'],
])
    test('the exact reviewed optional probe ' + specifier + ' is omitted before resolution', () => {
        const f = fixture();
        assert.throws(() => f.resolve(specifier, parent), { code: 'MODULE_NOT_FOUND' });
        f.owner.assertActive();
        assert.equal(f.owner.snapshot().optionalOmissions, 1);
        assert.throws(() => f.resolve(specifier, parent));
        assert.equal(f.owner.snapshot().failed, true);
    });
for (const [name, specifier, parent, result] of [
    ['unknown bare import', 'foreign-package', 'node_modules/ssh2/lib/index.js', null],
    ['wrong optional caller', 'cpu-features', 'node_modules/ssh2/lib/index.js', null],
    [
        'unadmitted same-root file',
        './unknown.js',
        'node_modules/ssh2/lib/index.js',
        { url: url('node_modules/ssh2/unknown.js') },
    ],
    [
        'outside file',
        './index.js',
        'node_modules/ssh2/lib/index.js',
        { url: 'file:///ancestor/node_modules/ssh2/lib/index.js' },
    ],
    [
        'native addon',
        './addon.node',
        'node_modules/ssh2/lib/index.js',
        { url: url('node_modules/ssh2/addon.node') },
    ],
    ['wrong parent', 'ssh2', 'outside.js', null],
    ['wrong builtin URL', 'fs', 'node_modules/ssh2/lib/index.js', { url: 'node:net' }],
    [
        'unknown format',
        './utils.js',
        'node_modules/ssh2/lib/protocol/crypto.js',
        { url: url('node_modules/ssh2/lib/protocol/utils.js'), format: 'module' },
    ],
] as const)
    test('resolver rejects ' + name, () => {
        const f = fixture();
        assert.throws(() => f.resolve(specifier, parent, () => result));
        assert.equal(f.owner.snapshot().failed, true);
        assert.throws(() => f.owner.assertActive());
    });
test('missing required relative import is a failure, not an optional probe', () => {
    const f = fixture();
    assert.throws(() =>
        f.resolve('./missing.js', 'node_modules/ssh2/lib/index.js', () => {
            throw Object.assign(Error('missing'), { code: 'MODULE_NOT_FOUND' });
        }),
    );
    assert.equal(f.owner.snapshot().failed, true);
});
test('async resolver return is retained as uncertain even after its promise resolves', async () => {
    const f = fixture();
    assert.throws(() =>
        f.resolve('./utils.js', 'node_modules/ssh2/lib/protocol/crypto.js', () =>
            Promise.resolve({ url: url('node_modules/ssh2/lib/protocol/utils.js') }),
        ),
    );
    await Promise.resolve();
    assert.equal(f.owner.snapshot().uncertain, true);
    assert.equal(f.owner.snapshot().unknown, 1);
});
test('unknown hook registration preserves the responsible guard owner', () => {
    assert.throws(
        () => fixture({ registerHooks: () => Promise.resolve({ deregister() {} }) }),
        (error: any) => error.owner.snapshot().uncertain === true,
    );
});
test('preparing closure never deregisters or proves namespace retirement', () => {
    const f = fixture();
    f.owner.prepareClose();
    f.owner.prepareClose();
    assert.equal(f.deregisters(), 0);
    assert.equal(f.owner.snapshot().namespaceRetirement, null);
    assert.equal(
        f.resolve('fs', 'node_modules/ssh2/lib/index.js', () => ({ url: 'node:fs' })).url,
        'node:fs',
    );
    assert.throws(() => f.resolve('ssh2'));
});
test('lifetime check accepts only synchronous void and releases that known lease', () => {
    const unknown = new Set();
    let calls = 0;
    assertShippingGatewayLifetime(
        (root: string) => {
            assert.equal(root, '/owned/gateway');
            calls++;
        },
        '/owned/gateway',
        unknown,
    );
    assert.equal(calls, 1);
    assert.equal(unknown.size, 0);
});
for (const mode of ['false', 'pending', 'resolved', 'rejected'])
    test('lifetime check retains unsupported ' + mode + ' before refusing', async () => {
        const unknown = new Set();
        assert.throws(() =>
            assertShippingGatewayLifetime(
                () =>
                    mode === 'false'
                        ? false
                        : mode === 'pending'
                          ? new Promise(() => {})
                          : mode === 'resolved'
                            ? Promise.resolve()
                            : Promise.reject(Error('authored lifetime failure')),
                '/owned/gateway',
                unknown,
            ),
        );
        await Promise.resolve();
        assert.equal(unknown.size, 1);
    });
test('throwing lifetime assertion preserves its original failure and unknown operation', () => {
    const unknown = new Set(),
        failure = Error('authored lifetime throw');
    assert.throws(
        () =>
            assertShippingGatewayLifetime(
                () => {
                    throw failure;
                },
                '/owned/gateway',
                unknown,
            ),
        (error) => error === failure,
    );
    assert.equal(unknown.size, 1);
});

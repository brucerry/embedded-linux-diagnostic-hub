import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

// The ordinary tsx test glob loads this wrapper in its own Node test process.
// Scope the alias to this one fixture and its two actual production importers.
const load = createRequire(__filename);
const resolve = (name: string) => realpathSync(load.resolve(name));
const installed = pathToFileURL(dirname(resolve('ssh2/package.json')) + '/').href;
for (const file of Object.keys(load.cache))
    assert.ok(!pathToFileURL(file).href.startsWith(installed), 'Real SSH2 was already loaded.');
const memory = resolve('./fixtures/ssh-memory-client.ts');
const cases = resolve('./fixtures/ssh-late-channel-cases.ts');
const importers = [
    cases,
    resolve('../backend/ssh/session.ts'),
    resolve('../backend/ssh/owned-client.ts'),
];
for (const file of importers)
    assert.equal(load.cache[file], undefined, 'A scoped source module was already loaded.');
const parents = new Set(importers.map((file) => pathToFileURL(file).href));
const self = pathToFileURL(realpathSync(__filename)).href;
const canary = 'diagnostic-hub-ssh-memory-loader-canary';
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === canary) {
            assert.equal(context.parentURL, self);
            return { url: pathToFileURL(memory).href, shortCircuit: true };
        }
        if (specifier === 'ssh2') {
            assert.ok(context.parentURL && parents.has(context.parentURL));
            return { url: pathToFileURL(memory).href, shortCircuit: true };
        }
        assert.ok(!specifier.startsWith('ssh2/'), 'SSH2 subpaths are outside this memory scope.');
        const resolved = nextResolve(specifier, context);
        assert.ok(!resolved.url.startsWith(installed), 'Real SSH2 is outside this memory scope.');
        return resolved;
    },
    load(url, context, nextLoad) {
        assert.ok(!url.startsWith(installed), 'Real SSH2 code must never load.');
        return nextLoad(url, context);
    },
});
try {
    // A missing/ignored hook fails before any production module can load real SSH2.
    assert.equal(load(canary).Client, load(memory).Client);
    load(cases);
} finally {
    hooks.deregister();
}

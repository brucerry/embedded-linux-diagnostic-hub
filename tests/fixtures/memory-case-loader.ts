import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const groups = {
    ssh: {
        cases: ['desktop-connection-retirement', 'desktop-console-retirement-memory'],
        source: ['backend/ssh/session.ts', 'backend/ssh/owned-client.ts'],
        target: 'ssh-memory-client.ts',
        aliases: ['ssh2'],
    },
    'owned-fs': {
        cases: [
            'updater-owned-lifetime-memory',
            'updater-owned-marker-memory',
            'update-acquisition-retirement-memory',
        ],
        source: [
            'electron/updates.ts',
            'electron/update-owned-file.ts',
            'electron/update-reports.ts',
            'electron/update-receipt.ts',
        ],
        target: 'update-owned-memory.ts',
        aliases: ['node:fs/promises', 'fs/promises'],
    },
    'updater-fs': {
        cases: ['updater-cache-failure-memory', 'updater-coordinator-memory'],
        source: ['electron/updates.ts', 'electron/update-owned-file.ts'],
        target: 'updater-memory-io.ts',
        aliases: ['node:fs/promises', 'fs/promises', 'node:fs', 'fs'],
    },
} as const;

// Ordinary Node test files run in separate processes. This installs aliases only while
// their unchanged case modules and fixed production importers are loaded synchronously.
// Missing hooks/foreign source importers fail before any memory case can use real IO.
export function loadMemoryCases(casesURL: URL, group: keyof typeof groups) {
    const load = createRequire(import.meta.url);
    const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
    const selected = groups[group];
    const cases = realpathSync(fileURLToPath(casesURL));
    assert.ok(
        selected.cases.some(
            (name) => cases === realpathSync(resolvePath(root, 'tests', name + '.cases.ts')),
        ),
    );
    const source = [cases, ...selected.source.map((file) => realpathSync(resolvePath(root, file)))];
    for (const file of source)
        assert.equal(load.cache[file], undefined, 'Scoped source was already loaded.');
    const parents = new Set(source.map((file) => pathToFileURL(file).href));
    const target = realpathSync(
        resolvePath(dirname(fileURLToPath(import.meta.url)), selected.target),
    );
    const targetURL = pathToFileURL(target).href;
    const self = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    const rootURL = pathToFileURL(root + '/').href;
    const aliases = new Set<string>(selected.aliases);
    const sshRoot =
        group === 'ssh'
            ? pathToFileURL(dirname(realpathSync(load.resolve('ssh2/package.json'))) + '/').href
            : null;
    if (sshRoot)
        for (const file of Object.keys(load.cache))
            assert.ok(
                !pathToFileURL(file).href.startsWith(sshRoot),
                'Real SSH2 was already loaded.',
            );
    const canary = 'diagnostic-hub-scoped-memory-case-canary';
    const caseAliases = new Set<string>();
    const caseParent = pathToFileURL(cases).href;
    const filesystemSpecifiers = new Set(['node:fs/promises', 'fs/promises', 'node:fs', 'fs']);
    const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === canary) {
                assert.equal(context.parentURL, self);
                return { url: targetURL, shortCircuit: true };
            }
            if (aliases.has(specifier)) {
                if (context.parentURL && parents.has(context.parentURL)) {
                    if (context.parentURL === caseParent) caseAliases.add(specifier);
                    return { url: targetURL, shortCircuit: true };
                }
                assert.ok(
                    !context.parentURL?.startsWith(rootURL),
                    'Unaudited source requested a scoped IO alias.',
                );
                if (group === 'ssh') assert.fail('SSH2 is outside this memory case scope.');
            }
            if (group !== 'ssh' && filesystemSpecifiers.has(specifier))
                assert.ok(
                    !context.parentURL?.startsWith(rootURL),
                    'Real filesystem IO is outside this memory case scope.',
                );
            if (sshRoot)
                assert.ok(
                    !specifier.startsWith('ssh2/'),
                    'SSH2 subpaths are outside this memory scope.',
                );
            const resolved = nextResolve(specifier, context);
            if (sshRoot)
                assert.ok(
                    !resolved.url.startsWith(sshRoot),
                    'Real SSH2 is outside this memory scope.',
                );
            return resolved;
        },
        load(url, context, nextLoad) {
            if (sshRoot) assert.ok(!url.startsWith(sshRoot), 'Real SSH2 code must never load.');
            return nextLoad(url, context);
        },
    });
    try {
        assert.strictEqual(load(canary), load(target), 'The memory loader hook was ignored.');
        load(cases);
        const required =
            group === 'ssh'
                ? ['ssh2']
                : group === 'owned-fs'
                  ? ['node:fs/promises']
                  : ['node:fs/promises', 'node:fs'];
        for (const specifier of required)
            assert.ok(
                caseAliases.has(specifier),
                'A required case alias was not applied: ' + specifier,
            );
    } finally {
        hooks.deregister();
    }
}

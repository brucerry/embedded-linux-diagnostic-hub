import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { physicalFS } from '../electron/physical-fs';

const load = createRequire(import.meta.url);
test('ordinary Node uses the physical native filesystem without an Electron dependency', () => {
    assert.equal(process.versions.electron, undefined);
    assert.equal(physicalFS.lstatSync, fs.lstatSync);
    assert.equal(physicalFS.promises, fs.promises);
});

for (const mode of ['application', 'node'] as const) {
    test(
        `actual Electron ${mode} mode keeps setup physical and application archives virtual`,
        {
            skip:
                process.env.DIAGNOSTIC_HUB_TEST_ELECTRON_PHYSICAL_FS !== '1'
                    ? 'Opt in to the installed Electron runtime regression.'
                    : false,
            timeout: 60000,
        },
        async () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-physical-fs-'));
            const members = path.join(home, 'archive-members');
            const resources = path.join(home, 'source', 'resources');
            fs.mkdirSync(members, { recursive: true });
            fs.mkdirSync(resources, { recursive: true });
            fs.writeFileSync(path.join(members, 'inside.txt'), 'archive member');
            // Reuse the package already present in the pinned desktop build toolchain.
            const asar = load('@electron/asar') as {
                createPackage(source: string, target: string): Promise<void>;
            };
            await asar.createPackage(members, path.join(resources, 'app.asar'));
            const script = path.join(home, 'probe.cjs');
            await build({
                entryPoints: [path.resolve('tests/fixtures/physical-fs-electron.ts')],
                outfile: script,
                bundle: true,
                platform: 'node',
                format: 'cjs',
                external: ['electron'],
            });
            const env = { ...process.env };
            delete env.ELECTRON_RUN_AS_NODE;
            if (mode === 'node') env.ELECTRON_RUN_AS_NODE = '1';
            const child = spawnSync(load('electron') as string, [script, home], {
                env,
                encoding: 'utf8',
                timeout: 45000,
                windowsHide: true,
            });
            const resultFile = path.join(home, 'result.json');
            const result = fs.existsSync(resultFile)
                ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
                : null;
            assert.equal(
                child.error,
                undefined,
                JSON.stringify({ home, result, error: child.error?.message }),
            );
            assert.equal(
                child.signal,
                null,
                JSON.stringify({ home, result, signal: child.signal }),
            );
            assert.equal(child.status, 0, JSON.stringify({ home, result, stderr: child.stderr }));
            assert.equal(result.electron, load('electron/package.json').version);
            assert.equal(result.checks.length, 12);
            assert.equal(result.runAsNode, mode === 'node');
            assert.equal(result.noAsar, false);
            console.log(JSON.stringify({ mode, home, result }));
        },
    );
}

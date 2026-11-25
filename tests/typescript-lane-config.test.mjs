import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const json = (name) => JSON.parse(readFileSync(name, 'utf8'));
const tsc = require.resolve('typescript/bin/tsc');
const input = './.linux-package-inputs/electron.d.ts';
const config = (name) =>
    JSON.parse(
        execFileSync(process.execPath, [tsc, '--showConfig', '--project', name], {
            encoding: 'utf8',
        }),
    );

test('only the Linux producer requires the staged Electron declaration', () => {
    const shared = config('tsconfig.json');
    const linux = config('tsconfig.linux.json');
    assert.equal(shared.files.includes(input), false);
    assert.equal(linux.files.filter((name) => name === input).length, 1);
    assert.deepEqual(linux.files.filter((name) => name !== input).sort(), shared.files.sort());
    assert.deepEqual(linux.compilerOptions, shared.compilerOptions);
    assert.equal(json('package.json').scripts.typecheck, 'tsc --noEmit');
    assert.equal(
        json('scripts/ci/linux-package-lane/package.json').scripts.typecheck,
        'tsc --noEmit --project tsconfig.linux.json',
    );
});

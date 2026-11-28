import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

test('native identity starts without the external TypeScript loader, keeping real executable and sandbox requirements', () => {
    const entry = readFileSync(new URL('./staged-artifact-native.mts', import.meta.url), 'utf8');
    const gate = readFileSync(new URL('../scripts/staged-artifact-gate.mjs', import.meta.url), 'utf8');
    const converted = stripTypeScriptTypes(entry, { mode: 'strip' });
    assert.match(gate, /\[node, '--experimental-strip-types', 'tests\/staged-artifact-native\.mts'\]/);
    assert.doesNotMatch(gate, /\[node, tsx, 'tests\/staged-artifact-native\.mts'\]/);
    assert.match(converted, /executablePath: executable/);
    assert.match(converted, /chromiumSandbox: true/);
    assert.match(converted, /typeof window\.diagnosticHub\?\.connect === 'function'/);
    assert.match(converted, /await termination/);
});

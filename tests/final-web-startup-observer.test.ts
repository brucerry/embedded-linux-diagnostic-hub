import assert from 'node:assert/strict';
import test from 'node:test';
import { startupEvidenceFixture, canonical, sha } from './fixtures/final-web-startup-memory.mjs';
import { validateFinalWebStartupObservation } from '../scripts/lib/final-web-startup-evidence.mjs';

async function facts() {
    const f = await startupEvidenceFixture(),
        value = await f.read('web/chromium-startup.json');
    return {
        f,
        value,
        expected: {
            ...f.expected,
            engine: 'chromium',
            browserVersion: 'synthetic-chromium',
            buildRecordSHA256: sha(f.files.get('web/web-build.json')),
        },
    };
}
test('current emitter and semantic reader require versioned zero-failure page lifecycle observations', async () => {
    const { f, value, expected } = await facts();
    assert.equal(value.schemaVersion, 2);
    assert.deepEqual(value.observations.pageState, {
        failedRequests: 0,
        crashes: 0,
        unexpectedClosures: 0,
        urlDrifts: 0,
        openAtCompletion: true,
        finalURLMatches: true,
    });
    assert.equal(
        validateFinalWebStartupObservation(value, f.record, expected).releaseAcceptance,
        false,
    );
});
for (const mode of [
    'old-version',
    'missing-state',
    'failedRequests',
    'crashes',
    'unexpectedClosures',
    'urlDrifts',
    'closed',
    'drift',
    'extra',
])
    test('semantic reader rejects rehashed startup evidence: ' + mode, async () => {
        const { f, value, expected } = await facts();
        if (mode === 'old-version') value.schemaVersion = 1;
        else if (mode === 'missing-state') delete value.observations.pageState;
        else if (mode === 'closed') value.observations.pageState.openAtCompletion = false;
        else if (mode === 'drift') value.observations.pageState.finalURLMatches = false;
        else if (mode === 'extra') value.observations.pageState.qualifying = true;
        else value.observations.pageState[mode] = 1;
        const bytes = canonical(value);
        assert.equal(sha(bytes).length, 64);
        assert.throws(() =>
            validateFinalWebStartupObservation(JSON.parse(bytes.toString()), f.record, expected),
        );
    });

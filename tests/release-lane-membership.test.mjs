import assert from 'node:assert/strict';
import test from 'node:test';
import { laneFiles, PLATFORM_LANES } from '../scripts/lib/staged-artifact-gate.mjs';
import { LINUX_ASSET, LINUX_ARCHIVE, releaseCatalog } from '../scripts/lib/release-assets.mjs';

test('Linux lane membership ignores linux- in release version text and remains inside the canonical catalog', () => {
    const expected = [
        ...[LINUX_ASSET, LINUX_ARCHIVE, 'download-run.sh'].flatMap((name) => [name, name + '.sha256']),
        'linux-build-info.json',
    ].sort();
    for (const version of ['0.5.2', '0.6.0-0', '0.6.0-linux-rc.1']) {
        assert.deepEqual(laneFiles(version, 'linux-x64'), expected, version);
        const catalog = releaseCatalog(version);
        for (const lane of PLATFORM_LANES)
            for (const name of laneFiles(version, lane.id))
                assert.ok(catalog.includes(name), `${version}/${lane.id}/${name}`);
    }
});

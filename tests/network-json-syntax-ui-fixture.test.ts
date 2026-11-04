import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../shared/report';
import { lanSummary } from '../shared/diagnostics/network/lan';
import { interfaceLabel } from '../shared/diagnostics/network/model';
import { lanJsonFixtures, maximumCounter, primaryAddress } from './fixtures/network-json-syntax-ui';
for (const fixture of lanJsonFixtures()) {
    test(`mounted LAN fixture survives actual report validation: ${fixture.phase}`, () => {
        const original = structuredClone(fixture.snapshot);
        const snapshot = parseReport(JSON.stringify(fixture.snapshot));
        const before = structuredClone(snapshot);
        const model = lanSummary(snapshot);
        assert.equal(
            snapshot.results.find((r) => r.id === fixture.sourceProbe)!.networkEvidence!.sections[0]
                .stdout,
            fixture.raw,
        );
        assert.deepEqual(model.warnings, fixture.warning ? [fixture.warning] : []);
        assert.deepEqual(
            model.interfaces.map(interfaceLabel),
            fixture.phase === 'malformed-link' ? [] : ['eth0 · ifindex 7'],
        );
        if (fixture.phase === 'address-fallback') {
            assert.equal(
                snapshot.results.find((r) => r.id === 'interfaces')!.stdout,
                primaryAddress,
            );
            assert(
                model.interfaces[0].groups.some((g) =>
                    g.fields.some(
                        (f) =>
                            f.label === 'Reported address' &&
                            f.value === primaryAddress.split('\n')[1].trim(),
                    ),
                ),
            );
        }
        if (fixture.phase === 'exact-counter') {
            assert.equal(
                model.interfaces[0].groups.find((g) => g.id === 'counters')!.fields[0].value,
                maximumCounter,
            );
        } else assert.throws(() => JSON.parse(fixture.raw), SyntaxError);
        assert.deepEqual(snapshot, before);
        assert.deepEqual(fixture.snapshot, original);
    });
}

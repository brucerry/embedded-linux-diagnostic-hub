import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { instrumentProductSource } from './fixtures/memory-product-instrument';
import { trackProductPageRefs, readProductPageRefs } from './fixtures/memory-product-page-refs';
test('Page observation reads the actual mutable refs and rejects absent/preimage drift', () => {
    assert.throws(() => readProductPageRefs(), /not been observed/);
    const inspection = { current: null as string | null },
        epoch = { current: 0 };
    trackProductPageRefs(inspection, epoch);
    assert.deepEqual(readProductPageRefs(), { inspectionId: null, activityEpoch: 0 });
    inspection.current = 'actual-arm';
    epoch.current = 2;
    trackProductPageRefs(inspection, epoch);
    assert.deepEqual(readProductPageRefs(), { inspectionId: 'actual-arm', activityEpoch: 2 });
    epoch.current = -1;
    assert.throws(() => readProductPageRefs(), /shape changed/);
    epoch.current = 2;
    const file = 'src/features/automation/AutomationPage.tsx',
        source = fs.readFileSync(file, 'utf8');
    assert.match(
        instrumentProductSource(source, '/' + file)!.code,
        /__observeProductPageRefs\(flowInspectionId, activityEpoch\)/,
    );
    assert.throws(() => instrumentProductSource(source + '\n', '/' + file), /preimage changed/);
});

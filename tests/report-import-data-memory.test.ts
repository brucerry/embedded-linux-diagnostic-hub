import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReport } from '../shared/report';
import { REPORT_IMPORT_A, REPORT_IMPORT_B, invalidReportImports } from './ui/fixtures/report-import-data';

test('report-import UI corpus admits historical partial evidence and rejects its three malformed replacements', () => {
    for (const input of [REPORT_IMPORT_A, REPORT_IMPORT_B]) {
        const content = JSON.stringify(input), before = structuredClone(input);
        assert.ok(Buffer.byteLength(content) < 4096);
        const parsed = parseReport(content);
        assert.equal(parsed.endpoint, input.endpoint);
        assert.equal(parsed.capturedAt, input.capturedAt);
        assert.deepEqual(parsed.results.find(row => row.id === 'identity'), input.results[0]);
        assert.equal(parsed.results.find(row => row.id === 'flash')?.status, 'unavailable');
        assert.match(parsed.results.find(row => row.id === 'flash')!.stderr, /not collected in the imported report/);
        assert.deepEqual(input, before);
    }
    const invalid = invalidReportImports();
    assert.equal(invalid.length, 3);
    for (const item of invalid) {
        assert.ok(Buffer.byteLength(item.content) < 4096);
        assert.throws(() => parseReport(item.content), error => error instanceof Error && error.message.includes(item.reason), item.kind);
    }
});

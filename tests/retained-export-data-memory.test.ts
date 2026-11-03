import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedExportRow, RETAINED_EXPORT_ROWS, RETAINED_EXPORT_MARKER, RETAINED_EXPORT_TIME } from './ui/fixtures/retained-export-data';
import { CAPTURE_STORAGE } from '../shared/capture-store';

test('retained-export corpus validates current headers/outcomes and has two off-page beyond-preview matches', () => {
    const rows = Array.from({ length: RETAINED_EXPORT_ROWS }, (_, index) => retainedExportRow(index));
    assert.equal(rows.length, 21);
    assert.equal(new Set(rows.map(row => row.header.runId)).size, 21);
    assert.equal(new Set(rows.map(row => row.outcome.id)).size, 21);
    assert.equal(new Set(rows.map(row => row.header.command)).size, 1);
    assert.deepEqual(rows.flatMap((row, index) => row.text.includes(RETAINED_EXPORT_MARKER) ? [index] : []), [0, 20]);
    for (const index of [0, 20]) {
        const row = rows[index], bytes = new TextEncoder().encode(row.text);
        assert.ok(bytes.length > CAPTURE_STORAGE.previewBytes && bytes.length < CAPTURE_STORAGE.frameBytes);
        assert.equal(new TextDecoder().decode(bytes.subarray(0, CAPTURE_STORAGE.previewBytes)).includes(RETAINED_EXPORT_MARKER), false);
        assert.equal(row.text, 'X'.repeat(9000) + '\r\n~~~\r\nEXPORT-BEYOND-PREVIEW | <raw> α\r\n');
        assert.equal(row.header.receiveTimeSource, 'local-client');
        assert.equal(row.header.startedAt, RETAINED_EXPORT_TIME);
        assert.equal(row.outcome.deviceTime, null);
        assert.equal(row.outcome.exitCode, null);
        assert.equal(row.outcome.completion, 'prompt-observed');
    }
    for (const index of [-1, 21, NaN, 0.5]) assert.throws(() => retainedExportRow(index), /fixture row/);
});

import assert from 'node:assert/strict';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Inspector returns JavaScript strings. Only byte-exact UTF-8 candidates can be compared;
 * all other regular files still belong to the complete installation identity inventory.
 * This does not assert that a candidate is JavaScript or that it was loaded.
 */
export function isExactInstrumentedText(bytes) {
    assert.ok(Buffer.isBuffer(bytes));
    try {
        return Buffer.from(decoder.decode(bytes)).equals(bytes);
    } catch {
        return false;
    }
}

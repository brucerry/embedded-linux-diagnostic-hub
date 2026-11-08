import assert from 'node:assert/strict';
import test from 'node:test';
import { downloaderTestCustody } from './fixtures/downloader-test-custody.ts';

test('unused downloader fixture has no attempted descendant custody', () => {
    assert.equal(downloaderTestCustody().canRemoveFixture(), true);
});
test('normal success and refusal validate without releasing downloader fixture custody', () => {
    for (const status of [0, 1, 255]) {
        const custody = downloaderTestCustody();
        const result = { status, signal: null };
        assert.equal(
            custody.run(() => result),
            result,
        );
        assert.equal(custody.canRemoveFixture(), false);
    }
});
for (const [name, delta] of [
    ['timeout error', { error: Error('ETIMEDOUT') }],
    ['spawn error', { error: Error('ENOENT') }],
    ['termination signal', { signal: 'SIGTERM' }],
    ['missing signal', { signal: undefined }],
    ['null status', { status: null }],
    ['missing status', { status: undefined }],
    ['negative status', { status: -1 }],
    ['oversized status', { status: 256 }],
    ['fractional status', { status: 1.5 }],
    ['NaN status', { status: Number.NaN }],
    ['infinite status', { status: Infinity }],
    ['string status', { status: '1' }],
] as const) {
    test(
        'downloader rejects ' + name + ' and retains uncertainty after a later normal exit',
        () => {
            const custody = downloaderTestCustody();
            assert.throws(() => custody.run(() => ({ status: 1, signal: null, ...delta })));
            assert.equal(custody.canRemoveFixture(), false);
            custody.run(() => ({ status: 0, signal: null }));
            assert.equal(custody.canRemoveFixture(), false);
        },
    );
}
test('downloader marks fixture custody before an invocation that throws', () => {
    const custody = downloaderTestCustody();
    const failure = Error('fake invocation failure');
    assert.throws(
        () =>
            custody.run(() => {
                assert.equal(custody.canRemoveFixture(), false);
                throw failure;
            }),
        (error) => error === failure,
    );
    assert.equal(custody.canRemoveFixture(), false);
});

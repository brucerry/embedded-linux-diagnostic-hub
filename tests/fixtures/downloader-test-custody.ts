import assert from 'node:assert/strict';

// Downloader tests have no descendant-closure proof. A direct exit never releases fixture custody.
export function downloaderTestCustody() {
    let attempted = false;
    return {
        run<T extends { error?: unknown; signal: unknown; status: unknown }>(invoke: () => T) {
            attempted = true;
            const result = invoke();
            assert.equal(result.error, undefined, 'Downloader subprocess error');
            assert.equal(result.signal, null, 'Downloader subprocess signal');
            assert.ok(
                typeof result.status === 'number' &&
                    Number.isInteger(result.status) &&
                    result.status >= 0 &&
                    result.status <= 255,
                'Downloader subprocess must have a valid exit status',
            );
            return result;
        },
        canRemoveFixture: () => !attempted,
    };
}

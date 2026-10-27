import assert from 'node:assert/strict';

/** Same-host monotonic work deadline; cleanup is deliberately not gated by this admission check. */
export function productStartup(input: { signal?: AbortSignal; workDeadlineMs?: number }) {
    if (input.workDeadlineMs !== undefined)
        assert.ok(Number.isSafeInteger(input.workDeadlineMs) && input.workDeadlineMs >= 0);
    return () => {
        input.signal?.throwIfAborted();
        if (input.workDeadlineMs !== undefined)
            assert.ok(
                Number(process.hrtime.bigint() / 1000000n) < input.workDeadlineMs,
                'Product startup work deadline exhausted; only cleanup may proceed.',
            );
    };
}

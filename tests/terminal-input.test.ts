import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalInputQueue } from '../src/features/terminal/input';
import { TERMINAL_QUEUE_BYTES } from '../shared/terminal';

test('terminal input batching preserves byte order, chunks pasted bytes and stops queued writes on close', async () => {
    const sent: Buffer[] = [];
    let release: (() => void) | undefined;
    const errors: string[] = [];
    const queue = new TerminalInputQueue(
        async (data) => {
            sent.push(Buffer.from(data, 'base64'));
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        },
        (message) => errors.push(message),
    );
    const bytes = Buffer.from('裝置'.repeat(4000));
    queue.push(bytes);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sent[0].length, 16384);
    queue.push(new Uint8Array(TERMINAL_QUEUE_BYTES));
    assert.equal(errors.length, 1);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.length, 2);
    assert.deepEqual(Buffer.concat(sent), bytes);
    queue.push(Buffer.from('never sent'));
    queue.close();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sent.length, 2);
});

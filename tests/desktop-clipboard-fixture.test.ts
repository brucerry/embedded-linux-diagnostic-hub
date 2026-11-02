import assert from 'node:assert/strict';
import test from 'node:test';
import { installDesktop } from './ui/fixtures/desktop';

test('desktop clipboard fixture owns one bounded held read without capturing later immediate reads', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const memoryWindow = {} as Window;
    Object.defineProperty(globalThis, 'window', { value: memoryWindow, configurable: true });
    try {
        const page = {
            async addInitScript(callback: (arg: unknown) => void, arg: unknown) {
                callback(arg);
            },
        } as unknown as Parameters<typeof installDesktop>[0];
        // Only init and clipboard methods run: no Page, browser, IndexedDB or transport exists.
        await installDesktop(page);
        const read = memoryWindow.desktopTest.clipboardRead;
        const clipboard = memoryWindow.diagnosticHub!.readClipboard!;
        memoryWindow.desktopTest.clipboard = 'current';
        assert.equal(await clipboard(), 'current');

        read.holdNext = true;
        const held = clipboard();
        assert.equal(read.pending, true);
        assert.equal(await clipboard(), 'current');
        assert.equal(read.pending, true, 'An immediate read does not adopt the held read');
        read.holdNext = true;
        await assert.rejects(clipboard(), /already pending/);
        assert.equal(read.holdNext, false);
        assert.equal(read.pending, true);
        assert.throws(() => read.resolve('x'.repeat(256 * 1024 + 2)), /byte bound/);
        assert.equal(read.pending, true, 'An invalid fixture response keeps its owner');
        read.resolve('held response');
        assert.equal(await held, 'held response');
        assert.equal(read.pending, false);
        assert.equal(read.settled, 1);
        assert.throws(() => read.resolve('again'), /No pending/);

        read.holdNext = true;
        const failed = clipboard();
        assert.throws(() => read.reject('x'.repeat(513)), /character bound/);
        assert.equal(read.pending, true);
        const rejection = assert.rejects(failed, /controlled failure/);
        read.reject('controlled failure');
        await rejection;
        assert.equal(read.pending, false);
        assert.equal(read.settled, 2);
        assert.throws(() => read.reject('again'), /No pending/);
        assert.equal(await clipboard(), 'current');
    } finally {
        if (original) Object.defineProperty(globalThis, 'window', original);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

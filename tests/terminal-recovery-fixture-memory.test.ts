import assert from 'node:assert/strict';
import test from 'node:test';
import { installDesktop } from './ui/fixtures/desktop';
import { terminalEvent, terminalId, terminalSize, type TerminalEvent } from '../shared/terminal';

async function fixture(check: (memoryWindow: Window) => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const memoryWindow = {} as Window;
    Object.defineProperty(globalThis, 'window', { value: memoryWindow, configurable: true });
    try {
        const page = { async addInitScript(callback: (arg: unknown) => void, arg: unknown) { callback(arg); } } as unknown as Parameters<typeof installDesktop>[0];
        await installDesktop(page);
        // Fail closed if a test accidentally enters a dynamic storage-module path.
        memoryWindow.diagnosticHub!.captureStorage = async () => { throw Error('Storage is outside this fixture check.'); };
        await check(memoryWindow);
    } finally {
        if (original) Object.defineProperty(globalThis, 'window', original);
        else Reflect.deleteProperty(globalThis, 'window');
    }
}

test('terminal recovery fixture preserves replacement identity on old end/close and validates emitted frames', async () => {
    await fixture(async memoryWindow => {
        const api = memoryWindow.diagnosticHub!, terminal = memoryWindow.desktopTest.terminal!;
        const events: TerminalEvent[] = [];
        const unsubscribe = api.onTerminalEvent!(event => { events.push(terminalEvent(event)); });
        const old = terminalId('recovery-shell-owner-0001'), current = terminalId('recovery-shell-owner-0002');
        const size = terminalSize({ cols: 80, rows: 24 });
        await api.openTerminal!({ id: old, ...size });
        assert.equal(terminal.opens, 1);
        await terminal.end();
        assert.equal(terminal.id, '');
        await api.openTerminal!({ id: current, ...size });
        assert.equal(terminal.opens, 2);
        await terminal.end('closed', old);
        await api.closeTerminal!(old);
        assert.equal(terminal.id, current);
        assert.equal(terminal.closes, 1);
        await api.writeTerminal!(current, btoa('\x1b[A'));
        assert.deepEqual(terminal.inputs, ['\x1b[A']);
        const stale = events.filter(event => event.type === 'state' && event.id === old && event.state === 'closed');
        assert.equal(stale.length, 2, 'Fixture deliberately delivers old state for the actual UI identity guard');
        const count = events.length;
        unsubscribe();
        await terminal.end();
        assert.equal(events.length, count);
        assert.equal(terminal.closes, 2);
    });
});

test('terminal recovery fixture refusal emits no phantom readiness and error does not restart itself', async () => {
    await fixture(async memoryWindow => {
        const api = memoryWindow.diagnosticHub!, terminal = memoryWindow.desktopTest.terminal!;
        const events: TerminalEvent[] = [];
        const unsubscribe = api.onTerminalEvent!(event => { events.push(terminalEvent(event)); });
        const size = terminalSize({ cols: 80, rows: 24 });
        terminal.refuseNextOpen = true;
        await assert.rejects(api.openTerminal!({ id: terminalId('recovery-refused-owner-001'), ...size }), /refused/);
        assert.equal(terminal.opens, 1);
        assert.equal(terminal.refuseNextOpen, false);
        assert.deepEqual(events, []);
        const current = terminalId('recovery-accepted-owner-02');
        await api.openTerminal!({ id: current, ...size });
        await terminal.emit('HISTORY_BEFORE_EXIT');
        await terminal.end('error');
        assert.equal(terminal.opens, 2);
        assert.equal(terminal.id, '');
        assert.deepEqual(events.at(-1), { id: current, type: 'state', state: 'error' });
        unsubscribe();
    });
});

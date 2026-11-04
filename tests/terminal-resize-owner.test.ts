import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Evaluate only actual registration/render callbacks with deterministic fake scheduling.
// React, xterm, real timers, IPC and transport implementations are never imported.
const source = readFileSync('src/features/terminal/TerminalPage.tsx', 'utf8');
const begin = '        let resizeTimer: ReturnType<typeof setTimeout>;',
    end = '        const observer = new ResizeObserver(';
assert.equal(source.split(begin).length, 2);
const span = source.slice(source.indexOf(begin), source.indexOf(end, source.indexOf(begin)));
assert.equal(span.split('resizeTerminal').length, 2);
assert.equal(span.split('setError(').length, 2);
const renderStart = source.indexOf('    if (\n        latest.current.transport');
const renderEnd = source.indexOf('    latest.current = props;', renderStart);
assert.ok(renderStart > 0 && renderEnd > renderStart);
const render = new Function('latest', 'connectionEpoch', 'props',
    source.slice(renderStart, renderEnd) + 'latest.current = props;');

type Size = { cols: number; rows: number };
function fixture() {
    let callback!: (size: Size) => void, scheduled: (() => void) | undefined,
        resolve!: () => void, reject!: (error: unknown) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const calls: { current: string; size: Size }[] = [], errors = ['Current diagnostic'];
    const transport = { resizeTerminal(current: string, size: Size) { calls.push({ current, size }); return pending; } };
    const latest: { current: { transport: Partial<typeof transport>; connected: boolean; device: { generation: number } } } =
        { current: { transport, connected: true, device: { generation: 1 } } };
    const id = { current: 'terminal-A' }, ready = { current: true };
    const terminalEpoch = { current: 0 }, connectionEpoch = { current: 0 },
        terminalConnection = { current: 0 }, terminal: { current: object | null } = { current: {} };
    const register = new Function('term', 'setTimeout', 'clearTimeout', 'id', 'ready', 'latest',
        'setError', 'terminalEpoch', 'connectionEpoch', 'terminalConnection', 'terminal',
        span.replace('let resizeTimer: ReturnType<typeof setTimeout>;', 'let resizeTimer;'));
    register({ onResize(fn: (size: Size) => void) { callback = fn; return { dispose() {} }; } },
        (fn: () => void) => { scheduled = fn; return 1; }, () => {}, id, ready, latest,
        (error: string) => errors.push(error), terminalEpoch, connectionEpoch, terminalConnection, terminal);
    return {
        calls, errors, id, ready, terminalEpoch, connectionEpoch, terminalConnection, terminal, latest,
        resize() { callback({ cols: 100, rows: 30 }); },
        dispatch() { const run = scheduled; scheduled = undefined; assert.ok(run); run(); },
        render(props: typeof latest.current) { render(latest, connectionEpoch, props); },
        async settle(failure: boolean) {
            if (failure) reject(Error('resize rejected'));
            else resolve();
            await pending.catch(() => {});
            await Promise.resolve();
        },
    };
}

for (const change of ['id', 'generation', 'provider', 'disconnect', 'dispose', 'closed']) {
    test(`old resize rejection cannot replace diagnostics after ${change}`, async () => {
        const f = fixture();
        f.resize(); f.dispatch();
        assert.deepEqual(f.calls, [{ current: 'terminal-A', size: { cols: 100, rows: 30 } }]);
        if (change === 'id') f.id.current = 'terminal-B';
        if (change === 'generation') f.render({ ...f.latest.current, device: { generation: 2 } });
        if (change === 'provider') f.render({ ...f.latest.current, transport: {} });
        if (change === 'disconnect') f.render({ ...f.latest.current, connected: false });
        if (change === 'dispose') { f.terminalEpoch.current++; f.terminal.current = null; }
        if (change === 'closed') { f.ready.current = false; f.id.current = ''; }
        await f.settle(true);
        assert.deepEqual(f.errors, ['Current diagnostic']);
        assert.equal(f.calls.length, 1); // No automatic retry or replacement-session resize.
    });
}

test('a connection render change fences a queued resize before passive cleanup', async () => {
    const f = fixture(); f.resize();
    f.render({ ...f.latest.current, device: { generation: 2 } });
    assert.equal(f.id.current, 'terminal-A'); // Old passive cleanup has not run.
    f.dispatch();
    assert.deepEqual(f.calls, []);
    await f.settle(false);
    assert.deepEqual(f.errors, ['Current diagnostic']);
});

test('same-session render preserves resize dispatch and original failure diagnostic', async () => {
    const f = fixture(); f.resize(); f.render({ ...f.latest.current }); f.dispatch();
    assert.equal(f.calls.length, 1);
    await f.settle(true);
    assert.deepEqual(f.errors, ['Current diagnostic', 'Terminal resizing failed. Reconnect the device to retry.']);
});

test('successful current resize preserves diagnostics without retry', async () => {
    const f = fixture(); f.resize(); f.dispatch(); await f.settle(false);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.errors, ['Current diagnostic']);
});

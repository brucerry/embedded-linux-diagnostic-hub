import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@xterm/xterm';
import { colorPrompts } from '../src/features/terminal/display';

test('prompt helper reuses marks and releases only its subscriptions and decorations', () => {
    const events = ['write', 'scroll', 'resize', 'buffer'] as const;
    type Event = (typeof events)[number];
    const buses = Object.fromEntries(events.map((event) => [event, new Set<() => void>()])) as
        Record<Event, Set<() => void>>;
    const subscriptions: { event: Event; disposals: number }[] = [];
    let reads = 0, sentinelCalls = 0;
    const read = () => assert.ok(++reads <= 128, 'Bound fake buffer reads.');
    const sentinel = () => { sentinelCalls++; };
    buses.write.add(sentinel);
    const listen = (event: Event, callback: () => void) => {
        assert.ok(subscriptions.length < 8, 'Two helper cycles own four subscriptions each.');
        assert.equal(buses[event].has(callback), false);
        const record = { event, disposals: 0 };
        subscriptions.push(record);
        buses[event].add(callback);
        return {
            dispose() {
                assert.equal(++record.disposals, 1, 'Dispose each owned subscription once.');
                assert.equal(buses[event].delete(callback), true);
            },
        };
    };
    const emit = (event: Event) => {
        for (const callback of [...buses[event]]) callback();
    };
    const marks: { line: number; isDisposed: boolean; disposals: number; dispose(): void }[] = [];
    const decorations: {
        disposals: number;
        renders: Set<(element: HTMLElement) => void>;
        onRender(callback: (element: HTMLElement) => void): { dispose(): void };
        dispose(): void;
    }[] = [];
    const line = Object.freeze({
        isWrapped: false,
        translateToString(trim: boolean) {
            read();
            assert.equal(trim, true);
            return '# ';
        },
        getCell(column: number) {
            read();
            assert.ok(column === 0 || column === 1);
            return Object.freeze({
                getChars: () => column === 0 ? '#' : ' ',
                isFgDefault: () => true,
            });
        },
    });
    const active = {
        type: 'normal', baseY: 0, cursorY: 0, viewportY: 0,
        getLine(row: number) {
            read();
            assert.equal(row, 0);
            return line;
        },
    };
    const terminal = Object.freeze({
        rows: 1, cols: 8,
        buffer: Object.freeze({
            active,
            onBufferChange: (callback: () => void) => listen('buffer', callback),
        }),
        onWriteParsed: (callback: () => void) => listen('write', callback),
        onScroll: (callback: () => void) => listen('scroll', callback),
        onResize: (callback: () => void) => listen('resize', callback),
        registerMarker(offset: number) {
            assert.equal(offset, 0);
            assert.ok(marks.length < 3);
            const mark = {
                line: 0, isDisposed: false, disposals: 0,
                dispose() {
                    assert.equal(++mark.disposals, 1, 'Dispose each owned marker once.');
                    mark.isDisposed = true;
                },
            };
            marks.push(mark);
            return mark;
        },
        registerDecoration(options: {
            marker: (typeof marks)[number]; width: number; foregroundColor: string; layer: string;
        }) {
            assert.strictEqual(options.marker, marks.at(-1));
            assert.deepEqual(
                { width: options.width, foregroundColor: options.foregroundColor, layer: options.layer },
                { width: 2, foregroundColor: '#83d9b0', layer: 'bottom' },
            );
            assert.ok(decorations.length < 3);
            const decoration = {
                disposals: 0,
                renders: new Set<(element: HTMLElement) => void>(),
                onRender(callback: (element: HTMLElement) => void) {
                    assert.equal(decoration.renders.size, 0);
                    decoration.renders.add(callback);
                    return { dispose: () => { decoration.renders.delete(callback); } };
                },
                dispose() {
                    assert.equal(++decoration.disposals, 1, 'Dispose each owned decoration once.');
                    // A decoration owns its render emitter; this fake models that ownership,
                    // not the implementation or heap behavior of native xterm.
                    decoration.renders.clear();
                },
            };
            decorations.push(decoration);
            return decoration;
        },
    });
    const baseline = () => {
        assert.equal(buses.write.size, 1);
        assert.equal(buses.write.has(sentinel), true);
        for (const event of events.slice(1)) assert.equal(buses[event].size, 0);
    };
    try {
        for (let cycle = 0; cycle < 2; cycle++) {
            baseline();
            active.type = 'normal';
            const start = marks.length;
            const helper = colorPrompts(terminal as unknown as Terminal);
            let disposalStarted = false;
            try {
                assert.equal(subscriptions.length, (cycle + 1) * 4);
                for (const event of events)
                    assert.equal(buses[event].size, event === 'write' ? 2 : 1);
                emit('write');
                assert.equal(marks.length, start + 1);
                assert.equal(decorations.length, marks.length);
                assert.equal(decorations.at(-1)!.renders.size, 1);
                helper.refresh();
                emit('scroll');
                emit('resize');
                assert.equal(marks.length, start + 1, 'Refresh must reuse the same live mark.');
                if (cycle === 0) {
                    active.type = 'alternate';
                    emit('buffer');
                    assert.equal(marks[start].disposals, 1);
                    assert.equal(decorations[start].disposals, 1);
                    assert.equal(decorations[start].renders.size, 0);
                    active.type = 'normal';
                    emit('buffer');
                    assert.equal(marks.length, start + 2);
                }
                disposalStarted = true;
                helper.dispose();
                baseline();
                assert.ok(subscriptions.every((subscription) => subscription.disposals === 1));
                assert.ok(marks.every((mark) => mark.disposals === 1 && mark.isDisposed));
                assert.ok(decorations.every((decoration) =>
                    decoration.disposals === 1 && decoration.renders.size === 0));
                const after = { reads, marks: marks.length, decorations: decorations.length };
                const sentinelBefore = sentinelCalls;
                for (const event of events) emit(event);
                assert.equal(sentinelCalls, sentinelBefore + 1, 'Unrelated listener must survive.');
                assert.deepEqual({ reads, marks: marks.length, decorations: decorations.length }, after);
            } finally {
                // Invoke actual helper disposal at most once, including on assertion failure.
                if (!disposalStarted) {
                    disposalStarted = true;
                    helper.dispose();
                }
            }
        }
        assert.equal(subscriptions.length, 8);
        assert.equal(marks.length, 3);
        assert.equal(decorations.length, 3);
        baseline();
    } finally {
        assert.equal(buses.write.delete(sentinel), true);
    }
    for (const event of events) assert.equal(buses[event].size, 0);
});

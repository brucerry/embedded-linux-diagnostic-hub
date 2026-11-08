import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { LocalSerialPort } from '../shared/serial';
import { createSerialPortRefresh } from '../src/features/serial/port-refresh';
import { bindSerialLabels } from './fixtures/serial-label-callbacks';
import { assertCallbackSource } from './fixtures/source-bound-callbacks';

// Only these two literal source files are read; the Page/React module is never imported.
const source = readFileSync('src/features/serial/SerialPage.tsx', 'utf8');
assertCallbackSource('src/features/serial/SerialPage.tsx', source);
const fixture = readFileSync('tests/fixtures/serial-label-callbacks.ts', 'utf8');
const start = source.indexOf('    const label = (port:');
assert.ok(start > 0);
assert.ok(fixture.includes(source.slice(start, source.indexOf('    const refreshPorts', start))));
const chosen = source.indexOf(
    '                                        const chosenName = pendingLabel.current;',
);
assert.ok(chosen > 0);
assert.ok(
    fixture.includes(
        source.slice(chosen, source.indexOf('                                    },', chosen)),
    ),
);
assert.ok(
    source.includes(
        'const labels = useRef(new WeakMap<LocalSerialPort, string>()),\n        labelOrdinal = useRef(0),',
    ),
);
assert.equal(source.includes('labels.current.size'), false);

test('Serial label callback binding rejects changed source before behavior projection', () => {
    for (const changed of [
        source.replace(
            'new WeakMap<LocalSerialPort, string>()',
            'new Map<LocalSerialPort, string>()',
        ),
        source.replace('labelOrdinal.current++;', 'labelOrdinal.current += 2;'),
        source.replace(
            'labels.current.set(port, chosenName);',
            "labels.current.set(port, 'wrong');",
        ),
        source + '\n',
    ]) {
        assert.notEqual(changed, source, 'Mutation control must change the admitted bytes');
        assert.throws(
            () => assertCallbackSource('src/features/serial/SerialPage.tsx', changed),
            /Callback source preimage changed/,
        );
    }
});

test('weak label keys preserve identity, desktop names and monotonic ordinals through refresh and re-render', async () => {
    const context = {
        labels: { current: new WeakMap<LocalSerialPort, string>() },
        labelOrdinal: { current: 0 },
        pendingLabel: { current: '' },
    };
    let callbacks = bindSerialLabels(context),
        operations = 0;
    const makePort = (): LocalSerialPort => ({
        readable: null,
        writable: null,
        open: async () => {
            operations++;
            throw Error('No port operations');
        },
        close: async () => {
            operations++;
            throw Error('No port operations');
        },
        forget: async () => {
            operations++;
            throw Error('No permission changes');
        },
        getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0xabcd }),
    });
    const ports = Array.from({ length: 8 }, makePort);
    let offered = ports,
        visible: LocalSerialPort[] = [];
    const refresh = createSerialPortRefresh(
        async () => offered,
        (p) => {
            visible = p;
            p.forEach(callbacks.label);
        },
    );
    await refresh.refresh();
    assert.equal(visible.length, 8);
    assert.equal(context.labelOrdinal.current, 8);
    assert.ok(
        context.labels.current instanceof WeakMap,
        'Cache keys must not be strongly owned by a Map',
    );
    for (let i = 0; i < 8; i++)
        assert.equal(callbacks.label(ports[i]), `Authorized port ${i + 1} · USB 1234:abcd`);
    offered = [];
    await refresh.refresh();
    assert.equal(visible.length, 0);
    // Rebuilding callback closures with the same refs models re-render identity, not React effects.
    callbacks = bindSerialLabels(context);
    offered = [ports[0], ports[1]];
    await refresh.refresh();
    assert.equal(callbacks.label(ports[0]), 'Authorized port 1 · USB 1234:abcd');
    assert.equal(callbacks.label(ports[1]), 'Authorized port 2 · USB 1234:abcd');
    assert.equal(context.labelOrdinal.current, 8);
    const desktop = makePort();
    context.pendingLabel.current = 'COM11';
    assert.equal(callbacks.chooseLabel(desktop), 'COM11');
    assert.equal(context.pendingLabel.current, '');
    assert.equal(context.labelOrdinal.current, 9);
    context.pendingLabel.current = 'UART Alias';
    assert.equal(callbacks.chooseLabel(ports[0]), 'UART Alias');
    assert.equal(
        context.labelOrdinal.current,
        9,
        'Renaming an existing key does not consume an ordinal',
    );
    assert.equal(callbacks.label(makePort()), 'Authorized port 10 · USB 1234:abcd');
    callbacks = bindSerialLabels(context);
    assert.equal(callbacks.chooseLabel(desktop), 'COM11');
    assert.equal(callbacks.label(makePort()), 'Authorized port 11 · USB 1234:abcd');
    assert.equal(context.labelOrdinal.current, 11);
    assert.equal(operations, 0);
    refresh.dispose();
});

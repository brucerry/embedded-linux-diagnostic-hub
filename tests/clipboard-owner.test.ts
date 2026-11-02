import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Execute only the exact paste callback; never import React, xterm or clipboard APIs.
const sources = {
    terminal: readFileSync('src/features/terminal/TerminalPage.tsx', 'utf8'),
    serial: readFileSync('src/features/serial/SerialPage.tsx', 'utf8'),
};
assert.ok(sources.terminal.includes("id.current = '';\n            ready.current = false;"));
assert.ok(sources.terminal.includes('term.dispose();\n            terminal.current = null;'));
assert.ok(sources.serial.includes('terminal.dispose();\n            term.current = null;'));
assert.ok(sources.terminal.includes('terminalEpoch.current++;\n            term.dispose();'));
assert.ok(sources.serial.includes('terminalEpoch.current++;\n            terminal.dispose();'));
type Kind = keyof typeof sources;
const limit = 256 * 1024;
function fixture(kind: Kind, desktop = true) {
    const source = sources[kind], start = source.indexOf('    async function paste() {');
    const end = source.indexOf('\n    useEffect(', start);
    assert.ok(start > 0 && end > start);
    const span = source.slice(start, end).trim();
    assert.ok(span.endsWith('}'));
    let resolve!: (text: string) => void, reject!: (error: unknown) => void;
    const pending = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const pasted: string[] = [], errors: string[] = [];
    let focus = 0, reads = 0;
    const target = { focus() { focus++; }, paste(text: string) { pasted.push(text); } };
    const ref = { current: target as typeof target | null };
    const id = { current: 'terminal-A' }, ready = { current: true };
    const terminalEpoch = { current: 0 };
    const session = { current: { generation: 1, state: 'connected' }, inputEpoch: 1, automationActive: false };
    const latest = { current: { visible: true, blocked: false } };
    const readClipboard = () => { reads++; return pending; };
    const bridge = desktop ? { readClipboard } : undefined;
    const paste = new Function(
        'id', 'terminal', 'term', 'terminalEpoch', 'ready', 'session', 'latest', 'window', 'navigator',
        'bridge', 'setMenu', 'setError', 'serialFailure', 'TERMINAL_QUEUE_BYTES', 'SERIAL_QUEUE_BYTES',
        span + '\nreturn paste;',
    )(
        id, ref, ref, terminalEpoch, ready, session, latest, { diagnosticHub: bridge },
        { clipboard: { readText: readClipboard } }, bridge, () => {},
        (error: string) => errors.push(error),
        (error: unknown) => error instanceof Error ? error.message : 'Serial operation failed.',
        limit, limit,
    ) as () => Promise<void>;
    return { paste, resolve, reject, pasted, errors, ref, id, session, latest, ready, terminalEpoch,
        focus: () => focus, reads: () => reads };
}

for (const kind of ['terminal', 'serial'] as const) {
    for (const outcome of ['reject', 'oversized'] as const) {
        test(`${kind}: old clipboard ${outcome} cannot overwrite a replacement session diagnostic`, async () => {
            const f = fixture(kind), work = f.paste();
            assert.equal(f.reads(), 1);
            f.id.current = 'terminal-B';
            f.session.current.generation++;
            f.errors.push('New session diagnostic');
            if (outcome === 'reject') f.reject(Error('Old clipboard failure'));
            else f.resolve('x'.repeat(limit + 1));
            await work;
            assert.deepEqual(f.errors, ['New session diagnostic']);
            assert.deepEqual(f.pasted, []);
            assert.equal(f.focus(), 0);
        });
    }
    test(`${kind}: disposed or replaced terminal cannot receive a late clipboard result`, async () => {
        for (const replacement of [false, true]) for (const outcome of ['resolve', 'reject'] as const) {
            const f = fixture(kind), work = f.paste();
            f.terminalEpoch.current++;
            f.ref.current = replacement ? {
                focus() { assert.fail('Old paste focused replacement terminal'); },
                paste() { assert.fail('Old paste reached replacement terminal'); },
            } : null; // Actual terminal effect cleanup clears this ref before replacement.
            if (outcome === 'resolve') f.resolve('late input');
            else f.reject(Error('Disposed clipboard failure'));
            await work;
            assert.deepEqual(f.errors, []);
            assert.deepEqual(f.pasted, []);
        }
    });
    test(`${kind}: no live terminal admits no clipboard read`, async () => {
        const f = fixture(kind);
        f.ref.current = null;
        await f.paste();
        assert.equal(f.reads(), 0);
        assert.deepEqual(f.errors, []);
    });
    test(`${kind}: current browser and desktop reads retain input and original failure behavior`, async () => {
        for (const desktop of [false, true]) {
            const success = fixture(kind, desktop), work = success.paste();
            success.resolve('echo one\r\necho two\n'); await work;
            assert.deepEqual(success.pasted, ['echo one\r\necho two\n']);
            assert.equal(success.focus(), 1);
            const failed = fixture(kind, desktop), failure = failed.paste();
            failed.reject(Error('Current clipboard failure')); await failure;
            assert.deepEqual(failed.errors, ['Current clipboard failure']);
            const large = fixture(kind, desktop), oversized = large.paste();
            large.resolve('x'.repeat(limit + 1)); await oversized;
            assert.deepEqual(large.errors, [`Clipboard text exceeds the ${kind} paste limit.`]);
            assert.deepEqual(large.pasted, []);
        }
    });
    test(`${kind}: existing readiness and Automation input fences still reject late text`, async () => {
        for (const block of ['hidden', 'blocked', 'input'] as const) {
            const f = fixture(kind), work = f.paste();
            if (block === 'hidden') f.latest.current.visible = false;
            else if (block === 'blocked') f.latest.current.blocked = true;
            else { f.ready.current = false; f.session.automationActive = true; }
            f.resolve('must not send'); await work;
            assert.deepEqual(f.pasted, []);
            assert.deepEqual(f.errors, []);
        }
    });
}

test('serial: same-generation input epoch invalidates pending clipboard failures and text', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
        const f = fixture('serial'), work = f.paste();
        f.session.inputEpoch++;
        if (outcome === 'resolve') f.resolve('old input');
        else f.reject(Error('Old input epoch failure'));
        await work;
        assert.deepEqual(f.errors, []);
        assert.deepEqual(f.pasted, []);
    }
});

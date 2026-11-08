import test from 'node:test';
import assert from 'node:assert/strict';
import { serialTerminalOptions } from '../src/features/serial/theme';
import { terminalOptions } from '../src/features/terminal/primitives';
const luminance = (color: string) =>
    color
        .slice(1, 7)
        .match(/../g)!
        .map((c) => parseInt(c, 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
test('Serial ANSI/default ink, active/inactive selection and cursor contrast across all scene surfaces', () => {
    const theme = serialTerminalOptions().theme!;
    for (const surface of ['#d5e9ee', '#a9ced7', '#ecd9b7', '#8d9c97']) {
        for (const key of [
            'foreground',
            'black',
            'red',
            'green',
            'yellow',
            'blue',
            'magenta',
            'cyan',
            'white',
            'brightBlack',
            'brightRed',
            'brightGreen',
            'brightYellow',
            'brightBlue',
            'brightMagenta',
            'brightCyan',
            'brightWhite',
        ])
            assert(
                contrast(theme[key as keyof typeof theme] as string, surface) >= 4.5,
                `${key} on ${surface}`,
            );
        assert(contrast(theme.cursor!, surface) >= 3, 'cursor on scene');
    }
    assert(contrast(theme.cursor!, theme.cursorAccent!) >= 4.5);
    for (const selection of [theme.selectionBackground!, theme.selectionInactiveBackground!]) {
        assert.match(selection, /^#[a-f\d]{6}$/i, 'opaque selection stays independent of scene');
        assert(contrast(theme.selectionForeground!, selection) >= 4.5);
    }
});
test('Serial theme preserves terminal behavior and leaves the SSH theme unchanged', () => {
    const before = terminalOptions(),
        serial = serialTerminalOptions(),
        after = terminalOptions();
    const { theme: _serial, minimumContrastRatio: _contrast, ...behavior } = serial;
    const { theme: _ssh, ...originalBehavior } = before;
    assert.deepEqual(
        JSON.parse(JSON.stringify(behavior)),
        JSON.parse(JSON.stringify(originalBehavior)),
    );
    assert.equal(
        behavior.linkHandler?.activate({} as MouseEvent, 'https://example.invalid', {
            start: { x: 1, y: 1 },
            end: { x: 2, y: 1 },
        }),
        undefined,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
    assert.equal(serial.theme!.background!.slice(-2), '00');
});

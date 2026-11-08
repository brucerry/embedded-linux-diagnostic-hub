import assert from 'node:assert/strict';
import test from 'node:test';
import { VisibleTail } from '../src/features/automation/serial-completion';

/** Simple character-at-a-time behavior oracle; all visible characters obey the tail bound. */
class ReferenceTail {
    value = '';
    state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
    get complete() {
        return this.state === 'text';
    }
    append(text: string) {
        for (const c of text) {
            if (this.state === 'string') {
                if (c === '\x07') this.state = 'text';
                else if (c === '\x1b') this.state = 'string-escape';
                continue;
            }
            if (this.state === 'string-escape') {
                this.state = c === '\\' ? 'text' : 'string';
                continue;
            }
            if (this.state === 'escape') {
                this.state =
                    c === '['
                        ? 'csi'
                        : c === ']' || c === 'P' || c === '_' || c === '^'
                          ? 'string'
                          : 'text';
                continue;
            }
            if (this.state === 'csi') {
                if (c >= '@' && c <= '~') this.state = 'text';
                continue;
            }
            if (c === '\x1b') {
                this.state = 'escape';
                continue;
            }
            if (c === '\x9b') {
                this.state = 'csi';
                continue;
            }
            if (c === '\b') {
                this.value = this.value.slice(0, -1);
                continue;
            }
            if (c === '\r' || c === '\n' || c === '\t' || (c >= ' ' && c !== '\x7f'))
                this.value = (this.value + (c === '\r' ? '\n' : c)).slice(-4096);
        }
    }
}

for (const width of [1, 3, 127, 4096, 16384])
    test(
        'bounded visible tail preserves fragmented ANSI/control/Unicode semantics at width ' +
            width,
        () => {
            const input =
                'A'.repeat(4113) +
                '\b\bZ\r\n' +
                '\x1b[32mboard# \x1b[0m\x1b]0;UNTRUSTED\x07' +
                'x'.repeat(4099) +
                '\b\b\bEND\x1bPignored\x1b\\\x9b31m ✓🙂\t\r\nboard# ';
            const tail = new VisibleTail(),
                reference = new ReferenceTail();
            for (let offset = 0; offset < input.length; offset += width) {
                const chunk = input.slice(offset, offset + width);
                tail.append(chunk);
                reference.append(chunk);
                assert.equal(tail.value, reference.value);
                assert.equal(tail.complete, reference.complete);
                assert.ok(tail.value.length <= 4096);
            }
            assert.ok(tail.value.endsWith('board# '));
            assert.equal(tail.complete, true);
        },
    );

test('carriage-return-only output remains bounded before destructive tail edits', () => {
    const tail = new VisibleTail(),
        reference = new ReferenceTail();
    for (const text of [
        'A'.repeat(4096),
        '\r'.repeat(16384),
        '\b'.repeat(4100),
        '\x1b[31mboard# ',
    ]) {
        tail.append(text);
        reference.append(text);
        assert.ok(tail.value.length <= 4096);
        assert.equal(tail.value, reference.value);
    }
    assert.equal(tail.value, 'board# ');
});

test('large printable observations copy bounded runs instead of the tail for every character', () => {
    const input = 'A'.repeat(16384),
        tail = new VisibleTail();
    const slice = String.prototype.slice;
    let trims = 0;
    String.prototype.slice = function (start, end) {
        if (start === -4096) trims++;
        return slice.call(this, start, end);
    };
    try {
        for (let index = 0; index < 18; index++) tail.append(input);
    } finally {
        String.prototype.slice = slice;
    }
    assert.equal(tail.value, 'A'.repeat(4096));
    assert.ok(
        trims <= 90,
        'Repeated tail copies must scale with bounded runs, not 294,912 characters: ' + trims,
    );
});

test('seeded mixed fragments retain exact bounded parser state without executing control content', () => {
    const tokens = [
        'abc',
        '\b',
        '\r',
        '\n',
        '\t',
        '\x00',
        '\x7f',
        '\x1b[32m',
        '\x1b]52;c;ignored\x07',
        '\x1bPignored\x1b\\',
        '\x9b0m',
        '🙂',
        'board# ',
    ];
    for (let seed = 1; seed <= 16; seed++) {
        let random = seed;
        const tail = new VisibleTail(),
            reference = new ReferenceTail();
        tail.append('X'.repeat(4096));
        reference.append('X'.repeat(4096));
        for (let index = 0; index < 1000; index++) {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            const text = tokens[random % tokens.length];
            // Split control sequences as well as ordinary text at arbitrary UTF-16 boundaries.
            const cut = random % (text.length + 1);
            for (const chunk of [text.slice(0, cut), text.slice(cut)]) {
                tail.append(chunk);
                reference.append(chunk);
                assert.equal(tail.value, reference.value, 'seed ' + seed + ', token ' + index);
                assert.equal(tail.complete, reference.complete);
                assert.ok(tail.value.length <= 4096);
            }
        }
    }
});

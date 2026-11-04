import assert from 'node:assert/strict';

export const GITHUB_METADATA_BYTES = 1024 ** 2;
const numericLexemes = new WeakMap();
/** Only parser-issued numeric tokens have this identity; wire objects/strings cannot forge it. */
export function githubMetadataNumericLexeme(value) {
    return value !== null && typeof value === 'object' ? (numericLexemes.get(value) ?? null) : null;
}
/** Bounded wire JSON, with duplicate keys rejected and unsafe/noninteger numbers retained as opaque lexemes.
 * Typed numeric projections must explicitly unwrap them; JSON string types stay distinct. */
export function parseGitHubMetadataJSON(bytes) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= GITHUB_METADATA_BYTES);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    let at = 0,
        nodes = 0;
    const space = () => {
        while (/[\t\n\r ]/.test(text[at] ?? '\0')) at++;
    };
    function string() {
        assert.equal(text[at], '"');
        const start = at++;
        while (at < text.length) {
            if (text[at] === '\\') at += 2;
            else if (text[at++] === '"') return JSON.parse(text.slice(start, at));
        }
        throw Error('Unterminated metadata string.');
    }
    function value(depth) {
        assert.ok(depth <= 32 && ++nodes <= 16384, 'Metadata structure limit.');
        space();
        if (text[at] === '"') return string();
        if (text[at] === '{') {
            at++;
            space();
            const result = {},
                names = new Set();
            if (text[at] === '}') {
                at++;
                return result;
            }
            for (;;) {
                const name = string();
                assert.ok(!names.has(name), 'Duplicate metadata key.');
                names.add(name);
                space();
                assert.equal(text[at++], ':');
                const next = value(depth + 1);
                Object.defineProperty(result, name, {
                    value: next,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
                space();
                const end = text[at++];
                if (end === '}') return result;
                assert.equal(end, ',');
                space();
            }
        }
        if (text[at] === '[') {
            at++;
            space();
            const result = [];
            if (text[at] === ']') {
                at++;
                return result;
            }
            for (;;) {
                result.push(value(depth + 1));
                space();
                const end = text[at++];
                if (end === ']') return result;
                assert.equal(end, ',');
                space();
            }
        }
        for (const [word, result] of [
            ['true', true],
            ['false', false],
            ['null', null],
        ]) {
            if (text.startsWith(word, at)) {
                at += word.length;
                return result;
            }
        }
        const token = text.slice(at).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
        assert.ok(token, 'Invalid metadata JSON value.');
        at += token[0].length;
        if (
            /^-?(?:0|[1-9][0-9]*)$/.test(token[0]) &&
            token[0] !== '-0' &&
            Number.isSafeInteger(Number(token[0]))
        )
            return Number(token[0]);
        const marker = Object.freeze(Object.create(null));
        numericLexemes.set(marker, token[0]);
        return marker; // Preserve spelling and wire type; never round or masquerade as a string.
    }
    const result = value(0);
    space();
    assert.equal(at, text.length, 'Trailing metadata bytes.');
    return result;
}

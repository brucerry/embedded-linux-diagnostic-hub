// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** One input view, one bounded token/metadata scratch; no whole-report buffering. */
export class ReportCursor {
    constructor(chunks, maximum = 134217728) {
        this.iterator = chunks[Symbol.asyncIterator]?.() ?? chunks[Symbol.iterator]();
        this.maximum = maximum;
        this.buffer = Buffer.alloc(0);
        this.offset = 0;
        this.bytes = 0;
        this.hash = createHash('sha256');
        this.done = false;
        this.peakInput = 0;
    }
    async ready() {
        while (this.offset === this.buffer.length && !this.done) {
            const next = await this.iterator.next();
            if (next.done) {
                this.done = true;
                break;
            }
            assert(next.value instanceof Uint8Array);
            const raw = next.value;
            assert(raw.length <= 65536, 'Report source chunk bound');
            this.bytes += raw.length;
            assert(this.bytes <= this.maximum, 'Report file bound');
            this.hash.update(raw);
            this.buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
            this.offset = 0;
            this.peakInput = Math.max(this.peakInput, raw.length);
        }
        return this.offset < this.buffer.length;
    }
    async peek() {
        return (await this.ready()) ? this.buffer[this.offset] : null;
    }
    async take() {
        const c = await this.peek();
        assert(c !== null, 'Truncated report');
        this.offset++;
        return c;
    }
    async space() {
        while ([9, 10, 13, 32].includes(await this.peek())) this.offset++;
    }
    async expect(value) {
        const raw = typeof value === 'string' ? Buffer.from(value) : value;
        for (const c of raw) assert.equal(await this.take(), c, 'Report delimiter mismatch');
    }
    async exact(count, consume) {
        assert(Number.isSafeInteger(count) && count >= 0);
        while (count) {
            assert(await this.ready(), 'Truncated report body');
            const size = Math.min(count, this.buffer.length - this.offset),
                part = this.buffer.subarray(this.offset, this.offset + size);
            consume(part);
            this.offset += size;
            count -= size;
        }
    }
    async small(count, max = 65536) {
        assert(count <= max);
        const raw = Buffer.alloc(count);
        let offset = 0;
        await this.exact(count, (part) => {
            part.copy(raw, offset);
            offset += part.length;
        });
        return raw;
    }
    async until(marker, maximum = 1048576, allowEOF = false) {
        const needle = Buffer.from(marker),
            raw = Buffer.alloc(maximum);
        let used = 0;
        // Metadata is bounded. Large output bodies always use exact(), never this search.
        for (;;) {
            const c = await this.peek();
            if (c === null) {
                assert(allowEOF, 'Report marker missing');
                return raw.subarray(0, used);
            }
            assert(used < maximum, 'Report metadata/search bound');
            raw[used++] = c;
            this.offset++;
            if (used >= needle.length && raw.subarray(used - needle.length, used).equals(needle))
                return raw.subarray(0, used - needle.length);
        }
    }
    async fence(language) {
        let count = 0;
        while ((await this.peek()) === 126) {
            this.offset++;
            count++;
        }
        assert(count >= 3, 'Markdown fence missing');
        await this.expect(language + '\n');
        return count;
    }
    async closeFence(count) {
        while (count) {
            assert(await this.ready(), 'Truncated Markdown fence');
            const n = Math.min(count, this.buffer.length - this.offset);
            for (let i = 0; i < n; i++)
                assert.equal(this.buffer[this.offset + i], 126, 'Markdown closing fence');
            this.offset += n;
            count -= n;
        }
        await this.expect('\n');
    }
    async token(quoted) {
        const raw = Buffer.alloc(65536);
        let used = 0,
            escape = false,
            first = true;
        for (;;) {
            assert(await this.ready(), 'Truncated JSON token');
            let end = this.offset,
                complete = false;
            for (; end < this.buffer.length; end++) {
                const c = this.buffer[end];
                if (quoted) {
                    if (first) {
                        assert.equal(c, 34);
                        first = false;
                    } else if (escape) escape = false;
                    else if (c === 92) escape = true;
                    else if (c === 34) {
                        end++;
                        complete = true;
                        break;
                    }
                } else if ([9, 10, 13, 32, 44, 93, 125].includes(c)) {
                    complete = true;
                    break;
                }
            }
            const length = end - this.offset;
            assert(used + length <= raw.length, 'Report JSON token bound');
            this.buffer.copy(raw, used, this.offset, end);
            used += length;
            this.offset = end;
            if (complete) break;
            if (!quoted && this.done) break;
        }
        assert(used > 0);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, used)));
    }
    async close() {
        try {
            await this.iterator.return?.();
        } finally {
            this.buffer = Buffer.alloc(0);
            this.offset = 0;
        }
    }
    async finish() {
        assert((await this.peek()) === null, 'Trailing report bytes');
        assert(this.bytes > 0, 'Empty report');
        return {
            bytes: this.bytes,
            sha256: this.hash.digest('hex'),
            allocation: {
                maximumInputBufferBytes: this.peakInput,
                maximumTokenBytes: 65536,
                maximumMetadataScratchBytes: 1048576,
                wholeReportMaterialized: false,
            },
        };
    }
}

/** Prune the two unbounded product arrays while retaining only one bounded row/frame. */
export async function parseReportJson(cursor, hooks) {
    let retainedNodes = 0;
    async function parse(path = [], parent) {
        assert(path.length <= 32 && ++retainedNodes <= 65536, 'Report JSON graph quota');
        await cursor.space();
        const c = await cursor.peek();
        if (c === 123) {
            cursor.offset++;
            const value = {},
                keys = new Set();
            await cursor.space();
            if ((await cursor.peek()) === 125) {
                cursor.offset++;
                return value;
            }
            for (;;) {
                assert((await cursor.peek()) === 34, 'JSON key missing');
                const key = await cursor.token(true);
                assert(!keys.has(key) && keys.size < 16384, 'Duplicate/excess JSON member');
                keys.add(key);
                await cursor.space();
                await cursor.expect(':');
                const item = await parse([...path, key], value);
                Object.defineProperty(value, key, {
                    value: item,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
                await cursor.space();
                const end = await cursor.take();
                if (end === 125) return value;
                assert.equal(end, 44);
                await cursor.space();
            }
        }
        if (c === 91) {
            cursor.offset++;
            const captures = path.length === 1 && path[0] === 'captures',
                observations =
                    path.length === 3 && path[0] === 'captures' && path[2] === 'rawObservations';
            if (observations) hooks.rawStart(parent, path[1]);
            const result = [];
            let index = 0;
            await cursor.space();
            if ((await cursor.peek()) === 93) {
                cursor.offset++;
                return result;
            }
            for (;;) {
                if (captures || observations) retainedNodes = 0;
                const item = await parse([...path, index], result);
                if (captures) {
                    assert(index < 500, 'Report capture membership bound');
                    hooks.capture(item, index);
                } else if (observations) hooks.frame(item, path[1]);
                else {
                    assert(result.length < 16384, 'Report JSON array bound');
                    result.push(item);
                }
                index++;
                await cursor.space();
                const end = await cursor.take();
                if (end === 93) return result;
                assert.equal(end, 44);
            }
        }
        assert(c !== null);
        return cursor.token(c === 34);
    }
    const root = await parse();
    await cursor.space();
    return root;
}

export async function parseReportCsv(cursor, row) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let cells = [],
        field = '',
        fieldBytes = 0,
        rowBytes = 0,
        quoted = false,
        after = false,
        start = true,
        cr = false;
    const add = (c) => {
        const bytes = Buffer.byteLength(c);
        assert(
            fieldBytes + bytes <= 65536 && rowBytes + bytes <= 262144,
            'Report CSV retained row bound',
        );
        field += c;
        fieldBytes += bytes;
        rowBytes += bytes;
    };
    const cell = () => {
        assert(cells.length < 64);
        cells.push(field);
        field = '';
        fieldBytes = 0;
        start = true;
        after = false;
    };
    const end = () => {
        row(cells);
        cells = [];
        rowBytes = 0;
    };
    const consume = (text) => {
        for (const c of text) {
            if (cr) {
                assert.equal(c, '\n', 'Bare CSV CR');
                cr = false;
                end();
                continue;
            }
            if (quoted) {
                if (c === '"') {
                    quoted = false;
                    after = true;
                } else add(c);
                continue;
            }
            if (c === '"') {
                if (after) {
                    add('"');
                    quoted = true;
                    after = false;
                } else {
                    assert(start, 'Unexpected CSV quote');
                    quoted = true;
                    start = false;
                }
                continue;
            }
            if (c === ',' || c === '\r' || c === '\n') {
                cell();
                if (c === '\r') cr = true;
                else if (c === '\n') end();
                continue;
            }
            assert(!after, 'Text after CSV quote');
            add(c);
            start = false;
        }
    };
    while (await cursor.ready()) {
        const part = cursor.buffer.subarray(cursor.offset);
        cursor.offset = cursor.buffer.length;
        consume(decoder.decode(part, { stream: true }));
    }
    consume(decoder.decode());
    assert(!quoted && !cr, 'Truncated CSV field/line');
    if (field || cells.length || !start || after) {
        cell();
        end();
    }
}

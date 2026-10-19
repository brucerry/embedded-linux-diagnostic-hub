// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

/** Explicit owned canonical bytes, distinct from JS heap/RSS and encoded write credit. */
export class CanonicalStaging {
    constructor(limit) {
        assert(Number.isSafeInteger(limit) && limit > 0);
        this.limit = limit;
        this.used = 0;
        this.peak = 0;
    }
    acquire(bytes) {
        assert(
            Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= this.limit - this.used,
            'Shared canonical staging quota',
        );
        this.used += bytes;
        this.peak = Math.max(this.peak, this.used);
        let owned = true;
        return {
            bytes,
            release: () => {
                assert(owned, 'Canonical credit double release');
                owned = false;
                this.used -= bytes;
            },
        };
    }
}
function stringBytes(value) {
    let size = 2;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) size += 2;
        else if (c < 32) size += 6;
        else if (c < 128) size++;
        else if (c < 2048) size += 2;
        else if (
            c >= 0xd800 &&
            c <= 0xdbff &&
            i + 1 < value.length &&
            value.charCodeAt(i + 1) >= 0xdc00 &&
            value.charCodeAt(i + 1) <= 0xdfff
        ) {
            size += 4;
            i++;
        } else if (c >= 0xd800 && c <= 0xdfff) size += 6;
        else size += 3;
    }
    return size;
}
/** Descriptors only: no getters, custom serialization, large JSON string or clone allocation. */
export function measureCanonical(value, limits, max = limits.reportBytes) {
    let bytes = 0,
        nodes = 0,
        members = 0,
        maxDepth = 0;
    const ancestors = new Set();
    const add = (n) => {
        bytes += n;
        assert(bytes <= max, 'Soak logical report bound before allocation');
    };
    function visit(v, depth) {
        maxDepth = Math.max(maxDepth, depth);
        assert(
            ++nodes <= limits.nodes && depth <= limits.depth,
            'Soak object quota before allocation',
        );
        if (v === null) {
            add(4);
            return;
        }
        if (typeof v === 'string') {
            add(stringBytes(v));
            return;
        }
        if (typeof v === 'boolean') {
            add(v ? 4 : 5);
            return;
        }
        if (typeof v === 'number') {
            assert(Number.isFinite(v), 'Soak nonfinite number');
            add(JSON.stringify(v).length);
            return;
        }
        assert(depth < limits.depth, 'Soak container depth');
        assert(
            typeof v === 'object' && !ancestors.has(v) && !types.isProxy(v),
            'Soak non-JSON/cyclic/proxy value',
        );
        assert(
            Array.isArray(v) || [null, Object.prototype].includes(Object.getPrototypeOf(v)),
            'Soak custom object',
        );
        assert(!Object.hasOwn(v, 'toJSON'), 'Soak custom serialization');
        ancestors.add(v);
        add(2);
        let count = 0;
        if (Array.isArray(v)) {
            assert(v.length <= limits.members, 'Soak array bound');
            for (let i = 0; i < v.length; i++) {
                assert(++members <= limits.members, 'Soak member quota');
                const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
                assert(
                    descriptor && 'value' in descriptor && descriptor.enumerable,
                    'Soak sparse/accessor array',
                );
                if (i) add(1);
                visit(descriptor.value, depth + 1);
                count++;
            }
            let own = 0;
            for (const key in v) if (Object.hasOwn(v, key)) own++;
            assert(own === count, 'Soak extra array properties');
        } else
            for (const key in v)
                if (Object.hasOwn(v, key)) {
                    assert(
                        (members += 2) <= limits.members && ++nodes <= limits.nodes,
                        'Soak member quota',
                    );
                    const descriptor = Object.getOwnPropertyDescriptor(v, key);
                    assert(descriptor && 'value' in descriptor, 'Soak accessor');
                    if (count++) add(1);
                    add(stringBytes(key) + 1);
                    visit(descriptor.value, depth + 1);
                }
        ancestors.delete(v);
    }
    visit(value, 0);
    return { bytes, nodes, members, depth: maxDepth };
}
function quoted(value, write) {
    write('"');
    let start = 0;
    const flush = (end) => {
        if (end > start) write(value.slice(start, end));
        start = end;
    };
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        let escape;
        if (c === 34) escape = '\\"';
        else if (c === 92) escape = '\\\\';
        else if (c < 32)
            escape =
                { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' }[c] ??
                '\\u' + c.toString(16).padStart(4, '0');
        else if (
            c >= 0xd800 &&
            c <= 0xdbff &&
            i + 1 < value.length &&
            value.charCodeAt(i + 1) >= 0xdc00 &&
            value.charCodeAt(i + 1) <= 0xdfff
        ) {
            i++;
        } else if (c >= 0xd800 && c <= 0xdfff) escape = '\\u' + c.toString(16).padStart(4, '0');
        if (escape) {
            flush(i);
            write(escape);
            start = i + 1;
        } else if (i - start >= 4096) flush(i + 1);
    }
    flush(value.length);
    write('"');
}
function writeCanonical(value, write) {
    if (typeof value === 'string') {
        quoted(value, write);
        return;
    }
    if (value === null || typeof value !== 'object') {
        write(JSON.stringify(value));
        return;
    }
    const array = Array.isArray(value);
    write(array ? '[' : '{');
    let count = 0;
    const member = (key, v) => {
        if (count++) write(',');
        if (!array) {
            quoted(key, write);
            write(':');
        }
        writeCanonical(v, write);
    };
    if (array)
        for (let i = 0; i < value.length; i++)
            member(String(i), Object.getOwnPropertyDescriptor(value, String(i)).value);
    else
        for (const key in value)
            if (Object.hasOwn(value, key))
                member(key, Object.getOwnPropertyDescriptor(value, key).value);
    write(array ? ']' : '}');
}
export function canonicalDigest(value, expectedBytes) {
    const digest = createHash('sha256');
    let bytes = 0;
    writeCanonical(value, (part) => {
        bytes += Buffer.byteLength(part);
        assert(bytes <= expectedBytes, 'Canonical source mutated');
        digest.update(part);
    });
    assert(bytes === expectedBytes, 'Canonical source mutated');
    return digest.digest('hex');
}
/** Caller must acquire output+scratch credit before entering this allocation. */
export function allocateCanonical(value, expectedBytes, expectedSHA256) {
    const buffer = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    writeCanonical(value, (part) => {
        const n = Buffer.byteLength(part);
        assert(offset + n <= expectedBytes, 'Canonical source mutated');
        offset += buffer.write(part, offset, n, 'utf8');
    });
    assert(offset === expectedBytes, 'Canonical source mutated');
    if (expectedSHA256)
        assert(
            createHash('sha256').update(buffer).digest('hex') === expectedSHA256,
            'Queued canonical source mutated',
        );
    return buffer;
}

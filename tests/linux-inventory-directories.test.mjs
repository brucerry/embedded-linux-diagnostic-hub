import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLinuxInventoryDirectories } from '../scripts/lib/linux-inventory-directories.mjs';

// In-memory file-parent table, NOT a retained artifact or a full envelope-plan fixture.
const expected = Object.freeze(['locales', 'resources']);
const unsupported = { message: 'LINUX_DIRECTORY_LAYOUT_UNSUPPORTED' };

test('normal retained list admits without changing either input', () => {
    const retained = Object.freeze(['resources', 'locales']);
    assert.equal(assertLinuxInventoryDirectories(expected, retained), undefined);
    assert.deepEqual(expected, ['locales', 'resources']);
    assert.deepEqual(retained, ['resources', 'locales']);
});

test('extra empty directory refuses before simulated stream creation', () => {
    let opened = 0;
    const admitThenOpen = () => {
        assertLinuxInventoryDirectories(expected, ['locales', 'resources', 'empty']);
        opened += 1;
    };
    assert.throws(admitThenOpen, unsupported);
    assert.equal(opened, 0);
});

test('missing required parent refuses', () => {
    assert.throws(() => assertLinuxInventoryDirectories(expected, ['resources']), unsupported);
});

test('same count substitution still refuses', () => {
    assert.throws(() => assertLinuxInventoryDirectories(expected, ['locales', 'empty']), unsupported);
});

test('exact duplicate is not silently deduplicated', () => {
    assert.throws(() => assertLinuxInventoryDirectories(expected, ['locales', 'resources', 'resources']),
        { message: 'LINUX_DIRECTORY_INVENTORY_ALIAS' });
});

test('NFC aliases refuse, without canonicalizing the admitted spelling', () => {
    assert.throws(() => assertLinuxInventoryDirectories(['caf\u00e9'], ['caf\u00e9', 'cafe\u0301']),
        { message: 'LINUX_DIRECTORY_INVENTORY_ALIAS' });
    assert.throws(() => assertLinuxInventoryDirectories(['caf\u00e9'], ['cafe\u0301']), unsupported);
    assert.equal(assertLinuxInventoryDirectories(['cafe\u0301'], ['cafe\u0301']), undefined);
});

test('ambiguous derived table also refuses', () => {
    assert.throws(() => assertLinuxInventoryDirectories(['caf\u00e9', 'cafe\u0301'], ['caf\u00e9']),
        { message: 'LINUX_DIRECTORY_INVENTORY_ALIAS' });
});

test('malformed paths and non-string entries refuse', () => {
    for (const name of ['', '.', '..', '../resources', '/resources', 'resources/',
        'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\0b', 'a\nb', 'a\x7fb', 'C:resources',
        'a'.repeat(1025), null, 4, {}]) {
        assert.throws(() => assertLinuxInventoryDirectories(expected, [name]),
            { message: 'LINUX_DIRECTORY_INVENTORY' });
    }
});

test('missing, non-array, sparse and over-cap tables refuse', () => {
    for (const value of [undefined, null, {}, 'resources', new Array(1), new Array(20001)]) {
        assert.throws(() => assertLinuxInventoryDirectories(expected, value),
            { message: 'LINUX_DIRECTORY_INVENTORY' });
    }
});

test('nested parents all required and case-sensitive', () => {
    assert.equal(assertLinuxInventoryDirectories(['a', 'a/b'], ['a/b', 'a']), undefined);
    assert.throws(() => assertLinuxInventoryDirectories(['a', 'a/b'], ['a/b']), unsupported);
    assert.throws(() => assertLinuxInventoryDirectories(['resources'], ['Resources']), unsupported);
});

test('empty expected and retained tables are equal; retained omission is not an empty list', () => {
    assert.equal(assertLinuxInventoryDirectories([], []), undefined);
    assert.throws(() => assertLinuxInventoryDirectories([], undefined),
        { message: 'LINUX_DIRECTORY_INVENTORY' });
});

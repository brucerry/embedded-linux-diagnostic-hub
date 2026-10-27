import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { matchesSetupSuccessor, type NativeSetupWindow } from '../electron/setup-successor';

test('native successor accepts decorated titles and requires exact PID, creation, path, visibility and version', () => {
    const root = path.join(os.tmpdir(), 'setup-successor-fixture');
    const expected = {
        pid: 234,
        creationTimeMs: 1800000000123,
        profile: path.join(os.tmpdir(), 'profile'),
    };
    const native: NativeSetupWindow = {
        pid: expected.pid,
        executable: path.join(root, 'Diagnostic Hub.exe'),
        createdAt: new Date(expected.creationTimeMs).toISOString(),
        handle: 9876,
        visible: true,
        minimized: false,
        title: 'Diagnostic Hub — Embedded Linux diagnostics',
        version: '0.6.0',
    };
    assert.equal(matchesSetupSuccessor(root, expected, '0.6.0', native), true);
    assert.equal(matchesSetupSuccessor(root, expected, '0.6.0', { ...native, title: '' }), true);
    for (const change of [
        { pid: expected.pid + 1 },
        { createdAt: new Date(expected.creationTimeMs - 10000).toISOString() },
        { executable: path.join(root, 'another.exe') },
        { handle: 0 },
        { visible: false },
        { minimized: true },
        { version: '0.6.00' },
        { version: '0.5.2' },
    ])
        assert.equal(
            matchesSetupSuccessor(root, expected, '0.6.0', { ...native, ...change }),
            false,
            JSON.stringify(change),
        );
});

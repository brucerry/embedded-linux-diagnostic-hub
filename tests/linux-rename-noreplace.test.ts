import type { LinuxNativeOps } from '../electron/linux-native-backend';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
    checkedLinuxRenameBinding,
    LINUX_RENAME_ABI,
    type LinuxRenameHost,
} from '../electron/linux-rename-noreplace';
const host: LinuxRenameHost = { platform: 'linux', arch: 'x64', napiVersion: 8 };
function moduleFixture(...values: unknown[]) {
    const result = values.length === 0 ? 0 : values[0];
    const calls: unknown[][] = [];
    const module = {
        ...LINUX_RENAME_ABI,
        renameNoReplace(...args: unknown[]) {
            calls.push(args);
            return result;
        },
    };
    return { module, calls };
}
function errorCode(action: () => void, expected: string) {
    assert.throws(
        action,
        (error: unknown) =>
            error instanceof Error &&
            error.message === expected &&
            (error as Error & { code: string }).code === expected,
    );
}
test('checked ABI adapter is inert until called and forwards exactly four borrowed-FD arguments once', () => {
    const f = moduleFixture(),
        invoke = checkedLinuxRenameBinding(f.module, host);
    assert.deepEqual(f.calls, []);
    assert.equal(invoke(3, 'stage-α', 4, 'Installed App'), undefined);
    assert.deepEqual(f.calls, [[3, 'stage-α', 4, 'Installed App']]);
});
for (const [status, code] of [
    [1, 'ERR_DH_RENAME_EXISTS'],
    [2, 'ERR_DH_RENAME_UNSUPPORTED'],
    [3, 'ERR_DH_RENAME_PERMISSION'],
    [4, 'ERR_DH_RENAME_CROSS_DEVICE'],
    [5, 'ERR_DH_RENAME_ARGUMENT'],
    [6, 'ERR_DH_RENAME_BAD_FD'],
    [7, 'ERR_DH_RENAME_UNKNOWN'],
    [8, 'ERR_DH_RENAME_INTERRUPTED'],
    [9, 'ERR_DH_RENAME_READ_ONLY'],
    [10, 'ERR_DH_RENAME_BUSY'],
] as const)
    test('stable native status refuses with fixed code and no retry: ' + status, () => {
        const f = moduleFixture(status),
            invoke = checkedLinuxRenameBinding(f.module, host);
        errorCode(() => invoke(3, 'source', 4, 'target'), code);
        assert.equal(f.calls.length, 1);
    });
test('malformed native acknowledgements never count as successful rename', () => {
    for (const value of [
        false,
        true,
        null,
        undefined,
        '',
        '0',
        {},
        [],
        Promise.resolve(0),
        -1,
        11,
        0.5,
        NaN,
        Infinity,
    ]) {
        const f = moduleFixture(value),
            invoke = checkedLinuxRenameBinding(f.module, host);
        errorCode(() => invoke(3, 'source', 4, 'target'), 'ERR_DH_RENAME_ACK');
        assert.equal(f.calls.length, 1);
    }
});
test('invalid basename/FD rejects before invoking even fake native code', () => {
    const f = moduleFixture(),
        invoke = checkedLinuxRenameBinding(f.module, host);
    for (const name of [
        '',
        '.',
        '..',
        '/absolute',
        'a/b',
        'a\\b',
        'a\0b',
        'a\nb',
        '\u007f',
        '\ud800',
        '\udc00',
        'a'.repeat(256),
        '界'.repeat(86),
    ]) {
        errorCode(() => invoke(3, name, 4, 'target'), 'ERR_DH_RENAME_ARGUMENT');
        errorCode(() => invoke(3, 'source', 4, name), 'ERR_DH_RENAME_ARGUMENT');
    }
    for (const fd of [-1, -100, 0.5, 0x80000000, NaN, Infinity, '3', null, undefined, {}])
        errorCode(() => invoke(fd as number, 'source', 4, 'target'), 'ERR_DH_RENAME_ARGUMENT');
    errorCode(() => invoke(3, 'same', 3, 'same'), 'ERR_DH_RENAME_ARGUMENT');
    assert.equal(f.calls.length, 0);
});
test('valid Unicode and exact255-byte names retain bytes without normalization or path expansion', () => {
    const f = moduleFixture(),
        invoke = checkedLinuxRenameBinding(f.module, host);
    for (const name of [
        'a'.repeat(255),
        '界'.repeat(85),
        '😀'.repeat(63),
        'e\u0301',
        "space % quote'",
    ])
        invoke(0, name, 2147483647, 'target');
    assert.equal(f.calls.length, 5);
    assert.equal(f.calls[3][1], 'e\u0301');
});
test('host ABI platform/architecture/runtime gates reject without native loading or invocation', () => {
    for (const value of [
        { ...host, platform: 'darwin' },
        { ...host, platform: 'win32' },
        { ...host, arch: 'arm64' },
        { ...host, napiVersion: 7 },
        { ...host, napiVersion: '8' },
        null,
        undefined,
    ]) {
        const f = moduleFixture();
        errorCode(
            () => checkedLinuxRenameBinding(f.module, value as LinuxRenameHost),
            'ERR_DH_RENAME_HOST',
        );
        assert.equal(f.calls.length, 0);
    }
    const f = moduleFixture();
    assert.equal(
        typeof checkedLinuxRenameBinding(f.module, { ...host, napiVersion: 10 }),
        'function',
    );
});
test('closed module ABI rejects missing/extra/version/method fields before operation', () => {
    const f = moduleFixture();
    for (const value of [
        null,
        false,
        [],
        { ...f.module, abiVersion: 2 },
        { ...f.module, napiVersion: 9 },
        { ...f.module, statusVersion: 0 },
        { ...f.module, platform: 'darwin' },
        { ...f.module, arch: 'arm64' },
        { ...f.module, renameNoReplace: false },
        { ...f.module, extra: 1 },
        { ...f.module, [Symbol('foreign')]: 1 },
    ])
        errorCode(() => checkedLinuxRenameBinding(value, host), 'ERR_DH_RENAME_ABI');
    const missing = { ...f.module } as Partial<typeof f.module>;
    delete missing.statusVersion;
    errorCode(() => checkedLinuxRenameBinding(missing, host), 'ERR_DH_RENAME_ABI');
    assert.equal(f.calls.length, 0);
});
test('metadata getters are rejected without evaluating them or exposing their data', () => {
    const f = moduleFixture();
    let getters = 0;
    Object.defineProperty(f.module, 'abiVersion', {
        enumerable: true,
        get() {
            getters++;
            throw Error('private-getter-canary');
        },
    });
    errorCode(() => checkedLinuxRenameBinding(f.module, host), 'ERR_DH_RENAME_ABI');
    assert.equal(getters, 0);
    const badHost = { ...host };
    Object.defineProperty(badHost, 'napiVersion', {
        get() {
            getters++;
            throw Error('private');
        },
    });
    errorCode(
        () => checkedLinuxRenameBinding(moduleFixture().module, badHost),
        'ERR_DH_RENAME_HOST',
    );
    assert.equal(getters, 0);
});
test('module-function alias changes cannot redirect an already checked adapter', () => {
    const f = moduleFixture(),
        invoke = checkedLinuxRenameBinding(f.module, host);
    let wrong = 0;
    f.module.renameNoReplace = () => {
        wrong++;
        return 0;
    };
    invoke(3, 'source', 4, 'target');
    assert.equal(f.calls.length, 1);
    assert.equal(wrong, 0);
    assert.equal(Object.isFrozen(LINUX_RENAME_ABI), true);
});
test('unexpected native exception loses private text/cause and cannot trigger a retry', () => {
    let calls = 0;
    const module = {
        ...LINUX_RENAME_ABI,
        renameNoReplace() {
            calls++;
            throw Object.assign(Error('credential-path-private-canary'), { secret: 'private' });
        },
    };
    const invoke = checkedLinuxRenameBinding(module, host);
    assert.throws(
        () => invoke(3, 'source', 4, 'target'),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'ERR_DH_RENAME_NATIVE_EXCEPTION');
            assert.equal('cause' in error, false);
            assert.doesNotMatch(String(error) + JSON.stringify(error), /canary|credential|secret/);
            return true;
        },
    );
    assert.equal(calls, 1);
});
test('static C source has one flagged syscall and no rename/copy/delete/open/close fallback', () => {
    // Reads only the newly authored repository source; does not compile/load or call native code.
    const source = readFileSync(
        new URL('../native/linux-rename-noreplace/rename-noreplace.c', import.meta.url),
        'utf8',
    );
    assert.equal((source.match(/\bsyscall\s*\(/g) ?? []).length, 1);
    assert.match(
        source,
        /syscall\(SYS_renameat2, source, source_name, target, target_name, RENAME_NOREPLACE\)/,
    );
    assert.doesNotMatch(
        source,
        /\b(?:rename|renameat|unlink|unlinkat|remove|rmdir|open|openat|close|chmod|fchmod|chown|fork|exec|system)\s*\(/,
    );
    assert.match(source, /!defined\(__linux__\).*\|\|.*!defined\(__x86_64__\)/);
    assert.match(source, /NAPI_VERSION != 8/);
    assert.match(source, /FD_CLOEXEC/);
    assert.match(source, /getuid\(\)/);
    assert.match(source, /uid != geteuid\(\)/);
    assert.match(source, /napi_object_freeze/);
    assert.match(source, /case EINTR: return DH_INTERRUPTED/);
});
test('nested build description is data-only, uses existing Node-API C headers and no download/install hook', () => {
    const gyp = JSON.parse(
        readFileSync(
            new URL('../native/linux-rename-noreplace/binding.gyp', import.meta.url),
            'utf8',
        ),
    );
    assert.equal(gyp.targets.length, 1);
    const target = gyp.targets[0];
    assert.deepEqual(target.sources, ['rename-noreplace.c']);
    assert.deepEqual(target.defines, ['NAPI_VERSION=8']);
    assert.ok(target.cflags.includes('-std=c17'));
    assert.ok(target.cflags.includes('-Werror'));
    assert.equal('actions' in target, false);
    assert.equal('libraries' in target, false);
    assert.equal('dependencies' in target, false);
});

test('checked operation fits the existing backend primitive contract without changing its default', () => {
    const f = moduleFixture();
    const operation: NonNullable<LinuxNativeOps['moveNoReplace']> = checkedLinuxRenameBinding(
        f.module,
        host,
    );
    operation(3, 'source', 4, 'target');
    assert.deepEqual(f.calls, [[3, 'source', 4, 'target']]);
    const source = readFileSync(
        new URL('../electron/linux-native-backend.ts', import.meta.url),
        'utf8',
    );
    assert.match(source, /moveNoReplace: null,/);
    assert.match(source, /if \(!ops\.moveNoReplace\) fail\('NATIVE_ATOMIC_MOVE_UNAVAILABLE'\)/);
});

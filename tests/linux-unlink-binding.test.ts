/** In-process ABI adapter controls only. No addon, filesystem, deletion or host probe. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    checkedLinuxRenameBinding,
    checkedLinuxUnlinkBinding,
    LINUX_RENAME_ABI,
    type LinuxRenameHost,
    type LinuxUnlinkOwned,
} from '../electron/linux-rename-noreplace.ts';

const host: LinuxRenameHost = Object.freeze({ platform: 'linux', arch: 'x64', napiVersion: 8 });
const fixedIdentity = Object.freeze({ dev: 17, ino: 29 });

function fixture(result: (...args: unknown[]) => unknown = () => 0) {
    const calls: unknown[][] = [];
    let renameCalls = 0;
    const module = Object.freeze({
        ...LINUX_RENAME_ABI,
        abiVersion: 2,
        renameNoReplace: Object.freeze(() => { renameCalls++; return 0; }),
        unlinkOwned: Object.freeze((...args: unknown[]) => {
            calls.push(args);
            return result(...args);
        }),
    });
    return { module, calls, renameCalls: () => renameCalls };
}

function binding(f: ReturnType<typeof fixture>): LinuxUnlinkOwned {
    const value = checkedLinuxUnlinkBinding(f.module, host);
    assert.equal(typeof value, 'function');
    return value!;
}

function caught(action: () => unknown): unknown {
    let thrown = false, value: unknown;
    try { action(); }
    catch (error) { thrown = true; value = error; }
    assert.equal(thrown, true, 'The actual adapter must throw.');
    return value;
}

function code(action: () => unknown, expected: string) {
    const value = caught(action);
    assert.ok(value instanceof Error);
    assert.equal(value.message, expected);
    assert.equal((value as Error & { code?: unknown }).code, expected);
}

test('legacy ABI1 retains rename but supplies no unlink capability; ABI2 preparation is inert', () => {
    let renamed = 0;
    const legacy = Object.freeze({
        ...LINUX_RENAME_ABI,
        renameNoReplace: Object.freeze(() => { renamed++; return 0; }),
    });
    assert.equal(checkedLinuxUnlinkBinding(legacy, host), null);
    assert.equal(renamed, 0);
    checkedLinuxRenameBinding(legacy, host)(3, 'old', 4, 'new');
    assert.equal(renamed, 1);
    const f = fixture();
    binding(f);
    assert.equal(f.calls.length, 0);
    assert.equal(f.renameCalls(), 0);
});

test('ABI2 forwards exactly five scalar arguments once, including safe boundaries and exact names', () => {
    const f = fixture(), invoke = binding(f);
    assert.equal(invoke(0, 'owned-α', 'file', fixedIdentity), undefined);
    assert.equal(invoke(0x7fffffff, 'owned-directory', 'directory', { dev: 0, ino: Number.MAX_SAFE_INTEGER }), undefined);
    assert.deepEqual(f.calls, [[0, 'owned-α', 0, 17, 29], [0x7fffffff, 'owned-directory', 1, 0, Number.MAX_SAFE_INTEGER]]);
    for (const selected of ['a'.repeat(255), '界'.repeat(85), '😀'.repeat(63), 'e\u0301', "space % quote'"])
        invoke(7, selected, 'file', fixedIdentity);
    assert.deepEqual(f.calls.slice(2).map(row => row[1]), ['a'.repeat(255), '界'.repeat(85), '😀'.repeat(63), 'e\u0301', "space % quote'"]);
    assert.equal(f.renameCalls(), 0);
});

test('each finite refusal and malformed acknowledgement throws after one fake call without retry', () => {
    const statuses = ['EXISTS', 'UNSUPPORTED', 'PERMISSION', 'CROSS_DEVICE', 'ARGUMENT', 'BAD_FD', 'UNKNOWN', 'INTERRUPTED', 'READ_ONLY', 'BUSY'];
    for (let at = 0; at < statuses.length; at++) {
        const f = fixture(() => at + 1);
        code(() => binding(f)(5, 'declared', 'file', fixedIdentity), 'ERR_DH_UNLINK_' + statuses[at]);
        assert.deepEqual(f.calls, [[5, 'declared', 0, 17, 29]]);
    }
    let thenReads = 0;
    const thenable = Object.defineProperty({}, 'then', { get() { thenReads++; throw Error('must-not-assimilate'); } });
    for (const value of [undefined, null, false, true, '0', '', {}, [], Promise.resolve(0), thenable, -1, 11, 0.5, NaN, Infinity]) {
        const f = fixture(() => value);
        code(() => binding(f)(5, 'declared', 'file', fixedIdentity), 'ERR_DH_UNLINK_ACK');
        assert.equal(f.calls.length, 1);
    }
    assert.equal(thenReads, 0);
});

test('invalid FD, basename, kind and identity are rejected before the fake native effect', () => {
    const f = fixture(), invoke = binding(f);
    for (const value of [-1, -100, 0.5, 0x80000000, NaN, Infinity, '3', null, undefined, {}])
        code(() => invoke(value as number, 'declared', 'file', fixedIdentity), 'ERR_DH_UNLINK_ARGUMENT');
    for (const value of ['', '.', '..', '/absolute', 'a/b', 'a\\b', 'a\0b', 'a\nb', '\u007f', '\ud800', '\udc00', 'a'.repeat(256), '界'.repeat(86), null, 3])
        code(() => invoke(3, value as string, 'file', fixedIdentity), 'ERR_DH_UNLINK_ARGUMENT');
    for (const value of ['link', '', 0, 1, null, undefined])
        code(() => invoke(3, 'declared', value as 'file', fixedIdentity), 'ERR_DH_UNLINK_ARGUMENT');
    for (const value of [undefined, null, false, [], {}, { dev: 1 }, { ino: 1 }, { ...fixedIdentity, extra: true }, { ...fixedIdentity, [Symbol('foreign')]: true }, Object.create(fixedIdentity), { dev: -1, ino: 1 }, { dev: 0.5, ino: 1 }, { dev: NaN, ino: 1 }, { dev: Infinity, ino: 1 }, { dev: Number.MAX_SAFE_INTEGER + 1, ino: 1 }, { dev: '1', ino: 1 }, { dev: 1, ino: 0 }, { dev: 1, ino: -1 }, { dev: 1, ino: 0.5 }, { dev: 1, ino: NaN }, { dev: 1, ino: Infinity }, { dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 }, { dev: 1, ino: '2' }])
        code(() => invoke(3, 'declared', 'file', value as typeof fixedIdentity), 'ERR_DH_UNLINK_ARGUMENT');
    assert.equal(f.calls.length, 0);
});

test('module, host and identity getters or proxies are refused without traps or fake effects', () => {
    const f = fixture();
    let getterCalls = 0, proxyTraps = 0;
    const getter = () => { getterCalls++; throw Error('private-getter'); };
    for (const field of ['abiVersion', 'unlinkOwned']) {
        const bad = { ...f.module };
        Object.defineProperty(bad, field, { get: getter, enumerable: true });
        code(() => checkedLinuxUnlinkBinding(bad, host), 'ERR_DH_RENAME_ABI');
    }
    const badHost = { ...host };
    Object.defineProperty(badHost, 'napiVersion', { get: getter, enumerable: true });
    code(() => checkedLinuxUnlinkBinding(f.module, badHost), 'ERR_DH_RENAME_HOST');
    const traps = {
        get() { proxyTraps++; throw Error('private-proxy'); },
        ownKeys() { proxyTraps++; throw Error('private-proxy'); },
        getOwnPropertyDescriptor() { proxyTraps++; throw Error('private-proxy'); },
        getPrototypeOf() { proxyTraps++; throw Error('private-proxy'); },
    };
    code(() => checkedLinuxUnlinkBinding(new Proxy(f.module, traps), host), 'ERR_DH_RENAME_ABI');
    code(() => checkedLinuxUnlinkBinding(f.module, new Proxy(host, traps)), 'ERR_DH_RENAME_HOST');
    const invoke = binding(f);
    for (const field of ['dev', 'ino']) {
        const bad = { ...fixedIdentity };
        Object.defineProperty(bad, field, { get: getter, enumerable: true });
        code(() => invoke(3, 'declared', 'file', bad), 'ERR_DH_UNLINK_ARGUMENT');
    }
    code(() => invoke(3, 'declared', 'file', new Proxy(fixedIdentity, traps)), 'ERR_DH_UNLINK_ARGUMENT');
    const coercion = Object.defineProperty({}, 'valueOf', { get: getter });
    code(() => invoke(3, 'declared', 'file', { dev: coercion, ino: 29 } as unknown as typeof fixedIdentity), 'ERR_DH_UNLINK_ARGUMENT');
    assert.equal(getterCalls, 0);
    assert.equal(proxyTraps, 0);
    assert.equal(f.calls.length, 0);
});

test('admitted function and metadata are captured; each invocation snapshots its identity data', () => {
    const f = fixture(), mutable: Record<string, unknown> = { ...f.module }, selectedHost = { ...host };
    const invoke = checkedLinuxUnlinkBinding(mutable, selectedHost)!;
    let replacementCalls = 0;
    mutable.unlinkOwned = () => { replacementCalls++; return 0; };
    mutable.abiVersion = 99;
    Object.defineProperty(mutable, 'napiVersion', { get() { throw Error('late-module-getter'); } });
    Object.defineProperty(selectedHost, 'napiVersion', { get() { throw Error('late-host-getter'); } });
    invoke(9, 'captured', 'file', fixedIdentity);
    assert.equal(replacementCalls, 0);
    assert.deepEqual(f.calls, [[9, 'captured', 0, 17, 29]]);
    const identity = { dev: 31, ino: 37 };
    const changing = fixture(() => { identity.dev = -1; identity.ino = 0; return 0; });
    const snapshot = binding(changing);
    snapshot(9, 'snapshotted', 'directory', identity);
    assert.deepEqual(changing.calls, [[9, 'snapshotted', 1, 31, 37]]);
    code(() => snapshot(9, 'snapshotted', 'directory', identity), 'ERR_DH_UNLINK_ARGUMENT');
    assert.equal(changing.calls.length, 1);
});

test('invalid ABI and host metadata refuse before either fake native method is invoked', () => {
    const f = fixture();
    const missing: Record<string, unknown> = { ...f.module };
    delete missing.unlinkOwned;
    for (const value of [null, false, [], missing, { ...f.module, abiVersion: 3 }, { ...f.module, napiVersion: 9 }, { ...f.module, statusVersion: 2 }, { ...f.module, platform: 'darwin' }, { ...f.module, arch: 'arm64' }, { ...f.module, unlinkOwned: false }, { ...f.module, extra: true }, { ...f.module, [Symbol('foreign')]: true }])
        code(() => checkedLinuxUnlinkBinding(value, host), 'ERR_DH_RENAME_ABI');
    for (const value of [null, undefined, { ...host, platform: 'win32' }, { ...host, arch: 'arm64' }, { ...host, napiVersion: 7 }, { ...host, napiVersion: '8' }, { ...host, extra: true }])
        code(() => checkedLinuxUnlinkBinding(f.module, value as LinuxRenameHost), 'ERR_DH_RENAME_HOST');
    assert.equal(f.calls.length, 0);
    assert.equal(f.renameCalls(), 0);
});

test('exact thrown primaries survive before and after a fake effect, including undefined', () => {
    for (const value of [undefined, null, false, 0, Error('same-primary')]) {
        for (const afterEffect of [false, true]) {
            let effects = 0;
            const f = fixture(() => { if (afterEffect) effects++; throw value; });
            assert.equal(caught(() => binding(f)(3, 'declared', 'file', fixedIdentity)), value);
            assert.equal(effects, afterEffect ? 1 : 0);
            assert.deepEqual(f.calls, [[3, 'declared', 0, 17, 29]]);
            assert.equal(f.renameCalls(), 0);
        }
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeQueryOwnerEnvironment,
    bindQueryOwnerEnvironment,
    assertQueryOwnerEnvironmentAbsent,
    queryOwnerRemovalNames,
} from '../scripts/lib/security-query-owner-environment.mjs';
import { requireLeafEnvironment } from '../scripts/lib/security-query-leaf-refusal.mjs';
import { projectCollectorEnvironment } from '../scripts/lib/product-collector-environment.mjs';

// Synthetic stores only. Never read or mutate the host's native environment.
const secret = 'SYNTHETIC_PRIVATE_VALUE_79_NOT_FOR_OUTPUT';
const unknown = 'UNKNOWN_' + secret;
const childPATH = 'C:\\fixed-node;C:\\fixed-WinPS';
const base = [
    ['PATH', childPATH],
    ['SystemRoot', 'C:\\Windows'],
    ['WINDIR', 'C:\\Windows'],
    ['TEMP', 'C:\\private-temp'],
    ['TMP', 'C:\\private-temp'],
];
function fakeNative(entries = base, behavior = {}) {
    const values = new Map(entries);
    const deletions = [];
    let reads = 0;
    const find = (key) => [...values.keys()].find((k) => k.toUpperCase() === key.toUpperCase());
    const environment = new Proxy(Object.create(null), {
        ownKeys() {
            if (behavior.keysThrow) throw Error(secret);
            return [...values.keys()];
        },
        getOwnPropertyDescriptor(_target, key) {
            if (values.has(key)) return { enumerable: true, configurable: true };
        },
        get(_target, key) {
            if (typeof key !== 'string') return undefined;
            reads++;
            if (behavior.valuesThrow) throw Error(secret);
            return values.get(find(key));
        },
        deleteProperty(_target, key) {
            deletions.push(key);
            if (behavior.deleteThrow === key) throw Error(secret);
            if (behavior.deleteFalse === key) return false;
            if (behavior.deleteIneffective !== key) {
                const found = find(key);
                if (found !== undefined) values.delete(found);
            }
            behavior.afterDelete?.(values, key);
            return true;
        },
    });
    return { environment, values, deletions, reads: () => reads, find };
}
const required = [
    'HOMEDRIVE',
    'HOMEPATH',
    'LOGONSERVER',
    'PATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
];
function modeledWindowsSpawn(projected, native) {
    // Pinned Node lexical case deduplication, then libuv native-parent completion.
    // A pure model, not an observation of Windows behavior or a spawned process.
    const result = {};
    const seen = new Set();
    for (const key of Object.keys(projected).sort()) {
        const folded = key.toUpperCase();
        if (!seen.has(folded)) {
            result[key] = projected[key];
            seen.add(folded);
        }
    }
    for (const key of required) {
        const found = native.find(key);
        const value = native.values.get(found);
        if (!seen.has(key) && value !== undefined && value !== '') result[key] = value;
    }
    return result;
}
function staticRefusal(call) {
    let error;
    try {
        call();
    } catch (caught) {
        error = caught;
    }
    assert(error instanceof Error);
    assert(!String(error).includes(secret));
    assert(!String(error).includes(unknown));
    assert.equal(error.cause, undefined);
    return error;
}
function flagsFor(present) {
    return Object.fromEntries(
        queryOwnerRemovalNames.map((name) => [
            name,
            { present: present.includes(name), removed: present.includes(name), absent: true },
        ]),
    );
}

test('fixed query-only removal set contains exactly the four observed native names', () => {
    assert.deepEqual(queryOwnerRemovalNames, [
        'LOGONSERVER',
        'SYSTEMDRIVE',
        'USERDOMAIN',
        'USERNAME',
    ]);
    assert(Object.isFrozen(queryOwnerRemovalNames));
});
for (let mask = 0; mask < 16; mask++)
    test('one-way normalization of injected native presence subset ' + mask, () => {
        const present = queryOwnerRemovalNames.filter((_, i) => mask & (1 << i));
        const native = fakeNative([...base, ...present.map((name) => [name, secret])]);
        const normalized = normalizeQueryOwnerEnvironment(native.environment);
        assert.deepEqual(normalized.flags, flagsFor(present));
        assert.deepEqual(native.deletions, present);
        assert.equal(native.reads(), 0);
        assert.deepEqual([...native.values], base);
        normalized.assertAbsent();
        const projected = projectCollectorEnvironment(native.environment, childPATH);
        const child = modeledWindowsSpawn(projected, native);
        assert.doesNotThrow(() => requireLeafEnvironment(child, childPATH, () => assert.fail()));
        assert.equal(child.PATH, childPATH);
        assert(queryOwnerRemovalNames.every((name) => !Object.hasOwn(child, name)));
        assert(!JSON.stringify(normalized.flags).includes(secret));
    });
test('projected omission alone reinserts all four; native removal prevents modeled reinsertion', () => {
    const native = fakeNative([...base, ...queryOwnerRemovalNames.map((name) => [name, secret])]);
    const projected = projectCollectorEnvironment(native.environment, childPATH);
    assert(queryOwnerRemovalNames.every((name) => !Object.hasOwn(projected, name)));
    const before = modeledWindowsSpawn(projected, native);
    assert(queryOwnerRemovalNames.every((name) => Object.hasOwn(before, name)));
    assert.throws(
        () => requireLeafEnvironment(before, childPATH, () => {}),
        /Unexpected leaf environment key/,
    );
    normalizeQueryOwnerEnvironment(native.environment);
    const after = modeledWindowsSpawn(projected, native);
    assert.doesNotThrow(() => requireLeafEnvironment(after, childPATH, () => assert.fail()));
});
for (const [name, spelling] of [
    ['LOGONSERVER', 'LogonServer'],
    ['SYSTEMDRIVE', 'systemdrive'],
    ['USERDOMAIN', 'UserDomain'],
    ['USERNAME', 'username'],
])
    test('native case-insensitive removal uses fixed canonical target: ' + name, () => {
        const native = fakeNative([...base, [spelling, secret]]);
        const normalized = normalizeQueryOwnerEnvironment(native.environment);
        assert.deepEqual(native.deletions, [name]);
        assert(!native.values.has(spelling));
        assert.equal(normalized.flags[name].present, true);
        assert.equal(native.reads(), 0);
        // Case folding never becomes a leaf acceptance exception.
        assert.throws(
            () =>
                requireLeafEnvironment(
                    { PATH: childPATH, [spelling]: secret },
                    childPATH,
                    () => {},
                ),
            /Unexpected leaf environment key/,
        );
    });
for (const [one, two] of [
    ['USERNAME', 'UserName'],
    ['PATH', 'Path'],
    ['SystemRoot', 'SYSTEMROOT'],
    ['UNKNOWN_' + secret, 'unknown_' + secret.toLowerCase()],
    ['Straße', 'STRASSE'],
])
    test('case-folded duplicate refuses before any deletion, pair ' + one.length, () => {
        const native = fakeNative([
            ['LOGONSERVER', secret],
            [one, secret],
            [two, 'different synthetic value'],
        ]);
        const error = staticRefusal(() => normalizeQueryOwnerEnvironment(native.environment));
        assert.match(error.message, /case-ambiguous/);
        assert.deepEqual(native.deletions, []);
        assert.equal(native.values.size, 3);
        assert.equal(native.reads(), 0);
    });
for (const failure of ['deleteFalse', 'deleteThrow', 'deleteIneffective'])
    test('failed or ineffective native deletion refuses without a launch: ' + failure, () => {
        const native = fakeNative([...base, ['LOGONSERVER', secret], ['USERNAME', secret]], {
            [failure]: 'USERNAME',
        });
        let launches = 0;
        staticRefusal(() => {
            const normalized = normalizeQueryOwnerEnvironment(native.environment);
            normalized.beforeSpawn(
                () => {},
                () => launches++,
            );
        });
        assert.equal(launches, 0);
        assert.deepEqual(native.deletions, ['LOGONSERVER', 'USERNAME']);
        assert(native.values.has('USERNAME'));
        assert.equal(native.reads(), 0);
    });
test('a detached projected object cannot remove native parent completion', () => {
    const native = fakeNative([
        ['PATH', childPATH],
        ['USERNAME', secret],
    ]);
    const detached = projectCollectorEnvironment(native.environment, childPATH);
    normalizeQueryOwnerEnvironment(detached);
    assert(native.values.has('USERNAME'));
    assert.throws(
        () => requireLeafEnvironment(modeledWindowsSpawn(detached, native), childPATH, () => {}),
        /Unexpected leaf environment key/,
    );
    // Production separately binds environment === nativeOwnerEnvironment before mutation.
});
test('production binding rejects detached snapshots before any native or copied mutation', () => {
    const native = fakeNative(
        [
            ['PATH', childPATH],
            ['USERNAME', secret],
        ],
        { keysThrow: true },
    );
    const detached = { PATH: childPATH, USERNAME: secret };
    const error = staticRefusal(() => normalizeQueryOwnerEnvironment(detached, native.environment));
    assert.match(error.message, /Native-backed/);
    assert.deepEqual(native.deletions, []);
    assert(native.values.has('USERNAME'));
    assert(Object.hasOwn(detached, 'USERNAME'));
});
for (const stage of ['parent-WinPS', 'contract-WinPS', 'Node-leaf'])
    test('reappearance blocks the actual shared guarded launch method: ' + stage, () => {
        const native = fakeNative();
        const normalized = normalizeQueryOwnerEnvironment(native.environment);
        native.values.set('UserName', secret);
        let checked = 0;
        let launched = 0;
        staticRefusal(() =>
            normalized.beforeSpawn(
                () => checked++,
                () => launched++,
                stage,
            ),
        );
        assert.equal(checked, 0);
        assert.equal(launched, 0);
        assert.deepEqual(native.deletions, []); // Never retry normalization.
    });
test('reappearance during original admission check also refuses before launch', () => {
    const native = fakeNative();
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    let launched = 0;
    staticRefusal(() =>
        normalized.beforeSpawn(
            () => native.values.set('SYSTEMDRIVE', secret),
            () => launched++,
        ),
    );
    assert.equal(launched, 0);
    assert.deepEqual(native.deletions, []);
});
test('duplicate ambiguity appearing after normalization blocks the next helper', () => {
    const native = fakeNative();
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    native.values.set('unknown_' + secret.toLowerCase(), secret);
    native.values.set(unknown, secret);
    let launched = 0;
    staticRefusal(() =>
        normalized.beforeSpawn(
            () => {},
            () => launched++,
        ),
    );
    assert.equal(launched, 0);
});
test('preserves original admission failure and never calls launch', () => {
    const native = fakeNative();
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    const deadline = Error('Original work/cleanup deadline refused');
    let launched = 0;
    assert.throws(
        () =>
            normalized.beforeSpawn(
                () => {
                    throw deadline;
                },
                () => launched++,
            ),
        (error) => error === deadline,
    );
    assert.equal(launched, 0);
});
test('launch receives exact arguments once, and its handle returns without post-spawn operations', () => {
    const native = fakeNative([...base, ['USERNAME', secret]]);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    const handle = {};
    const args = ['fixed-executable', ['fixed-arg'], { shell: false }];
    let launched = 0;
    let checked = 0;
    const result = normalized.beforeSpawn(
        () => checked++,
        (...actual) => {
            launched++;
            assert.deepEqual(actual, args);
            native.values.set('USERNAME', secret); // Would make a post-spawn check throw.
            return handle;
        },
        ...args,
    );
    assert.equal(result, handle);
    assert.equal(checked, 1);
    assert.equal(launched, 1);
    assert.deepEqual(native.deletions, ['USERNAME']);
    staticRefusal(normalized.assertAbsent);
});
test('never restores removed values after launch throws', () => {
    const native = fakeNative([...base, ['USERNAME', secret]]);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    const failure = Error('Original spawn failed');
    assert.throws(
        () =>
            normalized.beforeSpawn(
                () => {},
                () => {
                    throw failure;
                },
            ),
        (e) => e === failure,
    );
    assert(!native.values.has('USERNAME'));
    assert.deepEqual(native.deletions, ['USERNAME']);
});
test('unknown owner keys survive normalization; arbitrary injected child keys still refuse', () => {
    const native = fakeNative([...base, ['USERNAME', secret], [unknown, secret]]);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    assert(native.values.has(unknown));
    assert(!JSON.stringify(normalized.flags).includes(unknown));
    const child = modeledWindowsSpawn(
        projectCollectorEnvironment(native.environment, childPATH),
        native,
    );
    child[unknown] = secret;
    const rows = [];
    assert.throws(
        () => requireLeafEnvironment(child, childPATH, (row) => rows.push(row)),
        /Unexpected leaf environment key/,
    );
    assert.equal(rows.length, 1);
    assert(!rows[0].includes(unknown));
    assert(!rows[0].includes(secret));
});
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'NODE_CHANNEL_FD', 'Path'])
    test('no loader, IPC or PATH case exception added: ' + name, () => {
        const native = fakeNative();
        normalizeQueryOwnerEnvironment(native.environment);
        assert.throws(
            () => requireLeafEnvironment({ PATH: childPATH, [name]: secret }, childPATH, () => {}),
            /Unexpected leaf environment key/,
        );
    });
test('exact PATH and preserved Windows/temp values stay unchanged; wrong PATH remains refusing', () => {
    const native = fakeNative([...base, ['USERNAME', secret]]);
    normalizeQueryOwnerEnvironment(native.environment);
    assert.deepEqual([...native.values], base);
    const child = modeledWindowsSpawn(
        projectCollectorEnvironment(native.environment, childPATH),
        native,
    );
    assert.equal(child.PATH, childPATH);
    child.PATH = secret;
    requireLeafEnvironment(child, childPATH, () => assert.fail());
    assert.throws(() => assert(child.PATH === childPATH, 'Leaf PATH binding'), /Leaf PATH binding/);
});
test('normalization reads no values, and evidence is fixed-name boolean flags only', () => {
    const native = fakeNative(
        [...base, ...queryOwnerRemovalNames.map((n) => [n, secret]), [unknown, secret]],
        { valuesThrow: true },
    );
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    assert.equal(native.reads(), 0);
    assert.deepEqual(Object.keys(normalized.flags), queryOwnerRemovalNames);
    assert(Object.isFrozen(normalized) && Object.isFrozen(normalized.flags));
    for (const value of Object.values(normalized.flags)) {
        assert(Object.isFrozen(value));
        assert.deepEqual(Object.keys(value), ['present', 'removed', 'absent']);
        assert(Object.values(value).every((x) => typeof x === 'boolean'));
    }
    const raw = JSON.stringify(normalized.flags);
    assert(!raw.includes(secret) && !raw.includes(unknown));
    assert(Buffer.byteLength(raw) < 512); // Fits an existing bounded start row, no new row/budget.
});
test('native enumeration exceptions are fixed refusals without key/value/error disclosure', () => {
    const native = fakeNative(base, { keysThrow: true });
    staticRefusal(() => normalizeQueryOwnerEnvironment(native.environment));
    assert.deepEqual(native.deletions, []);
});
for (const environment of [null, undefined, 1, 'bad', []])
    test('invalid injected environment fails closed, kind ' + typeof environment, () => {
        staticRefusal(() => normalizeQueryOwnerEnvironment(environment));
    });
test('normalization failure stays before modeled ready/grant/query effects', () => {
    const native = fakeNative([...base, ['USERNAME', secret]], { deleteIneffective: 'USERNAME' });
    const effects = { ready: 0, grant: 0, query: 0 };
    staticRefusal(() => {
        normalizeQueryOwnerEnvironment(native.environment);
        effects.ready++;
        effects.grant++;
        effects.query++;
    });
    assert.deepEqual(effects, { ready: 0, grant: 0, query: 0 });
});

test('full hosted pin admits only the exact four-removal transition and retains other bindings', () => {
    const native = fakeNative([...base, ...queryOwnerRemovalNames.map((n) => [n, secret])]);
    const binding = bindQueryOwnerEnvironment(native.environment);
    binding.check();
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    assert.throws(binding.check, /Host environment rebound/);
    binding.acceptNormalization(normalized);
    binding.check();
    assert.throws(() => binding.acceptNormalization(normalized), /already consumed/);
    native.values.set('PATH', 'changed-path');
    staticRefusal(binding.check);
});
for (const change of ['add', 'remove', 'value'])
    test('normalization transition never rebaselines another owner field: ' + change, () => {
        const native = fakeNative([...base, ['USERNAME', secret], [unknown, secret]]);
        const binding = bindQueryOwnerEnvironment(native.environment);
        const normalized = normalizeQueryOwnerEnvironment(native.environment);
        if (change === 'add') native.values.set('NEW_' + secret, secret);
        if (change === 'remove') native.values.delete('TEMP');
        if (change === 'value') native.values.set(unknown, 'changed');
        staticRefusal(() => binding.acceptNormalization(normalized));
        staticRefusal(binding.check); // Failed transition cannot bless the changed environment.
    });
test('four-removal transition refuses forged/foreign receipts and consumes failed attempts', () => {
    for (const kind of ['forged', 'foreign', 'null', 'undefined']) {
        const first = fakeNative([...base, ['USERNAME', secret]]);
        const second = fakeNative([...base, ['USERNAME', secret]]);
        const binding = bindQueryOwnerEnvironment(first.environment);
        const actual = normalizeQueryOwnerEnvironment(first.environment);
        const foreign = normalizeQueryOwnerEnvironment(second.environment);
        const proof = { forged: { flags: actual.flags }, foreign, null: null, undefined }[kind];
        staticRefusal(() => binding.acceptNormalization(proof));
        assert.throws(() => binding.acceptNormalization(actual), /already consumed/);
        staticRefusal(binding.check);
    }
});
test('changed pre-normalization presence cannot be hidden by a fresh normalization receipt', () => {
    const native = fakeNative();
    const binding = bindQueryOwnerEnvironment(native.environment);
    native.values.set('USERNAME', secret);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    assert.throws(() => binding.acceptNormalization(normalized), /presence binding changed/);
});
test('reappearance after the host transition fails both host binding and helper guard', () => {
    const native = fakeNative([...base, ['USERNAME', secret]]);
    const binding = bindQueryOwnerEnvironment(native.environment);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    binding.acceptNormalization(normalized);
    native.values.set('USERNAME', secret);
    staticRefusal(binding.check);
    let launched = 0;
    staticRefusal(() => normalized.beforeSpawn(binding.check, () => launched++));
    assert.equal(launched, 0);
});
test('full host pin read failures never disclose native values or exception text', () => {
    const native = fakeNative([...base, ['USERNAME', secret]]);
    const binding = bindQueryOwnerEnvironment(native.environment);
    native.values.set('PATH', 'changed');
    staticRefusal(binding.check);
    const throwing = fakeNative(base, { valuesThrow: true });
    staticRefusal(() => bindQueryOwnerEnvironment(throwing.environment));
});

test('all16 full-pin transitions preserve every other original native field', () => {
    for (let mask = 0; mask < 16; mask++) {
        const present = queryOwnerRemovalNames.filter((_, index) => mask & (1 << index));
        const native = fakeNative([...base, ...present.map((name) => [name, secret])]);
        const binding = bindQueryOwnerEnvironment(native.environment);
        const normalized = normalizeQueryOwnerEnvironment(native.environment);
        binding.acceptNormalization(normalized);
        binding.check();
        assert.deepEqual([...native.values], base);
    }
});
test('native deletion cannot conceal a simultaneous change to another pinned value', () => {
    const native = fakeNative([...base, ['USERNAME', secret]], {
        afterDelete(values) {
            values.set('PATH', 'changed');
        },
    });
    const binding = bindQueryOwnerEnvironment(native.environment);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    staticRefusal(() => binding.acceptNormalization(normalized));
});
test('read-only target-helper guard refuses reappearance without normalizing a leaf', () => {
    const leaf = fakeNative();
    assertQueryOwnerEnvironmentAbsent(leaf.environment);
    leaf.values.set('USERDOMAIN', secret);
    let queries = 0;
    staticRefusal(() => {
        assertQueryOwnerEnvironmentAbsent(leaf.environment);
        queries++;
    });
    assert.equal(queries, 0);
    assert.deepEqual(leaf.deletions, []);
    assert(leaf.values.has('USERDOMAIN'));
});

test('failure on another rebound value consumes transition; repairing it cannot authorize retry', () => {
    const native = fakeNative([...base, ['USERNAME', secret]]);
    const binding = bindQueryOwnerEnvironment(native.environment);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    native.values.set('PATH', 'changed');
    staticRefusal(() => binding.acceptNormalization(normalized));
    native.values.set('PATH', childPATH);
    assert.throws(() => binding.acceptNormalization(normalized), /already consumed/);
    staticRefusal(binding.check);
});
for (const name of ['LOGONſERVER', 'ſYSTEMDRIVE', 'UſERDOMAIN', 'UſERNAME'])
    test(
        'Unicode folding never turns an arbitrary spelling into a removal target, length ' +
            name.length,
        () => {
            const native = fakeNative([
                ['PATH', childPATH],
                [name, secret],
            ]);
            staticRefusal(() => normalizeQueryOwnerEnvironment(native.environment));
            assert.deepEqual(native.deletions, []);
            assert(native.values.has(name));
        },
    );
test('non-target prototype-like and Unicode owner names remain exactly pinned and undisclosed', () => {
    const native = fakeNative([
        ...base,
        ['USERNAME', secret],
        ['__proto__', secret],
        ['秘密', secret],
    ]);
    const binding = bindQueryOwnerEnvironment(native.environment);
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    binding.acceptNormalization(normalized);
    binding.check();
    assert(native.values.has('__proto__') && native.values.has('秘密'));
    assert(!JSON.stringify(normalized.flags).includes(secret));
    assert.deepEqual(Object.keys(normalized.flags), queryOwnerRemovalNames);
});

test('owner guard refusal is latched even if a rebound native field is later removed', () => {
    const native = fakeNative();
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    native.values.set('USERNAME', secret);
    staticRefusal(normalized.assertAbsent);
    native.values.delete('USERNAME');
    assert.throws(normalized.assertAbsent, /refusal latched/);
    let launched = 0;
    assert.throws(
        () =>
            normalized.beforeSpawn(
                () => {},
                () => launched++,
            ),
        /refusal latched/,
    );
    assert.equal(launched, 0);
});

test('host binding retains original strict Object.is value equality semantics', () => {
    const native = fakeNative([...base, ['NUMBER_A', NaN], ['NUMBER_B', -0]]);
    const binding = bindQueryOwnerEnvironment(native.environment);
    binding.check();
    const normalized = normalizeQueryOwnerEnvironment(native.environment);
    binding.acceptNormalization(normalized);
    binding.check();
    native.values.set('NUMBER_B', 0);
    staticRefusal(binding.check);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    leafEnvironmentRefusalRow,
    leafRefusalLimits,
    requireLeafEnvironment,
} from '../scripts/lib/security-query-leaf-refusal.mjs';
import {
    collectorEnvironmentKeys,
    projectCollectorEnvironment,
} from '../scripts/lib/product-collector-environment.mjs';

const childPATH = 'C:\\fixed-node;C:\\fixed-powershell';
const secret = 'SECRET_VALUE_MUST_NEVER_APPEAR_7d81';
function decoded(keys, expected = ['PATH']) {
    const text = leafEnvironmentRefusalRow(keys, expected);
    assert(Buffer.byteLength(text, 'utf8') <= 2048);
    assert(text.endsWith('\n'));
    assert.equal(text.split('\n').length, 2);
    assert(!text.includes(secret));
    const row = JSON.parse(text);
    assert.equal(row.kind, 'query-leaf-environment-refused');
    assert.equal(row.queryAdmitted, false);
    assert.equal(row.closureAttested, false);
    assert(row.classifications.length <= 8);
    return { text, row };
}
function refused(environment, writer) {
    const rows = [];
    assert.throws(
        () => requireLeafEnvironment(environment, childPATH, writer ?? ((row) => rows.push(row))),
        (error) =>
            error.code === 'ERR_ASSERTION' && error.message === 'Unexpected leaf environment key',
    );
    return rows;
}
function original(environment) {
    assert(
        Object.keys(environment).every((key) =>
            Object.hasOwn(projectCollectorEnvironment(environment, childPATH), key),
        ),
        'Unexpected leaf environment key',
    );
}
function outcome(call) {
    try {
        call();
        return { admitted: true };
    } catch (error) {
        return { admitted: false, code: error.code, message: error.message };
    }
}

test('explicit fixed limits keep diagnostics within the existing stderr budget', () => {
    assert.deepEqual(leafRefusalLimits, {
        bytes: 2048,
        classifications: 8,
        inspectedKeys: 256,
        reportedCount: 65535,
    });
    assert(Object.isFrozen(leafRefusalLimits));
});
test('accepted projected environment produces no row or writer call', () => {
    const environment = Object.fromEntries(collectorEnvironmentKeys.map((key) => [key, secret]));
    environment.PATH = childPATH;
    let writes = 0;
    assert.doesNotThrow(() => requireLeafEnvironment(environment, childPATH, () => writes++));
    assert.equal(writes, 0);
});
for (const name of ['LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME'])
    test('known Windows native name is classified but still refused: ' + name, () => {
        const rows = refused({ PATH: childPATH, [name]: secret });
        assert.equal(rows.length, 1);
        const { row } = decoded([name]);
        assert.deepEqual(row.classifications, [
            { category: 'windows-runtime-required-name', name },
        ]);
        assert.deepEqual(JSON.parse(rows[0]).classifications, row.classifications);
        assert(!rows[0].includes(secret));
    });
for (const name of ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'])
    test('residual known IPC name is classified without an admission exception: ' + name, () => {
        const rows = refused({ PATH: childPATH, [name]: secret });
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]).classifications, [
            { category: 'ipc-bootstrap-name', name },
        ]);
        assert(!rows[0].includes(secret));
    });
for (const [key, name] of [
    ['Path', 'PATH'],
    ['systemroot', 'SYSTEMROOT'],
    ['PROGRAMFILES', 'PROGRAMFILES'],
    ['psmodulepath', 'PSMODULEPATH'],
])
    test('case variant is identified without changing exact-spelling refusal: ' + key, () => {
        const rows = refused({ [key]: secret });
        assert.deepEqual(JSON.parse(rows[0]).classifications, [
            { category: 'projected-name-case-variant', name },
        ]);
        assert(!rows[0].includes(secret));
    });
test('known name omitted from projection is distinguished from a case variant', () => {
    const row = JSON.parse(refused({ TEMP: undefined })[0]);
    assert.deepEqual(row.classifications, [{ category: 'known-name-not-projected', name: 'TEMP' }]);
});
for (const key of [
    'UNKNOWN_' + secret,
    'NODE_OPTIONS_' + secret,
    'GITHUB_TOKEN_' + secret,
    'HUB_CAPABILITY_' + secret,
    '__proto__',
    'constructor',
    '\r\n{"kind":"injected"} ' + secret,
    '\u0000' + secret,
    '💣秘密' + secret,
    'WINDıR',
    'SYSTEMDRIVE' + 'x'.repeat(100000),
    '💣'.repeat(100000),
])
    test('unknown/malicious key text and values are never emitted, case ' + key.length, () => {
        const environment = Object.create(null);
        environment.PATH = childPATH;
        environment[key] = secret;
        const rows = refused(environment);
        assert.equal(rows.length, 1);
        const row = JSON.parse(rows[0]);
        assert.deepEqual(row.classifications, [{ category: 'unknown' }]);
        assert(!rows[0].includes(key));
        assert(!rows[0].includes(secret));
        assert(Buffer.byteLength(rows[0], 'utf8') <= 2048);
    });
test('only fixed recognized names appear in a mixed refusal row', () => {
    const { text, row } = decoded(['PATH', 'SYSTEMDRIVE', 'Path', 'NODE_CHANNEL_FD', secret]);
    assert.deepEqual(row.classifications, [
        { category: 'windows-runtime-required-name', name: 'SYSTEMDRIVE' },
        { category: 'projected-name-case-variant', name: 'PATH' },
        { category: 'ipc-bootstrap-name', name: 'NODE_CHANNEL_FD' },
        { category: 'unknown' },
    ]);
    assert.equal(row.observedKeyCount, 5);
    assert.equal(row.scannedKeyCount, 5);
    assert.equal(row.unexpectedKeyCount, 4);
    assert.equal(row.countsComplete, true);
    assert.equal(row.truncated, false);
    assert(!text.includes(secret));
});
test('eight longest fixed classifications fit the UTF8 bound including newline', () => {
    const { row, text } = decoded(Array(8).fill('NODE_CHANNEL_SERIALIZATION_MODE'));
    assert.equal(row.classifications.length, 8);
    assert.equal(row.truncated, false);
    assert(Buffer.byteLength(text, 'utf8') <= 2048);
});
test('every fixed classification shape fits with the maximum count fields', (t) => {
    const known = [
        ...collectorEnvironmentKeys,
        'PATH',
        'LOGONSERVER',
        'SYSTEMDRIVE',
        'USERDOMAIN',
        'USERNAME',
        'NODE_CHANNEL_FD',
        'NODE_CHANNEL_SERIALIZATION_MODE',
    ];
    const keys = Array(70000);
    let maximumBytes = 0;
    for (const key of [...known, ...known.map((name) => name.toLowerCase())]) {
        keys.fill(key, 0, 8);
        const { row, text } = decoded(keys, []);
        assert.equal(row.observedKeyCount, 65535);
        assert.equal(row.scannedKeyCount, 256);
        assert.equal(row.unexpectedKeyCount, 256);
        assert.equal(row.classifications.length, 8);
        assert.equal(row.countsComplete, false);
        assert.equal(row.truncated, true);
        maximumBytes = Math.max(maximumBytes, Buffer.byteLength(text, 'utf8'));
    }
    t.diagnostic('maximum fixed-shape UTF8 row including newline: ' + maximumBytes + ' bytes');
});
test('more than eight entries reports complete inspected counts and truncation', () => {
    const { row } = decoded(Array(20).fill(secret));
    assert.equal(row.classifications.length, 8);
    assert.equal(row.unexpectedKeyCount, 20);
    assert.equal(row.countsComplete, true);
    assert.equal(row.truncated, true);
});
test('large lists cap scanning and reported counts, without visiting a later accessor', () => {
    const keys = Array(70000).fill(secret);
    let touched = 0;
    Object.defineProperty(keys, 256, {
        get() {
            touched++;
            throw Error(secret);
        },
    });
    const { row } = decoded(keys);
    assert.equal(row.observedKeyCount, 65535);
    assert.equal(row.scannedKeyCount, 256);
    assert.equal(row.unexpectedKeyCount, 256);
    assert.equal(row.countsComplete, false);
    assert.equal(row.truncated, true);
    assert.equal(touched, 0);
});
test('formatter failures yield one fixed bounded fallback without exception details', () => {
    const hostile = new Proxy([], {
        get() {
            throw Error(secret);
        },
    });
    for (const [keys, expected] of [
        [hostile, []],
        [null, []],
        [[], Array(65).fill(secret)],
    ]) {
        const { row, text } = decoded(keys, expected);
        assert.equal(row.diagnosticUnavailable, true);
        assert.equal(row.countsComplete, false);
        assert.equal(row.truncated, true);
        assert.deepEqual(row.classifications, []);
        assert(!text.includes(secret));
    }
});
test('unknown environment value getters are not read', () => {
    let reads = 0;
    const environment = { PATH: childPATH };
    Object.defineProperty(environment, 'UNKNOWN_' + secret, {
        enumerable: true,
        get() {
            reads++;
            throw Error(secret);
        },
    });
    const rows = refused(environment);
    assert.equal(reads, 0);
    assert.equal(rows.length, 1);
    assert(!rows[0].includes(secret));
});
for (const behavior of ['throw', 'backpressure'])
    test('writer ' + behavior + ' never retries or admits the leaf', () => {
        let attempts = 0;
        refused({ PATH: childPATH, SYSTEMDRIVE: secret }, () => {
            attempts++;
            if (behavior === 'throw') throw Error(secret);
            return false;
        });
        assert.equal(attempts, 1);
    });
test('diagnostics never reproject or reread values after the first refused key', () => {
    let reads = 0;
    const environment = { UNKNOWN: secret };
    Object.defineProperty(environment, 'TEMP', {
        enumerable: true,
        get() {
            // The unchanged projection reads once in filter and once in map.
            if (++reads > 2) throw Error('Unexpected extra projection read');
            return secret;
        },
    });
    let writes = 0;
    refused(environment, () => writes++);
    assert.equal(writes, 1);
    assert.equal(reads, 2);
});
test('strict refusal remains before modeled ready/grant/query continuation', () => {
    const effects = { ready: 0, grant: 0, query: 0 };
    assert.throws(() => {
        requireLeafEnvironment({ USERNAME: secret }, childPATH, () => {});
        effects.ready++;
        effects.grant++;
        effects.query++;
    }, /Unexpected leaf environment key/);
    assert.deepEqual(effects, { ready: 0, grant: 0, query: 0 });
});
test('existing exact PATH value check is still a separate refusing obligation', () => {
    let writes = 0;
    const environment = { PATH: secret };
    requireLeafEnvironment(environment, childPATH, () => writes++);
    assert.equal(writes, 0);
    assert.throws(() => assert(environment.PATH === childPATH, 'Leaf PATH binding'), /Leaf PATH/);
});
test('all 256 synthetic key subsets preserve original admission/error semantics', () => {
    const keys = [
        'PATH',
        'TEMP',
        'SystemRoot',
        'SYSTEMDRIVE',
        'Path',
        'UNKNOWN',
        'NODE_OPTIONS',
        'USERNAME',
    ];
    for (let mask = 0; mask < 256; mask++) {
        const environment = Object.fromEntries(
            keys.filter((_, index) => mask & (1 << index)).map((key) => [key, secret]),
        );
        const rows = [];
        const expected = outcome(() => original(environment));
        const actual = outcome(() =>
            requireLeafEnvironment(environment, childPATH, (r) => rows.push(r)),
        );
        assert.deepEqual(actual, expected);
        assert.equal(rows.length, actual.admitted ? 0 : 1);
        assert(rows.every((r) => !r.includes(secret) && Buffer.byteLength(r, 'utf8') <= 2048));
    }
});
test('synthetic Windows-style case-insensitive reads do not relax enumerated-key acceptance', () => {
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'systemroot', 'Path', 'PATH', 'USERNAME']) {
        const target = { [key]: secret };
        const environment = new Proxy(target, {
            get(object, property) {
                if (typeof property !== 'string') return Reflect.get(object, property);
                const found = Object.keys(object).find(
                    (k) => k.toUpperCase() === property.toUpperCase(),
                );
                return found === undefined ? undefined : object[found];
            },
        });
        assert.deepEqual(
            outcome(() => requireLeafEnvironment(environment, childPATH, () => {})),
            outcome(() => original(environment)),
        );
    }
});

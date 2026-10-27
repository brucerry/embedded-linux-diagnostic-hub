import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
    assertWindowsSetupOutput,
    inventoryWindowsSetupInput,
    writeSetupPayloadDescriptor,
    revalidateWindowsSetupInput,
} from '../scripts/lib/windows-setup-input.mjs';
const root = '/input',
    name = 'diagnostic-hub-setup-payload.json',
    reserved = [
        name,
        '.diagnostic-hub-installation.json',
        '.diagnostic-hub-release.json',
        '.diagnostic-hub-ownership.json',
        'Uninstall Diagnostic Hub.exe',
    ];
function memory() {
    const nodes = new Map();
    let next = 1;
    const log = [];
    let hook = null;
    const add = (file, bytes = 'test payload', extra = {}) =>
        nodes.set(file.toLowerCase(), {
            file,
            bytes: Buffer.from(bytes),
            ino: next++,
            mtimeMs: 1,
            ctimeMs: 1,
            mode: 0o100644,
            nlink: 1,
            symlink: false,
            ...extra,
        });
    const stat = (node) => ({
        dev: 1,
        ino: node.ino,
        size: node.declaredSize ?? node.bytes.length,
        mtimeMs: node.mtimeMs,
        ctimeMs: node.ctimeMs,
        mode: node.mode,
        nlink: node.nlink,
        isFile: () => !node.dir && !node.symlink,
        isDirectory: () => !!node.dir,
        isSymbolicLink: () => node.symlink,
    });
    const get = (file) => {
        const n = nodes.get(file.toLowerCase());
        assert(n, 'inert node missing');
        return n;
    };
    const fs = {
        async readdir(dir) {
            log.push(['readdir', dir]);
            return [...nodes.values()]
                .filter((n) => path.dirname(n.file) === dir)
                .map((n) => path.basename(n.file));
        },
        async lstat(file) {
            log.push(['lstat', file]);
            return stat(get(file));
        },
        async open(file) {
            log.push(['open', file]);
            const node = get(file);
            let at = 0;
            return {
                stat: async () => stat(node),
                async read(buffer, offset, length) {
                    log.push(['read', file, length]);
                    if (hook) hook(file, node, at);
                    const n = Math.min(length, Math.max(0, node.bytes.length - at));
                    node.bytes.copy(buffer, offset, at, at + n);
                    at += n;
                    return { bytesRead: n };
                },
                close: async () => {
                    log.push(['close', file]);
                },
            };
        },
        async writeFile(file, bytes, options) {
            log.push(['write', file, options.flag]);
            assert.equal(options.flag, 'wx');
            if (nodes.has(file.toLowerCase()))
                throw Object.assign(Error('EXISTS'), { code: 'EEXIST' });
            add(file, bytes);
        },
    };
    return {
        nodes,
        log,
        fs,
        add,
        setHook(fn) {
            hook = fn;
        },
    };
}
const inventory = (m) => inventoryWindowsSetupInput(root, { fs: m.fs, reservedNames: reserved });
test('Windows case alias counterexample is refused while sibling output remains allowed', () => {
    assert.equal('C:\\HUB\\setup.exe'.startsWith('C:\\Hub' + path.win32.sep), false);
    for (const out of [
        'C:\\HUB\\setup.exe',
        'C:\\hub',
        'C:\\Hub\\nested\\setup.exe',
        'C:\\Hub\\..\\Hub\\setup.exe',
    ])
        assert.throws(() => assertWindowsSetupOutput('C:\\Hub', out));
    for (const out of ['C:\\Hub2\\setup.exe', 'D:\\build\\setup.exe', 'C:\\build\\setup.exe'])
        assert.doesNotThrow(() => assertWindowsSetupOutput('C:\\Hub', out));
    assert.throws(() => assertWindowsSetupOutput('relative', 'C:\\build\\setup.exe'));
});
for (const kind of ['file', 'symlink', 'directory', 'case-alias'])
    test('reserved metadata collision preserves existing ' + kind, async () => {
        const m = memory();
        const actual = kind === 'case-alias' ? name.toUpperCase() : name;
        m.add(root + '/' + actual, 'operator preimage', {
            symlink: kind === 'symlink',
            dir: kind === 'directory',
        });
        const before = Buffer.from([...m.nodes.values()][0].bytes);
        await assert.rejects(inventory(m), /Reserved setup metadata/);
        assert.equal(
            m.log.some((v) => v[0] === 'open' || v[0] === 'write'),
            false,
        );
        assert.deepEqual([...m.nodes.values()][0].bytes, before);
    });
test('exclusive descriptor creation refuses a raced collision without overwrite or deletion', async () => {
    const m = memory();
    m.add(root + '/app.bin');
    await inventory(m);
    m.add(root + '/' + name, 'raced-in preimage');
    await assert.rejects(writeSetupPayloadDescriptor(root, name, 'new manifest', m.fs));
    assert.equal(
        m.nodes.get((root + '/' + name).toLowerCase()).bytes.toString(),
        'raced-in preimage',
    );
});
test('own new descriptor can be revalidated while all original payload facts remain exact', async () => {
    const m = memory();
    m.add(root + '/app.bin');
    const before = await inventory(m);
    const own = await writeSetupPayloadDescriptor(root, name, '{"fixture":true}', m.fs);
    await revalidateWindowsSetupInput(root, before, {
        fs: m.fs,
        reservedNames: reserved,
        ownDescriptor: own,
    });
    assert.equal(m.nodes.size, 2);
    assert.equal(m.log.filter((v) => v[0] === 'write').length, 1);
});
for (const kind of ['grown', 'truncated', 'same-size-change', 'path-replaced'])
    test('stable inventory refuses ' + kind + ' during read', async () => {
        const m = memory();
        m.add(root + '/app.bin', 'abc');
        let fired = false;
        m.setHook((file, node) => {
            if (fired) return;
            fired = true;
            if (kind === 'grown') node.bytes = Buffer.from('abcdef');
            else if (kind === 'truncated') node.bytes = Buffer.from('a');
            else if (kind === 'same-size-change') {
                node.bytes = Buffer.from('xyz');
                node.mtimeMs++;
            } else m.nodes.set(file.toLowerCase(), { ...node, ino: 100 });
        });
        await assert.rejects(inventory(m));
        assert.equal(m.log.filter((v) => v[0] === 'close').length, 1);
        assert.equal(
            m.log.some((v) => v[0] === 'write'),
            false,
        );
    });
test('precompiler recheck refuses changed payload or changed own descriptor and retains both', async () => {
    for (const target of ['app.bin', name]) {
        const m = memory();
        m.add(root + '/app.bin');
        const before = await inventory(m);
        const own = await writeSetupPayloadDescriptor(root, name, 'new descriptor', m.fs);
        const n = m.nodes.get((root + '/' + target).toLowerCase());
        n.bytes = Buffer.from('changed input');
        n.ctimeMs++;
        await assert.rejects(
            revalidateWindowsSetupInput(root, before, {
                fs: m.fs,
                reservedNames: reserved,
                ownDescriptor: own,
            }),
        );
        assert.equal(m.nodes.size, 2);
    }
});
test('byte size and link guards refuse before opening payload contents', async () => {
    for (const extra of [{ declaredSize: 2 * 1024 ** 3 + 1 }, { nlink: 2 }, { symlink: true }]) {
        const m = memory();
        m.add(root + '/app.bin', 'x', extra);
        await assert.rejects(inventory(m));
        assert.equal(
            m.log.some((v) => v[0] === 'open'),
            false,
        );
    }
});
test('actual packager uses guarded inventory exclusive descriptor and recheck immediately before compiler spawn', () => {
    const source = readFileSync(
        new URL('../scripts/package-windows-setup.mts', import.meta.url),
        'utf8',
    );
    const file = ts.createSourceFile(
        'packager.mts',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    assert.equal(file.parseDiagnostics.length, 0);
    const calls = [];
    function visit(n) {
        if (ts.isCallExpression(n)) calls.push(n);
        ts.forEachChild(n, visit);
    }
    visit(file);
    const call = (name) => {
        const result = calls.filter((n) => n.expression.getText(file) === name);
        assert.equal(result.length, 1, name);
        return result[0];
    };
    assert(call('assertWindowsSetupOutput').pos < call('inventoryWindowsSetupInput').pos);
    assert(call('inventoryWindowsSetupInput').end < call('validateWindowsPayloadPackage').pos);
    assert(call('validateWindowsPayloadPackage').end < call('writeSetupPayloadDescriptor').pos);
    assert(call('tooling.getMakeNsisPath').end < call('revalidateWindowsSetupInput').pos);
    assert(call('revalidateWindowsSetupInput').end < call('spawn').pos);
    assert(!source.includes('if (directory === root && [SETUP_PAYLOAD].includes(name)) continue;'));
    assert(!source.includes('writeFile(path.join(root, SETUP_PAYLOAD)'));
});

test('precompiler recheck requires the owned descriptor still be present', async () => {
    const m = memory();
    m.add(root + '/app.bin');
    const before = await inventory(m);
    const own = await writeSetupPayloadDescriptor(root, name, 'new descriptor', m.fs);
    m.nodes.delete((root + '/' + name).toLowerCase()); // In-memory absence only; no filesystem deletion.
    await assert.rejects(
        revalidateWindowsSetupInput(root, before, {
            fs: m.fs,
            reservedNames: reserved,
            ownDescriptor: own,
        }),
        /disappeared/,
    );
});
test('descriptor writer refuses arbitrary traversal or alternate names before any effect', async () => {
    for (const invalid of ['..', '../foreign', 'alternate.json']) {
        const m = memory();
        await assert.rejects(writeSetupPayloadDescriptor(root, invalid, 'data', m.fs));
        assert.equal(m.log.length, 0);
    }
});
test('file replacement between lstat and open is rejected before content read', async () => {
    const m = memory();
    m.add(root + '/app.bin');
    const original = m.fs.open;
    m.fs.open = async (file) => {
        m.nodes.get(file.toLowerCase()).ino++;
        return original(file);
    };
    await assert.rejects(inventory(m), /identity changed before reading/);
    assert.equal(
        m.log.some((v) => v[0] === 'read'),
        false,
    );
    assert.equal(m.log.filter((v) => v[0] === 'close').length, 1);
});

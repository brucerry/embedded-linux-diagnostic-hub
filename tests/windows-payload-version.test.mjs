import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { validateWindowsPayloadPackage } from '../scripts/lib/windows-setup-release.mjs';
const metadata = (values = {}) =>
    Buffer.from(
        JSON.stringify({ name: 'embedded-linux-diagnostic-hub', version: '0.6.0', ...values }),
    );
test('embedded payload version and product must match before setup labels can be issued', () => {
    assert.deepEqual(validateWindowsPayloadPackage(metadata(), '0.6.0'), {
        name: 'embedded-linux-diagnostic-hub',
        version: '0.6.0',
    });
    for (const update of [
        { version: '0.5.2' },
        { version: '0.7.0' },
        { version: null },
        { name: 'foreign-app' },
        { name: undefined },
    ])
        assert.throws(() => validateWindowsPayloadPackage(metadata(update), '0.6.0'));
});
test('payload previews remain exact and cannot be relabelled as stable or another preview', () => {
    const bytes = metadata({ version: '0.6.0-rc.1' });
    assert.equal(validateWindowsPayloadPackage(bytes, '0.6.0-rc.1').version, '0.6.0-rc.1');
    for (const selected of ['0.6.0', '0.6.0-rc.2'])
        assert.throws(() => validateWindowsPayloadPackage(bytes, selected));
});
test('invalid selected version and malformed unbounded or undecodable metadata refuse', () => {
    for (const selected of [null, undefined, 1, 'v0.6.0', 'bad'])
        assert.throws(() => validateWindowsPayloadPackage(metadata(), selected));
    for (const bytes of [
        Buffer.alloc(0),
        Buffer.alloc(65537),
        Buffer.from('[]'),
        Buffer.from('null'),
        Buffer.from('{bad'),
        Buffer.from([0xff]),
        'not a buffer',
    ])
        assert.throws(() => validateWindowsPayloadPackage(bytes, '0.6.0'));
});
test('metadata exact byte boundary is accepted without claiming build or publisher provenance', () => {
    const base = metadata(),
        padded = Buffer.concat([base, Buffer.alloc(65536 - base.length, 32)]);
    const facts = validateWindowsPayloadPackage(padded, '0.6.0');
    assert.deepEqual(Object.keys(facts).sort(), ['name', 'version']);
    assert.throws(() =>
        validateWindowsPayloadPackage(Buffer.concat([padded, Buffer.from(' ')]), '0.6.0'),
    );
});
test('actual packager invokes embedded-package guard after inventory and before every compiler or output write', () => {
    const text = readFileSync(
        new URL('../scripts/package-windows-setup.mts', import.meta.url),
        'utf8',
    );
    const file = ts.createSourceFile(
        'package-windows-setup.mts',
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    assert.equal(file.parseDiagnostics.length, 0);
    const calls = [];
    function visit(node) {
        if (ts.isCallExpression(node)) calls.push(node);
        ts.forEachChild(node, visit);
    }
    visit(file);
    const guard = calls.filter(
        (n) => n.expression.getText(file) === 'validateWindowsPayloadPackage',
    );
    assert.equal(guard.length, 1);
    const args = guard[0].arguments;
    assert.equal(args.length, 2);
    assert.equal(args[1].getText(file), 'version');
    assert.match(
        args[0].getText(file),
        /^extractFile\(path.join\(root, 'resources', 'app.asar'\), 'package.json'\)$/,
    );
    const inventory = calls.find(
        (n) =>
            n.expression.getText(file) === 'inventoryWindowsSetupInput' &&
            n.arguments[0]?.getText(file) === 'root',
    );
    assert(inventory.end < guard[0].pos);
    for (const call of calls.filter((n) =>
        [
            'writeFile',
            'writeSetupPayloadDescriptor',
            'spawn',
            'writeWindowsSetupInfo',
            'tooling.getMakeNsisPath',
        ].includes(n.expression.getText(file)),
    ))
        assert(call.pos > guard[0].end, call.expression.getText(file));
});

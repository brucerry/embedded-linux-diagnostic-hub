import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TypeScript from 'typescript';
import { verifyDesktopPackageBundles } from '../scripts/lib/desktop-package-bundles.mjs';

// The declared compiler is used only as a parser, never to load a verifier entrypoint.
const ts: typeof TypeScript = createRequire(path.resolve('package.json'))('typescript');
const required = ['dist-electron/main.cjs', 'dist-electron/preload.cjs'];
function fixture() {
    const built = new Map(required.map((file) => [file, Buffer.from('synthetic ' + file)]));
    const packaged = new Map([...built].map(([file, bytes]) => [file, Buffer.from(bytes)]));
    const calls: string[] = [];
    const read = (side: string, files: Map<string, Buffer>, file: string) => {
        calls.push(side + ':' + file);
        const bytes = files.get(file);
        if (!bytes) throw Error('Missing ' + side + ': ' + file);
        return bytes;
    };
    return {
        built,
        packaged,
        calls,
        readBuild: (file: string) => read('build', built, file),
        readPackaged: async (file: string) => read('package', packaged, file),
    };
}
test('required bundle pairs are read without enumeration and compared without mutation', async () => {
    const f = fixture();
    const before = [...f.built, ...f.packaged].map(([file, bytes]) => [file, bytes.toString('hex')]);
    assert.equal(await verifyDesktopPackageBundles(f), undefined);
    assert.deepEqual(f.calls, required.flatMap((file) => ['build:' + file, 'package:' + file]));
    assert.deepEqual(
        [...f.built, ...f.packaged].map(([file, bytes]) => [file, bytes.toString('hex')]),
        before,
    );
});
for (const file of required) {
    test('missing local output refuses despite present packaged member: ' + file, async () => {
        const f = fixture();
        f.built.delete(file); // Synthetic Map entry only; no filesystem operations.
        await assert.rejects(verifyDesktopPackageBundles(f), {
            message: 'Missing build: ' + file,
        });
        assert.equal(f.packaged.has(file), true);
        assert.equal(f.calls.includes('package:' + file), false);
    });
    test('missing packaged member refuses despite present build output: ' + file, async () => {
        const f = fixture();
        f.packaged.delete(file);
        await assert.rejects(verifyDesktopPackageBundles(f), {
            message: 'Missing package: ' + file,
        });
        assert.equal(f.built.has(file), true);
    });
    test('altered packaged bytes refuse: ' + file, async () => {
        const f = fixture();
        f.packaged.set(file, Buffer.from('different bytes'));
        const before = Buffer.from(f.built.get(file)!);
        await assert.rejects(verifyDesktopPackageBundles(f), {
            message: 'Packaged bundle mismatch: ' + file,
        });
        assert.deepEqual(f.built.get(file), before);
    });
}
test('synchronous build-reader failure retains original error and does not extract', async () => {
    const failure = Error('synthetic build read failure');
    await assert.rejects(
        verifyDesktopPackageBundles({
            readBuild: () => {
                throw failure;
            },
            readPackaged: () => assert.fail('unexpected package read'),
        }),
        (error) => error === failure,
    );
});
test('asynchronous package-reader failure retains original error and stops further reads', async () => {
    const failure = Error('synthetic package read failure');
    const seen: string[] = [];
    await assert.rejects(
        verifyDesktopPackageBundles({
            readBuild: (file) => {
                seen.push(file);
                return Buffer.from('synthetic');
            },
            readPackaged: async () => {
                throw failure;
            },
        }),
        (error) => error === failure,
    );
    assert.deepEqual(seen, [required[0]]);
});
test('non-buffer reader results cannot produce a successful comparison', async () => {
    await assert.rejects(
        verifyDesktopPackageBundles({
            readBuild: () => 'synthetic' as unknown as Buffer,
            readPackaged: () => Buffer.from('synthetic'),
        }),
        { message: 'Expected bundle bytes: ' + required[0] },
    );
});

function source(file: string) {
    const text = readFileSync(path.resolve(file), 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.equal(
        (ast as TypeScript.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length,
        0,
    );
    const calls: TypeScript.CallExpression[] = [];
    const strings: string[] = [];
    function visit(node: TypeScript.Node) {
        if (ts.isCallExpression(node)) calls.push(node);
        if (ts.isStringLiteral(node)) strings.push(node.text);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    const one = (name: string) => {
        const found = calls.filter((call) => call.expression.getText(ast) === name);
        assert.equal(found.length, 1, name);
        return found[0];
    };
    return { ast, calls, strings, one };
}
const sites = [
    ['scripts/verify-package.mjs', 'fs.readFileSync(file)', 'extractFile(archive, file)'],
    ['scripts/verify-macos-package.mjs', 'readFileSync(file)', 'extractFile(archive, file)'],
    ['scripts/verify-linux-package.mjs', 'readFile(file)', 'extractFile(archive, file)'],
    [
        'scripts/package-windows-setup.mts',
        'readFile(file)',
        "extractFile(path.join(root, 'resources', 'app.asar'), file)",
    ],
] as const;
for (const [file, buildReader, packageReader] of sites) {
    test('actual callsite unconditionally awaits fixed bundle guard: ' + file, () => {
        const s = source(file);
        const imports = s.ast.statements
            .filter(ts.isImportDeclaration)
            .filter(
                (node) =>
                    ts.isStringLiteral(node.moduleSpecifier) &&
                    node.moduleSpecifier.text === './lib/desktop-package-bundles.mjs',
            );
        assert.equal(imports.length, 1);
        const bindings = imports[0].importClause?.namedBindings;
        assert(bindings && ts.isNamedImports(bindings));
        assert.equal(bindings.elements.length, 1);
        assert.equal(bindings.elements[0].name.text, 'verifyDesktopPackageBundles');
        assert.equal(bindings.elements[0].propertyName, undefined);
        const guard = s.one('verifyDesktopPackageBundles');
        assert(ts.isAwaitExpression(guard.parent));
        assert(ts.isExpressionStatement(guard.parent.parent));
        for (let node: TypeScript.Node | undefined = guard.parent; node; node = node.parent) {
            assert(
                !ts.isIfStatement(node) &&
                    !ts.isSwitchStatement(node) &&
                    !ts.isForStatement(node) &&
                    !ts.isForOfStatement(node) &&
                    !ts.isForInStatement(node) &&
                    !ts.isWhileStatement(node) &&
                    !ts.isDoStatement(node),
                'guard must not depend on a conditional or enumeration',
            );
        }
        assert.equal(guard.arguments.length, 1);
        const readers = guard.arguments[0];
        assert(ts.isObjectLiteralExpression(readers));
        assert.equal(readers.properties.length, 2);
        for (const [name, expected] of [['readBuild', buildReader], ['readPackaged', packageReader]]) {
            const reader: TypeScript.ObjectLiteralElementLike | undefined = readers.properties.find(
                (node) => node.name?.getText(s.ast) === name,
            );
            assert(
                reader &&
                    ts.isPropertyAssignment(reader) &&
                    ts.isArrowFunction(reader.initializer),
            );
            assert.equal(reader.initializer.parameters.length, 1);
            assert.equal(reader.initializer.parameters[0].name.getText(s.ast), 'file');
            assert.equal(reader.initializer.body.getText(s.ast), expected);
        }
        if (file !== 'scripts/package-windows-setup.mts')
            assert.equal(
                s.strings.includes('dist-electron'),
                false,
                'old desktop directory enumeration removed',
            );
        if (file === 'scripts/verify-linux-package.mjs') {
            s.one('validateLinuxReviewCapability');
            assert(
                s.calls.some(
                    (call) =>
                        call.expression.getText(s.ast) === 'readFile' &&
                        call.arguments[0]?.getText(s.ast) ===
                            "'dist-electron/linux-setup-review.cjs'",
                ),
            );
            assert(
                s.calls.some(
                    (call) =>
                        call.expression.getText(s.ast) === 'extractFile' &&
                        call.arguments[1]?.getText(s.ast) ===
                            "'dist-electron/linux-setup-review.cjs'",
                ),
            );
            assert(
                s.calls.some(
                    (call) =>
                        call.expression.getText(s.ast) === 'reviewEntry.equals' &&
                        call.arguments[0]?.getText(s.ast) === 'physicalReview',
                ),
            );
            assert(s.strings.includes('resources/linux-setup-review.json'));
        }
    });
}
test('setup verifies bundles before publication and retains inventory recheck before compiler spawn', () => {
    const s = source('scripts/package-windows-setup.mts');
    const guard = s.one('verifyDesktopPackageBundles');
    assert(s.one('inventoryWindowsSetupInput').end < s.one('validateWindowsPayloadPackage').pos);
    assert(s.one('validateWindowsPayloadPackage').end < guard.pos);
    for (const name of [
        'writeSetupPayloadDescriptor',
        'mkdir',
        'writeFile',
        'tooling.getMakeNsisPath',
        'spawn',
        'writeWindowsSetupInfo',
    ])
        assert(guard.end < s.one(name).pos, name);
    assert(s.one('writeSetupPayloadDescriptor').end < s.one('revalidateWindowsSetupInput').pos);
    assert(s.one('revalidateWindowsSetupInput').end < s.one('spawn').pos);
    assert.equal(s.one('revalidateWindowsSetupInput').arguments[1].getText(s.ast), 'initialInventory');
});

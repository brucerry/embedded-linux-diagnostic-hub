import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import { rolldown, VERSION as rolldownVersion } from 'rolldown';
import { Script } from 'node:vm';
import {
    updaterMemoryTests,
    updaterMemoryPath,
    updaterTestEnvironment,
    assertUpdaterSourcePath,
    assertUpdaterBundle,
    assertUpdaterOutput,
    assertUpdaterCommand,
    observeUpdaterCommand,
} from './lib/updater-memory-test-plan.mjs';

// Compiler experiment only. The shipping updater runner and release memory policy are unchanged.
assert.equal(process.argv.length, 2, 'This test lane takes no selectors or overrides.');
const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url),
    read = (p) => fs.readFileSync(p, 'utf8');
assert.equal(require('path').posix, path.posix, 'The adapter must use the Node core path API.');
const lock = JSON.parse(read(path.join(root, 'package-lock.json')));
assert.equal(rolldownVersion, lock.packages['node_modules/rolldown'].version);
const semverManifest = fs.realpathSync(require.resolve('semver/package.json'));
const semverRoot = path.dirname(semverManifest);
assert.equal(
    JSON.parse(read(semverManifest)).version,
    lock.packages['node_modules/semver'].version,
);
const typescriptManifest = fs.realpathSync(require.resolve('typescript/package.json'));
assert.equal(
    JSON.parse(read(typescriptManifest)).version,
    lock.packages['node_modules/typescript'].version,
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const captured = new Map();
function insideSemver(file) {
    const relative = path.relative(semverRoot, file);
    return relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
}
const guard = fileURLToPath(new URL('./lib/updater-memory-network-guard.cjs', import.meta.url));
for (const file of [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./lib/updater-memory-test-plan.mjs', import.meta.url)),
    guard,
    semverManifest,
    typescriptManifest,
    path.join(root, 'package-lock.json'),
]) {
    assert.equal(fs.realpathSync(file), file);
    captured.set(file, digest(fs.readFileSync(file)));
}
const fixtures = [...new Set(updaterMemoryTests.map((value) => value.fixture))];

// Read-only source admission precedes temporary writes or execution. Only the checked-in
// five entries, their relative closure, pure semver and the two FS aliases are supported.
for (const fixture of fixtures) {
    const queue = updaterMemoryTests
            .filter((value) => value.fixture === fixture)
            .map((value) => value.entry),
        seen = new Set();
    while (queue.length) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);
        assertUpdaterSourcePath(name);
        const file = path.join(root, name);
        assert.equal(fs.realpathSync(file), file);
        const bytes = fs.readFileSync(file);
        captured.set(file, digest(bytes));
        if (name.endsWith('.json')) {
            JSON.parse(bytes);
            continue;
        }
        const tree = ts.createSourceFile(name, bytes.toString(), ts.ScriptTarget.Latest, true);
        assert.equal(tree.parseDiagnostics.length, 0);
        for (const node of tree.statements)
            if (
                (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                node.moduleSpecifier
            ) {
                const spec = node.moduleSpecifier.text;
                if (
                    node.isTypeOnly ||
                    node.importClause?.isTypeOnly ||
                    (node.importClause &&
                        !node.importClause.name &&
                        node.importClause.namedBindings &&
                        ts.isNamedImports(node.importClause.namedBindings) &&
                        node.importClause.namedBindings.elements.every((x) => x.isTypeOnly))
                )
                    continue;
                if (['node:fs', 'node:fs/promises'].includes(spec)) queue.push(fixture);
                else if (spec === 'node:path') queue.push(updaterMemoryPath);
                else if (spec === 'path') assert.equal(name, updaterMemoryPath);
                else if (spec.startsWith('.')) {
                    const stem = path.posix.normalize(
                        path.posix.join(path.posix.dirname(name), spec),
                    );
                    assertUpdaterSourcePath(stem);
                    const found = [stem, stem + '.ts', stem + '.json', stem + '/index.ts'].filter(
                        (p) => fs.existsSync(path.join(root, p)),
                    );
                    assert.equal(found.length, 1);
                    queue.push(found[0]);
                } else
                    assert.ok(
                        ['node:assert/strict', 'node:test', 'node:crypto', 'semver'].includes(spec),
                        'Unreviewed updater test import.',
                    );
            }
        function visit(node) {
            if (ts.isCallExpression(node)) {
                assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword);
                if (ts.isIdentifier(node.expression))
                    assert.ok(!['require', 'eval'].includes(node.expression.text));
            }
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
                assert.notEqual(node.expression.text, 'Function');
                if (node.expression.text === 'ReleaseUpdater')
                    assert.ok(node.arguments.length >= 6, 'Inject the request double.');
            }
            ts.forEachChild(node, visit);
        }
        visit(tree);
    }
}
const temporaryParent = os.tmpdir();
updaterTestEnvironment(process.env, process.execPath, temporaryParent, process.platform);
const stage = fs.mkdtempSync(path.join(fs.realpathSync(temporaryParent), 'hub-updater-tests-'));
const env = updaterTestEnvironment(process.env, process.execPath, stage, process.platform);
let serial = 0;
async function command(args) {
    const value = await observeUpdaterCommand(
        spawn(args[0], args.slice(1), {
            cwd: root,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
        }),
        {
            onDeadline: () =>
                console.error('Updater test deadline exceeded; child custody retained at ' + stage),
        },
    );
    const prefix = path.join(stage, String(++serial));
    fs.writeFileSync(prefix + '.stdout', value.stdout, { flag: 'wx' });
    fs.writeFileSync(prefix + '.stderr', value.stderr, { flag: 'wx' });
    fs.writeFileSync(
        prefix + '.json',
        JSON.stringify({ ...value, stdout: undefined, stderr: undefined }, null, 2),
        { flag: 'wx' },
    );
    assertUpdaterCommand(value);
    return value.stdout.toString();
}
function unchanged() {
    for (const [file, hash] of captured)
        assert.equal(digest(fs.readFileSync(file)), hash, 'Test input changed during execution.');
}
async function compile(entry, fixture, output, probe = undefined) {
    unchanged();

    const entryPath = path.resolve(root, entry);
    const realFixture = path.join(root, fixture);
    const pathFixture = path.join(root, updaterMemoryPath);
    const externals = ['node:assert/strict', 'node:test', 'node:crypto', 'path'];
    const bundle = await rolldown({
        input: entryPath,
        cwd: root,
        platform: 'neutral',
        external: externals,
        plugins: [{
            name: 'fixed-updater-memory-aliases',
            resolveId(source) {
                if (source === 'node:fs' || source === 'node:fs/promises') return realFixture;
                if (source === 'node:path') return pathFixture;
            },
        }],
        onLog(level, info, handler) {
            if (info.code === 'UNRESOLVED_IMPORT') throw new Error(info.message);
            handler(level, info);
        },
    });
    try {
        const filename = path.basename(output);
        const generated = await bundle.generate({
            format: 'cjs',
            entryFileNames: filename,
            codeSplitting: false,
        });
        assert.equal(generated.output.length, 1);
        const [chunk] = generated.output;
        assert.equal(chunk.type, 'chunk');
        assert.equal(chunk.fileName, filename);
        assert.ok(chunk.dynamicImports.every((name) => name === filename));
        assert.ok(Buffer.byteLength(chunk.code) <= 2 * 1024 ** 2, 'Updater test bundle is oversized.');
        assert.equal(fs.realpathSync(chunk.facadeModuleId), fs.realpathSync(entryPath));
        const inputs = Object.keys(chunk.modules).map((name) => fs.realpathSync(name));
        for (const file of inputs) {
            assert.ok(
                file === probe || captured.has(file) || insideSemver(file),
                'Compiler discovered a file outside the prechecked source closure.',
            );
        }
        assertUpdaterBundle(
            { outputs: { [output]: { imports: chunk.imports.map((name) => ({ path: name, external: true })) } } },
            inputs,
            { root, semverRoot, fixture: realFixture, probe, output, pathFixture },
        );
        new Script(chunk.code, { filename });
        fs.writeFileSync(output, chunk.code, { flag: 'wx' });
    } finally {
        await bundle.close();
    }
    const tree = ts.createSourceFile(
        output,
        read(output),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    assert.equal(tree.parseDiagnostics.length, 0);
    function visit(node) {
        assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'
        )
            assert.ok(
                node.arguments.length === 1 &&
                    ts.isStringLiteral(node.arguments[0]) &&
                    ['node:assert/strict', 'node:test', 'node:crypto', 'path'].includes(
                        node.arguments[0].text,
                    ),
            );
        ts.forEachChild(node, visit);
    }
    visit(tree);
    unchanged();
}
try {
    for (const [index, fixture] of fixtures.entries()) {
        const probe = path.join(stage, `probe-${index}.ts`),
            output = probe + '.cjs';
        fs.writeFileSync(
            probe,
            `import assert from 'node:assert/strict';\nimport * as selected from 'node:fs/promises';\nimport * as memory from ${JSON.stringify(path.join(root, fixture))};\nfor (const name of ['mkdir','open','chmod','rename','rm']) assert.equal(selected[name],memory[name]);\n` +
                `import selectedPath from 'node:path';\nimport memoryPath from ${JSON.stringify(path.join(root, updaterMemoryPath))};\nassert.equal(selectedPath,memoryPath);\nassert.equal(selectedPath.join('/memory','updates'),'/memory/updates');\n` +
                (fixture.endsWith('/updater-memory-io.ts')
                    ? `import {createReadStream} from 'node:fs';\nassert.equal(createReadStream,memory.createReadStream);\n`
                    : ''),
            { flag: 'wx' },
        );
        await compile(probe, fixture, output, probe);
        assert.equal(
            await command([process.execPath, '--require', guard, output]),
            '# updater-memory-global-fetch-attempts 0\n',
        );
    }
    const results = [];
    for (const [index, value] of updaterMemoryTests.entries()) {
        const output = path.join(stage, `test-${index}.cjs`);
        await compile(value.entry, value.fixture, output);
        const text = await command([
            process.execPath,
            '--require',
            guard,
            '--test',
            '--test-reporter=tap',
            '--test-isolation=none',
            '--test-timeout=60000',
            output,
        ]);
        results.push({ entry: value.entry, ...assertUpdaterOutput(text, value.cases) });
        console.log(`${value.entry}: ${value.cases} passed (memory aliases; zero skips)`);
    }
    unchanged();
    fs.writeFileSync(
        path.join(stage, 'result.json'),
        JSON.stringify(
            { profile: 'updater-memory-compiler-spike', results, shippingQualification: false },
            null,
            2,
        ),
        { flag: 'wx' },
    );
    console.log(
        `Updater memory: ${results.reduce((total, value) => total + value.pass, 0)} passed; retained test output: ` +
            stage,
    );
} catch (error) {
    console.error('Updater memory failed; retained test output: ' + stage);
    throw error;
}

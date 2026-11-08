import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const files = [
    'memory-product-browser-host.ts',
    'memory-product-native-host.ts',
    'memory-product-browser-downloads.ts',
] as const;

/** In-memory compiler only: no module resolution, worker, service or emitted file. */
export function transpileCleanupSource(source: string, filename: string, directory: string) {
    const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true);
    assert.equal((parsed as any).parseDiagnostics.length, 0, 'Invalid cleanup fixture syntax.');
    const replacements = { dirname: 0, url: 0 };
    const result = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
            sourceMap: false,
        },
        reportDiagnostics: true,
        transformers: {
            before: [
                (context) => {
                    const visit: ts.Visitor = (node) => {
                        if (
                            ts.isPropertyAccessExpression(node) &&
                            ts.isMetaProperty(node.expression) &&
                            node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
                        ) {
                            assert.ok(node.name.text === 'dirname' || node.name.text === 'url');
                            const key = node.name.text;
                            replacements[key]++;
                            return ts.factory.createStringLiteral(
                                key === 'dirname' ? directory : filename,
                            );
                        }
                        return ts.visitEachChild(node, visit, context);
                    };
                    return (tree) => ts.visitNode(tree, visit) as ts.SourceFile;
                },
            ],
        },
    });
    assert.deepEqual(
        result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error),
        [],
        'Cleanup fixture compilation failed.',
    );
    new vm.Script(result.outputText, { filename });
    return { code: result.outputText, replacements };
}

/** No fallback resolver: absent, inherited and accessor-backed imports are unsupported. */
export function cleanupModelImports(imports: Readonly<Record<string, unknown>>) {
    return (name: string) => {
        const field = Object.getOwnPropertyDescriptor(imports, name);
        assert.ok(
            field && Object.hasOwn(field, 'value'),
            'Unsupported cleanup model import: ' + name,
        );
        return field.value;
    };
}

/** Only current, locally reviewed fixture sources. This VM is not an untrusted-code sandbox. */
export function loadCleanupFixture(file: string, imports: Readonly<Record<string, unknown>>) {
    assert.ok(files.includes(file as (typeof files)[number]), 'Unsupported cleanup fixture.');
    assert.equal(
        process.env.HUB_CLEANUP_TEST_SOURCE,
        undefined,
        'External cleanup fixture roots are unsupported.',
    );
    const location = new URL(file, import.meta.url);
    const directory = dirname(fileURLToPath(location));
    const source = readFileSync(location, 'utf8');
    const compiled = transpileCleanupSource(source, location.href, directory);
    assert.deepEqual(
        compiled.replacements,
        file === 'memory-product-browser-downloads.ts'
            ? { dirname: 0, url: 0 }
            : { dirname: 1, url: 1 },
        'Cleanup fixture import.meta boundaries changed.',
    );
    const module = { exports: {} as Record<string, any> };
    const processView = Object.freeze({
        execPath: process.execPath,
        env: Object.freeze({}),
        hrtime: Object.freeze({ bigint: () => process.hrtime.bigint() }),
    });
    const context = vm.createContext(
        {
            module,
            exports: module.exports,
            require: cleanupModelImports(imports),
            process: processView,
            Buffer,
            console,
            setTimeout,
            clearTimeout,
            performance,
            AggregateError,
            URL,
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    new vm.Script(compiled.code, { filename: file }).runInContext(context, { timeout: 1000 });
    return {
        api: module.exports,
        sourceSHA256: createHash('sha256').update(source).digest('hex'),
        replacements: compiled.replacements,
    };
}

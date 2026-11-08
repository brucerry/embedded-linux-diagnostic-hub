import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync('playwright.final-web.config.ts', 'utf8');
const emitted = ts.transpileModule(source, {
    fileName: 'playwright.final-web.config.ts',
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
}).outputText;
function configure(
    options: {
        selection?: string;
        output?: string;
        exists?: boolean;
        parent?: string;
        lookupError?: string;
        engine?: string;
    } = {},
) {
    const exported: any = {};
    const requireMemory = (name: string) => {
        if (name === '@playwright/test') return { defineConfig: (value: unknown) => value };
        if (name === 'node:fs')
            return {
                lstatSync: () => {
                    if (options.exists) return {};
                    throw Object.assign(Error('synthetic lookup'), {
                        code: options.lookupError ?? 'ENOENT',
                    });
                },
                realpathSync: (name: string) =>
                    name === '/project/validation' ? (options.parent ?? name) : name,
            };
        // This model's filesystem roots are POSIX strings on every test host.
        if (name === 'node:path') return path.posix;
        throw Error('Unadmitted config import: ' + name);
    };
    const context = {
        exports: exported,
        require: requireMemory,
        process: {
            cwd: () => '/project',
            env: {
                HUB_FINAL_WEB_SELECTION: options.selection,
                HUB_FINAL_WEB_OUTPUT: options.output,
                HUB_FINAL_WEB_ENGINE: options.engine,
            },
        },
    };
    vm.runInNewContext(emitted, context, { timeout: 1000 });
    return exported.default;
}
const valid = {
    selection: 'validation/web-startup-selection.json',
    output: 'validation/web-startup-owned-test',
};
test('actual config admits only an explicit one-case sandboxed Chromium lane with fresh output', () => {
    const value = configure(valid);
    assert.equal(value.testDir, './tests/final-artifact');
    assert.equal(value.testMatch, 'web-startup.spec.ts');
    assert.equal(value.globalSetup, './tests/final-artifact/web-startup-setup.ts');
    assert.equal(value.use.browserName, 'chromium');
    assert.equal(value.use.launchOptions.chromiumSandbox, true);
    assert.equal(value.retries, 0);
    assert.equal(value.workers, 1);
    assert.equal(value.timeout, 90_000);
    assert.equal(value.globalTimeout, 120_000);
    assert.equal(value.use.trace, 'off');
    assert.equal(value.use.screenshot, 'off');
    assert.equal(value.use.video, 'off');
    assert.equal(value.webServer, undefined);
    assert.equal(value.outputDir, '/project/validation/web-startup-owned-test');
});
for (const engine of ['firefox', 'webkit'])
    test(
        'actual config selects exactly one final-ZIP ' + engine + ' case without Chromium flags',
        () => {
            const value = configure({ ...valid, engine });
            assert.equal(value.use.browserName, engine);
            assert.deepEqual(Object.keys(value.use.launchOptions), []);
            assert.equal(value.projects, undefined);
            assert.equal(value.workers, 1);
            assert.equal(value.retries, 0);
            assert.equal(value.timeout, 90_000);
            assert.equal(value.globalTimeout, 120_000);
            assert.equal(value.testMatch, 'web-startup.spec.ts');
            assert.equal(value.use.trace, 'off');
            assert.equal(value.use.screenshot, 'off');
            assert.equal(value.use.video, 'off');
            assert.equal(value.webServer, undefined);
        },
    );
for (const options of [
    {},
    { ...valid, selection: '../web-startup-selection.json' },
    { ...valid, output: 'release' },
    { ...valid, exists: true },
    { ...valid, parent: '/foreign/validation' },
    { ...valid, lookupError: 'EACCES' },
    { ...valid, engine: '' },
    { ...valid, engine: 'chromium,firefox' },
    { ...valid, engine: 'CHROMIUM' },
    { ...valid, engine: 'webkit --no-sandbox' },
])
    test(
        'actual config refuses missing, foreign or existing admission ' + JSON.stringify(options),
        () => {
            assert.throws(() => configure(options));
        },
    );
test('installed SDK orders actual global input validation before browser test tasks; SDK is read as data only', () => {
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const root = path.dirname(require.resolve('playwright/package.json'));
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    assert.equal(version, lock.packages['node_modules/playwright'].version);
    const runner = readFileSync(path.join(root, 'lib/runner/index.js'), 'utf8');
    const begin = runner.indexOf('const tasks = options.listMode ? [');
    assert.ok(begin > 0);
    const tasks = runner.slice(begin, runner.indexOf('const testRun =', begin));
    assert.ok(
        tasks.indexOf('...createGlobalSetupTasks(config2)') <
            tasks.indexOf('...createRunTestsTasks(config2)'),
    );
    assert.ok(
        tasks.includes('...createGlobalSetupTasks(config2)') &&
            tasks.includes('...createRunTestsTasks(config2)'),
    );
    const setup = readFileSync('tests/final-artifact/web-startup-setup.ts', 'utf8');
    assert.ok(setup.includes('await readFinalWebStartupInput('));
    assert.ok(setup.includes('HUB_FINAL_WEB_VALIDATED_INPUT'));
    const spec = readFileSync('tests/final-artifact/web-startup.spec.ts', 'utf8');
    assert.ok(
        spec.indexOf('expect(fingerprint).toBe(') <
            spec.indexOf('await produceFinalWebStartupCase('),
    );
    const tree = ts.createSourceFile('web-startup.spec.ts', spec, ts.ScriptTarget.Latest, true);
    const verify: number[] = [],
        attachments: number[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            if (
                ts.isIdentifier(node.expression) &&
                node.expression.text === 'verifyFinalWebStartupCase'
            )
                verify.push(node.getStart(tree));
            if (
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === 'attach'
            ) {
                const receiver = node.expression.expression;
                if (
                    ts.isCallExpression(receiver) &&
                    ts.isPropertyAccessExpression(receiver.expression) &&
                    receiver.expression.name.text === 'info' &&
                    receiver.expression.expression.getText(tree) === 'test'
                )
                    attachments.push(node.getStart(tree));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(verify.length, 1);
    assert.equal(attachments.length, 1);
    assert.ok(verify[0] < attachments[0]);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Plugin, ResolvedConfig } from 'vite';
import {
    createPrivateViewerQualification,
    replaceUniqueViewerNeedle,
    transformPrivateViewerSource,
    viewerExecutableModule,
    VIEWER_TRANSFORM_PREIMAGES,
    type ViewerTransformTarget,
} from './fixtures/memory-product-viewer-transform';

const root = process.cwd();
const source = (target: ViewerTransformTarget) =>
    readFileSync(path.join(root, VIEWER_TRANSFORM_PREIMAGES[target].path), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const make = () =>
    createPrivateViewerQualification({
        sourceRoot: root,
        purpose: 'private-product-qualification',
    });
function call(plugin: Plugin, name: keyof Plugin, ...args: unknown[]): unknown {
    const hook = plugin[name];
    const handler = typeof hook === 'function' ? hook : (hook as { handler?: unknown })?.handler;
    assert.equal(typeof handler, 'function', 'actual Vite hook must be callable');
    return (handler as (...args: unknown[]) => unknown).apply({}, args);
}
function configure(plugin: Plugin, isWorker: boolean, overrides: Partial<ResolvedConfig> = {}) {
    return call(plugin, 'configResolved', {
        command: 'build',
        root,
        isWorker,
        ...overrides,
    } as ResolvedConfig);
}
function module(plugin: Plugin, target: ViewerTransformTarget, suffix = '') {
    return call(
        plugin,
        'transform',
        source(target),
        path.join(root, VIEWER_TRANSFORM_PREIMAGES[target].path) + suffix,
    ) as { code: string; map: null };
}
function completeWorker(qualification: ReturnType<typeof make>) {
    const [worker] = qualification.workerPlugins();
    configure(worker, true);
    for (const target of ['worker', 'raster', 'faults'] as const) module(worker, target);
    call(worker, 'generateBundle');
    return worker;
}
function fillRenderer(qualification: ReturnType<typeof make>) {
    configure(qualification.renderer, false);
    for (const target of ['viewer', 'raster', 'faults'] as const)
        module(qualification.renderer, target);
}

test('all four exact preimages match immutable files; altered and already-injected sources fail', () => {
    for (const target of Object.keys(VIEWER_TRANSFORM_PREIMAGES) as ViewerTransformTarget[]) {
        assert.equal(sha(source(target)), VIEWER_TRANSFORM_PREIMAGES[target].sha256);
        assert.throws(
            () => transformPrivateViewerSource(target, source(target) + '\n'),
            /preimage/,
        );
        const output = transformPrivateViewerSource(target, source(target));
        if (target !== 'faults')
            assert.throws(() => transformPrivateViewerSource(target, output), /preimage/);
        else assert.equal(output, source(target));
    }
});

test('unique literal guard rejects absent and duplicate source needles', () => {
    assert.throws(() => replaceUniqueViewerNeedle('ab', 'x', 'y'), /exactly one/);
    assert.throws(() => replaceUniqueViewerNeedle('xx', 'x', 'y'), /exactly one/);
    assert.throws(() => replaceUniqueViewerNeedle('ab', '', 'y'), /exactly one/);
    assert.equal(replaceUniqueViewerNeedle('abc', 'b', 'X'), 'aXc');
});

test('viewer transforms only actual request payload; static worker recognition and disposers survive', () => {
    const input = source('viewer'),
        output = transformPrivateViewerSource('viewer', input);
    const constructor =
        "new Worker(new URL('./export.worker.ts', import.meta.url), {\n                type: 'module',\n            })";
    assert.ok(input.includes(constructor));
    assert.ok(output.includes(constructor));
    assert.equal(output.split('task.postMessage(').length, input.split('task.postMessage(').length);
    assert.equal(output.split('.terminate(').length, input.split('.terminate(').length);
    assert.equal(output.split('clearTimeout(').length, input.split('clearTimeout(').length);
    assert.equal(output.split('.requestTicket(format)').length, 2);
    assert.ok(output.includes("installViewerFaultRealm('page')"));
    assert.ok(output.includes('job.current?.abort()'));
});

test('worker request gate precedes real fallback and preserves catch/error/progress messages', () => {
    const input = source('worker'),
        output = transformPrivateViewerSource('worker', input);
    assert.ok(output.startsWith('/// <reference lib="webworker" />\n'));
    assert.ok(
        output.indexOf('.enterRequest(') < output.indexOf("typeof OffscreenCanvas === 'undefined'"),
    );
    for (const text of [
        'worker.postMessage({ needsCanvas: true });',
        'progress: (progress) => worker.postMessage({ progress }),',
        'worker.postMessage({ error: error instanceof Error ? error.message : String(error) });',
    ])
        assert.ok(output.includes(text));
    assert.equal(
        output.split('worker.postMessage(').length,
        input.split('worker.postMessage(').length,
    );
    assert.ok(output.includes("installViewerFaultRealm('worker')"));
});

test('raster gate is at native encode boundary and preserves actual codec, abort and canvas cleanup', () => {
    const input = source('raster'),
        output = transformPrivateViewerSource('raster', input);
    assert.ok(output.indexOf('.beforeCodec(') < output.indexOf('await canvas.convertToBlob('));
    for (const text of [
        'await canvas.convertToBlob({ type, quality })',
        'canvas.toBlob(',
        'signal: options.signal',
        'canvas.width = 1;',
        'canvas.height = 1;',
    ])
        assert.ok(output.includes(text), text);
    assert.equal(output.split('setTimeout(').length, input.split('setTimeout(').length);
    assert.ok(output.includes('installViewerFaultRealm()'));
});

test('module classifier separates executable worker_file from generated wrappers and asset imports', () => {
    const file = path.join(root, VIEWER_TRANSFORM_PREIMAGES.worker.path);
    assert.equal(
        viewerExecutableModule(file),
        viewerExecutableModule(file + '?worker_file&type=module'),
    );
    assert.equal(
        viewerExecutableModule('/@fs/' + file.replaceAll('\\', '/')),
        viewerExecutableModule(file),
    );
    for (const query of ['worker', 'worker&inline', 'sharedworker', 'raw', 'url', 'inline'])
        assert.equal(viewerExecutableModule(file + '?' + query), null);
    assert.equal(viewerExecutableModule('\0virtual:worker'), null);
});

test('actual renderer + complete fresh worker graph yields scoped transform receipt, never runtime pass', () => {
    const qualification = make();
    fillRenderer(qualification);
    completeWorker(qualification);
    call(qualification.renderer, 'generateBundle');
    qualification.assertComplete();
    const receipt = qualification.snapshot();
    assert.equal(receipt.verifiedComplete, true);
    assert.equal(receipt.runtimeCoverage, 'unassessed');
    assert.equal(receipt.scope, 'private-source-transform-only');
    assert.equal(receipt.graphs.length, 2);
    assert.ok(receipt.graphs.every((graph) => graph.completed && graph.modules.length === 3));
    receipt.graphs[0].modules.length = 0;
    assert.equal(
        qualification.snapshot().graphs[0].modules.length,
        3,
        'receipt mutation cannot alter gate',
    );
});

test('renderer-only wiring, missing raster or fault graph fails closed', () => {
    const qualification = make();
    fillRenderer(qualification);
    assert.throws(() => call(qualification.renderer, 'generateBundle'), /requires worker.plugins/);
    for (const omitted of ['viewer', 'raster', 'faults'] as const) {
        const q = make();
        configure(q.renderer, false);
        for (const target of ['viewer', 'raster', 'faults'] as const)
            if (target !== omitted) module(q.renderer, target);
        completeWorker(q);
        assert.throws(() => call(q.renderer, 'generateBundle'), /lacks executable/);
    }
});

test('unrelated workers never supply export coverage; partial viewer worker cannot complete', () => {
    const q = make();
    fillRenderer(q);
    const [unrelated] = q.workerPlugins();
    configure(unrelated, true);
    assert.equal(call(unrelated, 'transform', 'export {}', path.join(root, 'unrelated.ts')), null);
    call(unrelated, 'generateBundle');
    assert.throws(() => call(q.renderer, 'generateBundle'), /requires worker.plugins/);
    const [partial] = q.workerPlugins();
    configure(partial, true);
    module(partial, 'worker', '?worker_file&type=module');
    assert.throws(() => call(partial, 'generateBundle'), /lacks executable raster/);
});

test('worker factory instances are fresh; independent sessions cannot borrow completion', () => {
    const q = make();
    const [one] = q.workerPlugins(),
        [two] = q.workerPlugins();
    assert.notEqual(one, two);
    assert.notEqual(one.name, two.name);
    fillRenderer(q);
    completeWorker(q);
    call(q.renderer, 'generateBundle');
    assert.equal(q.snapshot().verifiedComplete, true);
    const other = make();
    fillRenderer(other);
    assert.throws(() => call(other.renderer, 'generateBundle'), /requires worker.plugins/);
});

test('wrong build mode, source root, graph role, or absent configuration is blocked', () => {
    for (const [worker, overrides] of [
        [false, { command: 'serve' }],
        [true, {}],
        [false, { root: path.dirname(root) }],
    ] as const) {
        const q = make();
        assert.throws(() => configure(q.renderer, worker, overrides), /mismatch/);
    }
    const q = make();
    assert.throws(() => module(q.renderer, 'viewer'), /active configured/);
    configure(q.renderer, false);
    assert.throws(() => module(q.renderer, 'worker'), /different graph role/);
    const [worker] = q.workerPlugins();
    configure(worker, true);
    assert.throws(() => module(worker, 'viewer'), /different graph role/);
});

test('generated worker wrapper cannot accidentally be hashed or counted as worker implementation', () => {
    const q = make();
    configure(q.renderer, false);
    const id = path.join(root, VIEWER_TRANSFORM_PREIMAGES.worker.path);
    assert.equal(
        call(q.renderer, 'transform', 'export default "/assets/worker.js";', id + '?worker&url'),
        null,
    );
    assert.equal(q.snapshot().graphs[0].modules.length, 0);
    module(q.renderer, 'viewer');
    module(q.renderer, 'raster');
    module(q.renderer, 'faults');
    assert.throws(() => call(q.renderer, 'generateBundle'), /requires worker.plugins/);
});

test('worker build failures retain original cause and cannot become a complete receipt', () => {
    const q = make();
    fillRenderer(q);
    const worker = completeWorker(q);
    call(worker, 'buildEnd', new Error('Original native worker build failure.'));
    assert.equal(q.snapshot().graphs[1].failed, 'Original native worker build failure.');
    assert.throws(() => call(q.renderer, 'generateBundle'), /unconfigured or failed/);
    assert.equal(q.snapshot().verifiedComplete, false);
});

test('repeated exact source transforms are deterministic; completed graph rejects late source calls', () => {
    const q = make();
    fillRenderer(q);
    const one = module(q.renderer, 'viewer'),
        two = module(q.renderer, 'viewer');
    assert.deepEqual(one, two);
    assert.equal(q.snapshot().graphs[0].modules.find((m) => m.target === 'viewer')?.calls, 3);
    completeWorker(q);
    call(q.renderer, 'generateBundle');
    assert.throws(() => module(q.renderer, 'viewer'), /active configured/);
});

test('factory verifies all actual on-disk bytes and rechecks before final receipt', (context) => {
    const temp = mkdtempSync(path.join(tmpdir(), 'private-viewer-transform-'));
    context.after(() => {
        assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep));
        assert.ok(path.basename(temp).startsWith('private-viewer-transform-'));
        rmSync(temp, { recursive: true });
    });
    for (const [target, entry] of Object.entries(VIEWER_TRANSFORM_PREIMAGES)) {
        const destination = path.join(temp, entry.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, source(target as ViewerTransformTarget));
    }
    const q = createPrivateViewerQualification({
        sourceRoot: temp,
        purpose: 'private-product-qualification',
    });
    writeFileSync(path.join(temp, VIEWER_TRANSFORM_PREIMAGES.faults.path), source('faults') + '\n');
    assert.throws(() => q.assertComplete(), /on-disk preimage/);
    assert.throws(
        () =>
            createPrivateViewerQualification({
                sourceRoot: temp,
                purpose: 'private-product-qualification',
            }),
        /on-disk preimage/,
    );
});

test('explicit private purpose and absolute source root are required', () => {
    assert.throws(
        () =>
            createPrivateViewerQualification({
                sourceRoot: '.',
                purpose: 'private-product-qualification',
            }),
        /absolute/,
    );
    assert.throws(
        () => createPrivateViewerQualification({ sourceRoot: root, purpose: 'shipping' as never }),
        /Explicit private/,
    );
});

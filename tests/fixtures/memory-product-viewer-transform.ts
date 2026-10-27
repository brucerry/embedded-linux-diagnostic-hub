/** Private qualification build only. This module never writes product source. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export const VIEWER_TRANSFORM_PREIMAGES = {
    viewer: {
        path: 'src/features/automation/flow/FlowViewer.tsx',
        sha256: 'd3c6cfd35911e6a865a6c59e3b2d1896dd5cd3b836afefd320008872e350532d',
    },
    worker: {
        path: 'src/features/automation/flow/export.worker.ts',
        sha256: '4ed04a744b3beda250d5f5faf9511074b1ccc333d819f31907f7e358a53b0ff3',
    },
    raster: {
        path: 'src/features/automation/flow/raster.ts',
        sha256: '274cb6fcddcc1a616fff2209ff3e33222c4e842519c26982e8f79dfd8c7499bd',
    },
    faults: {
        path: 'tests/fixtures/memory-product-viewer-faults.ts',
        sha256: '46cd391f8419d6d5dbc74db2b3ff5bf5eb8e52a83a36703d9dfda27c1facfa95',
    },
} as const;
export type ViewerTransformTarget = keyof typeof VIEWER_TRANSFORM_PREIMAGES;
export type ViewerTransformRole = 'renderer' | 'worker';
const injectionName = '__memoryProductViewerFaultRealm';
const faultImport =
    "import { installViewerFaultRealm } from '/tests/fixtures/memory-product-viewer-faults.ts';\n";
const digest = (source: string | Buffer) => createHash('sha256').update(source).digest('hex');

/** Unique literal replacement, in addition to the full-file guard. */
export function replaceUniqueViewerNeedle(source: string, needle: string, replacement: string) {
    if (!needle || source.split(needle).length !== 2)
        throw Error('Private viewer transform requires exactly one source needle.');
    return source.replace(needle, replacement);
}

export function transformPrivateViewerSource(target: ViewerTransformTarget, source: string) {
    const expected = VIEWER_TRANSFORM_PREIMAGES[target];
    if (digest(source) !== expected.sha256)
        throw Error(`Private viewer full preimage mismatch: ${expected.path}`);
    if (target === 'faults') return source;
    if (source.includes(injectionName)) throw Error('Private viewer transform already installed.');
    const install = (realm: "'page'" | "'worker'" | '') =>
        `${faultImport}const ${injectionName} = installViewerFaultRealm(${realm});\n`;
    if (target === 'viewer') {
        return (
            install("'page'") +
            replaceUniqueViewerNeedle(
                source,
                '            task.postMessage({ scene: graph, format, downscale });',
                '            task.postMessage({ scene: graph, format, downscale,\n' +
                    `                __memoryProductViewerFault: ${injectionName}.requestTicket(format),\n` +
                    '            });',
            )
        );
    }
    if (target === 'worker') {
        const withImport = replaceUniqueViewerNeedle(
            source,
            '/// <reference lib="webworker" />\n',
            '/// <reference lib="webworker" />\n' + install("'worker'"),
        );
        return replaceUniqueViewerNeedle(
            withImport,
            '    const { scene, format, downscale } = event.data;',
            '    const { scene, format, downscale } = event.data;\n' +
                `    await ${injectionName}.enterRequest(\n` +
                '        (event.data as typeof event.data & { __memoryProductViewerFault?: unknown })\n' +
                '            .__memoryProductViewerFault, format,\n' +
                '    );',
        );
    }
    return (
        install('') +
        replaceUniqueViewerNeedle(
            source,
            '        await yieldControl();\n        const blob =',
            '        await yieldControl();\n' +
                `        await ${injectionName}.beforeCodec({ format, mime: type, signal: options.signal });\n` +
                '        const blob =',
        )
    );
}

function normalizeAbsolute(value: string) {
    const normalized = path.resolve(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Generated wrappers and source-as-data imports do not establish executable coverage. */
export function viewerExecutableModule(id: string) {
    if (id.startsWith('\0')) return null;
    const [file, query = ''] = id.split('?', 2);
    const params = new URLSearchParams(query);
    if (['worker', 'sharedworker', 'raw', 'url', 'inline'].some((key) => params.has(key)))
        return null;
    return normalizeAbsolute(file.startsWith('/@fs/') ? file.slice(5) : file);
}

interface ModuleReceipt {
    target: ViewerTransformTarget;
    path: string;
    inputSHA256: string;
    outputSHA256: string;
    calls: number;
}
interface GraphReceipt {
    id: number;
    role: ViewerTransformRole;
    configured: boolean;
    completed: boolean;
    failed: string | null;
    modules: ModuleReceipt[];
}
export interface PrivateViewerTransformReceipt {
    version: 1;
    scope: 'private-source-transform-only';
    sourceRoot: string;
    sourcePreimages: typeof VIEWER_TRANSFORM_PREIMAGES;
    graphs: GraphReceipt[];
    verifiedComplete: boolean;
    runtimeCoverage: 'unassessed';
}

/**
 * Wire renderer into plugins and workerPlugins into worker.plugins. The latter must
 * create fresh plugins for each Vite worker build. No existing config is mutated.
 */
export function createPrivateViewerQualification(options: {
    sourceRoot: string;
    purpose: 'private-product-qualification';
}) {
    if (options.purpose !== 'private-product-qualification')
        throw Error('Explicit private viewer qualification purpose is required.');
    if (!path.isAbsolute(options.sourceRoot)) throw Error('Private viewer root must be absolute.');
    const sourceRoot = realpathSync(options.sourceRoot);
    const rootIdentity = normalizeAbsolute(sourceRoot);
    const targets = Object.entries(VIEWER_TRANSFORM_PREIMAGES) as [
        ViewerTransformTarget,
        (typeof VIEWER_TRANSFORM_PREIMAGES)[ViewerTransformTarget],
    ][];
    const byAbsolute = new Map(
        targets.map(([target, source]) => [
            normalizeAbsolute(path.join(sourceRoot, source.path)),
            target,
        ]),
    );
    const verifyFiles = () => {
        for (const [, source] of targets) {
            const absolute = path.join(sourceRoot, source.path);
            const real = normalizeAbsolute(realpathSync(absolute));
            if (!real.startsWith(rootIdentity + '/'))
                throw Error('Private viewer target resolves outside the guarded source root.');
            if (digest(readFileSync(absolute)) !== source.sha256)
                throw Error(`Private viewer on-disk preimage mismatch: ${source.path}`);
        }
    };
    verifyFiles();
    const graphs: GraphReceipt[] = [];
    let verifiedComplete = false;
    const requireModules = (graph: GraphReceipt, required: ViewerTransformTarget[]) => {
        if (!graph.configured || graph.failed)
            throw Error(`Private viewer graph ${graph.id} is unconfigured or failed.`);
        for (const target of required)
            if (!graph.modules.some((module) => module.target === target))
                throw Error(`Private viewer ${graph.role} graph lacks executable ${target}.`);
    };
    const assertComplete = () => {
        verifiedComplete = false;
        verifyFiles();
        const renderer = graphs[0];
        requireModules(renderer, ['viewer', 'raster', 'faults']);
        if (!renderer.completed) throw Error('Private viewer renderer graph has not completed.');
        const viewerWorkers = graphs.filter(
            (graph) => graph.role === 'worker' && graph.modules.length,
        );
        if (!viewerWorkers.length)
            throw Error(
                'Private viewer requires worker.plugins and the actual export worker graph.',
            );
        for (const graph of viewerWorkers) {
            requireModules(graph, ['worker', 'raster', 'faults']);
            if (!graph.completed)
                throw Error('Private viewer export worker graph has not completed.');
        }
        if (graphs.some((graph) => graph.failed)) throw Error('Private viewer build graph failed.');
        verifiedComplete = true;
    };
    function plugin(role: ViewerTransformRole): Plugin {
        const graph: GraphReceipt = {
            id: graphs.length + 1,
            role,
            configured: false,
            completed: false,
            failed: null,
            modules: [],
        };
        graphs.push(graph);
        return {
            name: `private-product-viewer-${role}-${graph.id}`,
            enforce: 'pre',
            configResolved(config: ResolvedConfig) {
                if (
                    config.command !== 'build' ||
                    normalizeAbsolute(realpathSync(config.root)) !== rootIdentity ||
                    Boolean(config.isWorker) !== (role === 'worker')
                ) {
                    graph.failed = 'Private viewer build/root/worker role mismatch.';
                    throw Error(graph.failed);
                }
                verifyFiles();
                graph.configured = true;
            },
            transform(source, id) {
                const executable = viewerExecutableModule(id);
                const target = executable && byAbsolute.get(executable);
                if (!target) return null;
                if (!graph.configured || graph.failed || graph.completed)
                    throw Error('Private viewer transform outside an active configured graph.');
                if (
                    (role === 'worker' && target === 'viewer') ||
                    (role === 'renderer' && target === 'worker')
                )
                    throw Error(
                        'Private viewer executable target belongs to a different graph role.',
                    );
                let code: string;
                try {
                    code = transformPrivateViewerSource(target, source);
                } catch (error) {
                    graph.failed = error instanceof Error ? error.message : String(error);
                    verifiedComplete = false;
                    throw error;
                }
                verifiedComplete = false;
                const existing = graph.modules.find((module) => module.target === target);
                if (existing) {
                    if (
                        existing.inputSHA256 !== digest(source) ||
                        existing.outputSHA256 !== digest(code)
                    )
                        throw Error('Private viewer repeated transform identity changed.');
                    existing.calls++;
                } else {
                    graph.modules.push({
                        target,
                        path: VIEWER_TRANSFORM_PREIMAGES[target].path,
                        inputSHA256: digest(source),
                        outputSHA256: digest(code),
                        calls: 1,
                    });
                }
                return { code, map: null };
            },
            buildEnd(error) {
                if (error) {
                    graph.failed = error.message;
                    verifiedComplete = false;
                }
            },
            generateBundle() {
                if (role === 'renderer') {
                    requireModules(graph, ['viewer', 'raster', 'faults']);
                    graph.completed = true;
                    assertComplete();
                } else {
                    if (graph.modules.length) requireModules(graph, ['worker', 'raster', 'faults']);
                    if (graph.failed) throw Error('Private viewer worker build failed.');
                    graph.completed = true;
                }
            },
        };
    }
    const renderer = plugin('renderer');
    return {
        renderer,
        workerPlugins: () => [plugin('worker')],
        assertComplete,
        snapshot(): PrivateViewerTransformReceipt {
            return {
                version: 1,
                scope: 'private-source-transform-only',
                sourceRoot,
                sourcePreimages: structuredClone(VIEWER_TRANSFORM_PREIMAGES),
                graphs: structuredClone(graphs),
                verifiedComplete,
                runtimeCoverage: 'unassessed',
            };
        },
    };
}

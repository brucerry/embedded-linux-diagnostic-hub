import type { Scene } from '../../src/features/automation/flow/types';

// Authored, deterministic source data. It deliberately spans two graph tiles
// and multiple detail pages, with command content absent from card previews.
const nodes = [
    {
        id: 'inspect', ordinal: 1, name: 'Inspect ' + 'W'.repeat(100),
        command: 'W'.repeat(90) + '\n' + 'Ｗ'.repeat(90) +
            '\n日本語 👨‍👩‍👧‍👦 e\u0301 العربية\n' + "printf '\ufffe\uffff'",
        enabled: true, intent: 'SSH command', delay: 'Delay 0 s before send',
        status: 'Pending · no current completion evidence', x: 100, y: 220,
    },
    {
        id: 'details', ordinal: 2, name: 'Preserve all continued details',
        command: Array.from({ length: 36 }, (_, i) =>
            `printf 'detail row ${String(i + 1).padStart(2, '0')} sentinel COMPLETE'`).join('\n'),
        enabled: false, intent: 'SSH command', delay: 'Delay 2 s before send',
        status: 'Disabled · skipped', x: 980, y: 220,
    },
];
const snapshot = {
    kind: 'Draft' as const, identity: 'pdf-content-fixture', capturedAt: '2026-11-04T10:00:00.000Z',
    summary: 'Next-run draft · inspection only', timing: 'Immediate start · Run once · timeout 5 s',
    completion: 'SSH independent script exit evidence; a nonzero exit is shown explicitly.', nodes,
};
export const flowPdfVisualCase: Scene = {
    snapshot, width: 1380, graphHeight: 488, height: 1600, nodes,
    edges: [{ from: 'inspect', to: 'details', points: [
        { x: 400, y: 304 }, { x: 690, y: 304 }, { x: 690, y: 304 }, { x: 980, y: 304 },
    ] }],
    details: [snapshot.summary, snapshot.timing, snapshot.completion,
        ...nodes.flatMap(n => ['', `${n.ordinal}. ${n.name} · ${n.enabled ? 'Enabled' : 'Disabled'} · ${n.intent}`,
            `${n.delay} · ${n.status}`, n.command])],
};

// This runs in the actual browser, using the unmodified source export entry.
export async function exportFlowPdfVisualCase(scene: Scene) {
    const path = new URL('/src/features/automation/flow/raster.ts', location.href).href;
    const { exportRaster } = await import(/* @vite-ignore */ path) as
        typeof import('../../src/features/automation/flow/raster');
    const before = JSON.stringify(scene);
    const pdf = await exportRaster(scene, 'pdf', false);
    const svg = await exportRaster(scene, 'svg', false);
    if (pdf.blob.size > 8 * 1024 * 1024 || svg.blob.size > 256 * 1024)
        throw Error('Visual PDF fixture exceeds its read budget');
    if (JSON.stringify(scene) !== before) throw Error('PDF/SVG exports mutated their source');
    const bytes = new Uint8Array(await pdf.blob.arrayBuffer());
    return { pdf: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')),
        svg: await svg.blob.text() };
}

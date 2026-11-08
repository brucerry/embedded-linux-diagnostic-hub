import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    bounds,
    coordinate,
    displayText,
    edge,
    initialPositions,
    pngSize,
    scene,
    snapshot,
    wrap,
} from '../src/features/automation/flow/model';
import { svg } from '../src/features/automation/flow/render';
import { imagePdf, pdfTiles, PAPER } from '../src/features/automation/flow/pdf';
import { exportRaster } from '../src/features/automation/flow/raster';
import type { FlowInput } from '../src/features/automation/flow/types';
import {
    layoutScene,
    measuredLines,
    type MeasureText,
} from '../src/features/automation/flow/text-layout';
const measure: MeasureText = (text, size) => ({
    width: Array.from(text).length * size,
    left: 0,
    right: Array.from(text).length * size,
    ascent: size * 0.8,
    descent: size * 0.2,
});

const input = (): FlowInput => ({
    draft: {
        transport: 'ssh',
        steps: Array.from({ length: 20 }, (_, i) => ({
            id: `stable-${i}`,
            name: `Command ${i + 1}`,
            enabled: i !== 8,
            command: `printf '${i}'`,
            delaySeconds: i,
        })),
        timeoutSeconds: 60,
        repeatSeconds: 5,
        start: null,
        serial: { lineEnding: 'LF', prompt: '# ', timestampPrefix: '' },
    },
    active: null,
    busy: false,
    state: { state: 'idle', message: 'Ready' },
    evidence: [],
});
test('frozen active snapshot and bounded evidence cannot be replaced by edits or moved coordinates', () => {
    const value = input();
    value.active = { id: 'armed-identity', plan: structuredClone(value.draft) };
    value.busy = true;
    value.draft.steps.reverse();
    value.draft.steps[0].command = 'next draft';
    value.state = { state: 'running', message: 'Running', step: 'stable-2' };
    value.evidence = [
        { ordinal: 1, runId: 'recorded-run', completion: 'exit', exitCode: 7, uncertain: false },
    ];
    const data = snapshot(value, true, '2026-10-15T12:00:00Z');
    const before = JSON.stringify(value);
    assert.equal(data.identity, 'armed-identity');
    assert.equal(data.nodes[0].command, "printf '0'");
    assert.match(data.nodes[0].status, /Exit 7/);
    assert.equal(data.nodes[2].status, '▶ Running');
    assert.equal(data.nodes[8].status, 'Disabled · skipped');
    assert.match(data.nodes[19].status, /no current completion evidence/);
    const positions = initialPositions(data.nodes);
    positions['stable-0'] = { x: 2000, y: -2000 };
    const graph = scene(data, positions);
    assert.equal(graph.edges.length, 19);
    assert.deepEqual(
        graph.edges.map((e) => [e.from, e.to]),
        Array.from({ length: 19 }, (_, i) => [`stable-${i}`, `stable-${i + 1}`]),
    );
    assert.equal(JSON.stringify(value), before);
    assert.equal(data.nodes[19].ordinal, 20);
});
test('unknown and cancellation states never invent successful exits; repeated records identify their run', () => {
    const value = input();
    value.active = { id: 'frozen', plan: structuredClone(value.draft) };
    value.state = { state: 'paused', message: 'Disconnected' };
    value.evidence = [
        {
            ordinal: 1,
            runId: 'previous-cycle',
            completion: 'uncertain-close',
            exitCode: null,
            uncertain: true,
        },
    ];
    const data = snapshot(value, true);
    assert.match(data.nodes[0].status, /Recorded: Uncertain.*run previous.*paused\/cancelled/);
    assert.match(data.nodes[1].status, /no current completion evidence.*paused\/cancelled/);
    assert(!data.nodes.some((n) => /success|completed/.test(n.status)));
    assert.equal(snapshot(value, false).kind, 'Draft');
});
test('full scene bounds contain displaced nodes, ports and all ordered edges independently of any viewport', () => {
    const data = snapshot(input(), false),
        positions = initialPositions(data.nodes);
    positions['stable-0'] = { x: -2000, y: -2000 };
    positions['stable-19'] = { x: 2000, y: 2000 };
    const box = bounds(data.nodes, positions),
        graph = scene(data, positions);
    assert.equal(box.width, 4300);
    assert.equal(graph.nodes.length, 20);
    assert.equal(graph.width, 4500);
    for (const n of graph.nodes) {
        assert(n.x >= 100 && n.y >= 220);
        assert(n.x + 300 <= graph.width);
        assert(n.y + 168 <= graph.graphHeight);
    }
    for (const e of graph.edges)
        for (const p of e.points) {
            assert(Number.isFinite(p.x) && Number.isFinite(p.y));
            assert(p.x >= 0 && p.x <= graph.width);
            assert(p.y >= 0 && p.y <= graph.graphHeight);
        }
    assert.equal(coordinate(Infinity), 0);
    assert.equal(coordinate(-9000), -2000);
    assert.notDeepEqual(
        edge({ x: 0, y: 0 }, { x: 380, y: 0 }),
        edge({ x: 0, y: 0 }, { x: 0, y: 240 }),
    );
});
test('inert SVG preserves full escaped Unicode commands and metadata, with no active markup or external resources', async () => {
    const value = input();
    value.draft.steps[19].command =
        '<script onload="evil()">&</script> 日本語 😀\nsecond line\u202e';
    const data = snapshot(value, false),
        graph = scene(data, initialPositions(data.nodes)),
        output = svg(await layoutScene(graph, measure));
    assert(
        output.includes('&lt;script onload=&quot;evil()&quot;&gt;&amp;&lt;/script&gt; 日本語 😀'),
    );
    assert(output.includes('second line\\u202e'));
    assert(output.includes(data.capturedAt));
    assert(output.includes('20. Command 20'));
    assert(output.includes('Repeat 5 s'));
    assert(!/<script|<foreignObject|<image|<a\s|href=|onload=evil/.test(output));
    assert.equal((output.match(/marker-end=/g) ?? []).length, 19);
    assert.equal(displayText('a\u0000b\u2066'), 'a\\u0000b\\u2066');
    assert.deepEqual(wrap('日本語😀', 4), ['日本', '語😀']);
});
test('XML-invalid characters are visible presentation escapes and raw command UTF-16 remains exact', async () => {
    const value = input(),
        raw = 'valid 😀 日本語\n\ufffe\uffff\ud800 lone \udfff';
    value.draft.steps[0].command = raw;
    const data = snapshot(value, false),
        rawScene = scene(data, initialPositions(data.nodes));
    assert.equal(rawScene.snapshot.nodes[0].command, raw);
    assert.equal(value.draft.steps[0].command, raw);
    const prepared = await layoutScene(rawScene, measure),
        output = svg(prepared);
    for (const literal of ['\\ufffe', '\\uffff', '\\ud800', '\\udfff'])
        assert(output.includes(literal));
    assert(!/[\ufffe\uffff]/u.test(output));
    assert(output.includes('valid 😀 日本語'));
    assert.equal(prepared.snapshot.nodes[0].command, raw);
    assert.throws(() => svg(rawScene), /font metrics/);
});
test('measured layout wraps widest glyphs, keeps every character, and fits card previews in their own bounds', async () => {
    const value = input();
    value.draft.steps[0].command = 'W'.repeat(90);
    value.draft.steps[0].name = 'W'.repeat(120);
    const data = snapshot(value, false),
        prepared = await layoutScene(scene(data, initialPositions(data.nodes)), measure);
    assert.equal(
        prepared
            .text!.details.filter((r) => /^W+$/.test(r.text))
            .map((r) => r.text)
            .join(''),
        'W'.repeat(90),
    );
    for (const r of [...prepared.text!.header, ...prepared.text!.cards, ...prepared.text!.details])
        assert(r.bounds.x + r.bounds.width <= prepared.width);
    for (const r of prepared.text!.cards) {
        const n = prepared.nodes.find((n) => n.ordinal === r.ordinal)!;
        assert(r.bounds.x >= n.x && r.bounds.x + r.bounds.width <= n.x + 300);
        assert(r.bounds.y >= n.y && r.bounds.y + r.bounds.height <= n.y + 168);
    }
    const raw = 'W'.repeat(90) + '\n日本語😀\nالعربية e\u0301\n';
    assert.equal(
        (await measuredLines(raw, 100, 14, measure)).join(''),
        displayText(raw).replaceAll('\n', ''),
    );
});
test('size budgets reject oversized drafts and explicitly require PNG downscaling without cropping', () => {
    const size = pngSize({ width: 4500, height: 20000 }, true);
    assert(size.width * size.height <= 16000000);
    assert(size.height <= 16384);
    assert(size.scale < 1);
    assert.throws(() => pngSize({ width: 4500, height: 20000 }), /Allow PNG downscale/);
    const value = input();
    value.draft.steps[0].command = 'x'.repeat(8193);
    assert.throws(() => snapshot(value, false), /oversized/);
    value.draft.steps = [];
    assert.throws(() => snapshot(value, false), /1–20/);
});
test('PDF tile coverage is complete and serializer xref/stream byte offsets are exact', () => {
    const tiles = pdfTiles(4500, 4488);
    assert.equal(tiles.length, 66);
    assert.equal(tiles.at(-1)?.column, 5);
    assert.equal(tiles.at(-1)?.row, 10);
    assert.throws(() => pdfTiles(100000, 100000), /128 pages/);
    const pdf = imagePdf([{ bytes: new Uint8Array([255, 216, 255, 217]), width: 2, height: 2 }]);
    const text = Buffer.from(pdf).toString('latin1');
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    assert.equal(text.slice(start, start + 4), 'xref');
    const entries = text.slice(start).split('\n').slice(3, 8);
    entries.forEach((line, i) => {
        const offset = Number(line.slice(0, 10));
        assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
    });
    assert(text.includes('/MediaBox [0 0 842 595]'));
    assert(!/JavaScript|OpenAction|URI/.test(text));
    assert.throws(() => imagePdf([]), /1–128/);
});
test('overlapping PDF tiles contain every displaced card whole, and cancelled export allocates no canvas', async () => {
    const data = snapshot(input(), false),
        positions = initialPositions(data.nodes);
    positions['stable-0'] = { x: -2000, y: -2000 };
    positions['stable-19'] = { x: 2000, y: 2000 };
    const graph = scene(data, positions),
        tiles = pdfTiles(graph.width, graph.graphHeight);
    for (const node of graph.nodes)
        assert(
            tiles.some((t) => {
                const x = t.column * PAPER.strideX,
                    y = t.row * PAPER.strideY;
                return (
                    node.x >= x &&
                    node.y >= y &&
                    node.x + 300 <= x + PAPER.tileWidth &&
                    node.y + 168 <= y + PAPER.tileHeight
                );
            }),
            `No complete PDF tile for command ${node.ordinal}`,
        );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exportRaster(graph, 'png', true, { signal: controller.signal }), {
        name: 'AbortError',
    });
});

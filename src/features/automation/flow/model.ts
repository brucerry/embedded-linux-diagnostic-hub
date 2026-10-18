import type { FlowInput, FlowSnapshot, Point, Positions, Scene, SceneEdge } from './types';

export const CARD = { width: 300, height: 168 } as const;
export const MAX_COORDINATE = 2000;
export const MAX_PIXELS = 8_000_000;
export const MAX_PAGES = 128;
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const coordinate = (n: number) =>
    Number.isFinite(n) ? clamp(n, -MAX_COORDINATE, MAX_COORDINATE) : 0;

// Bidi and non-printing controls are made visible; neither the command nor the plan is changed.
export function displayText(text: string): string {
    return text
        .replace(
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffe\uffff]/gu,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
        )
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, '    ');
}
export function wrap(text: string, columns: number): string[] {
    return displayText(text)
        .split('\n')
        .flatMap((line) => {
            if (/^[\x20-\x7e]*$/.test(line)) {
                if (!line) return [''];
                const lines: string[] = [];
                for (let i = 0; i < line.length; i += columns)
                    lines.push(line.slice(i, i + columns));
                return lines;
            }
            const lines: string[] = [];
            let part = '',
                width = 0;
            for (const { segment } of new Intl.Segmenter(undefined, {
                granularity: 'grapheme',
            }).segment(line)) {
                const units = (segment.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
                if (width + units > columns && part) {
                    lines.push(part);
                    part = '';
                    width = 0;
                }
                part += segment;
                width += units;
            }
            lines.push(part);
            return lines;
        });
}
export function preview(text: string, limit = 38): string {
    let result = '',
        width = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        displayText(text).replace(/\s+/g, ' '),
    )) {
        const units = (segment.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
        if (width + units > limit) return result + '…';
        result += segment;
        width += units;
    }
    return result;
}
const seconds = (value: number) =>
    Number.isFinite(value) && value >= 0 ? `${value} s` : 'Unresolved';
export function snapshot(
    input: FlowInput,
    active: boolean,
    now = new Date().toISOString(),
): FlowSnapshot {
    const frozen = active ? input.active : null;
    const plan = frozen?.plan ?? input.draft;
    if (new TextEncoder().encode(JSON.stringify(plan)).length > 65536)
        throw Error('Resolve the oversized draft before viewing this flow (64 KiB plan limit).');
    if (plan.steps.length < 1 || plan.steps.length > 20)
        throw Error('Flow view supports 1–20 commands.');
    const ids = new Set<string>();
    let bytes = 0;
    for (const node of plan.steps) {
        const size = new TextEncoder().encode(node.command).length;
        bytes += size;
        if (
            ids.has(node.id) ||
            !node.id ||
            node.id.length > 128 ||
            node.name.length > 120 ||
            size > 8192 ||
            bytes > 65536
        )
            throw Error(
                'Resolve oversized commands, names or duplicate IDs before viewing this flow.',
            );
        ids.add(node.id);
    }
    const schedule = plan.start
        ? `${new Date(plan.start.epochMs).toISOString()} · ${plan.start.clock} clock · ${plan.start.zone}`
        : !frozen && input.draftTiming
          ? input.draftTiming
          : 'Immediate start';
    const repeat =
        plan.repeatSeconds === null
            ? 'Run once'
            : `Repeat ${seconds(plan.repeatSeconds)} after each completed flow`;
    return {
        kind: frozen ? 'Active snapshot' : 'Draft',
        identity: frozen?.id ?? 'next-run draft',
        capturedAt: now,
        summary: frozen
            ? `${input.state.state} · ${input.state.message}`
            : 'Next-run draft · inspection only',
        timing: `${schedule} · ${repeat} · timeout ${seconds(plan.timeoutSeconds)}`,
        completion:
            plan.transport === 'ssh'
                ? plan.ssh?.mode === 'console'
                    ? 'SSH console uses combined PTY output and prompt-observed completion; process exit status is unavailable. Ready: ' +
                      displayText(JSON.stringify(plan.ssh.ready ?? null))
                    : 'SSH independent script exit evidence; a nonzero exit is shown explicitly.'
                : `Serial ${plan.serial.lineEnding} · prompt ${displayText(plan.serial.prompt) || '(unset)'} · prompt observation does not prove command success.`,
        nodes: plan.steps.map((step, index) => {
            const record = frozen ? input.evidence.find((r) => r.ordinal === index + 1) : undefined;
            let status = !step.enabled
                ? 'Disabled · skipped'
                : 'Pending · no current completion evidence';
            if (record && step.enabled) {
                const result = record.uncertain
                    ? 'Uncertain'
                    : record.completion === 'exit'
                      ? `Exit ${record.exitCode ?? 'unknown'}`
                      : record.completion;
                status = `Recorded: ${result} · run ${record.runId.slice(0, 8)}`;
            }
            if (
                frozen &&
                step.enabled &&
                input.state.step === step.id &&
                input.state.state === 'running'
            )
                status = '▶ Running';
            if (frozen && input.state.state === 'paused' && step.enabled)
                status += ' · flow paused/cancelled';
            return {
                id: step.id,
                ordinal: index + 1,
                name: displayText(step.name.trim() || `Step ${index + 1}`),
                command: step.command,
                enabled: step.enabled,
                intent:
                    plan.transport === 'ssh' && plan.ssh?.mode === 'console'
                        ? step.ssh?.intent === 'send-enter'
                            ? 'Send Enter (exact CR)'
                            : 'Script + CR in owned console'
                        : step.enterOnly
                          ? 'Enter only'
                          : `${plan.transport.toUpperCase()} command`,
                ...(plan.transport === 'ssh' && plan.ssh?.mode === 'console'
                    ? {
                          criterion:
                              'Completion criterion: ' +
                              displayText(
                                  JSON.stringify(
                                      step.ssh?.completion ?? plan.ssh.completion ?? null,
                                  ),
                              ),
                      }
                    : {}),
                delay: `Delay ${seconds(step.delaySeconds)} before send`,
                status,
            };
        }),
    };
}
export function initialPositions(nodes: FlowSnapshot['nodes']): Positions {
    return Object.fromEntries(
        nodes.map((node, i) => {
            const row = Math.floor(i / 3),
                column = row % 2 ? 2 - (i % 3) : i % 3;
            return [node.id, { x: column * 380, y: row * 240 }];
        }),
    );
}
export function bounds(nodes: FlowSnapshot['nodes'], positions: Positions) {
    const points = nodes.map((n) => positions[n.id] ?? { x: 0, y: 0 });
    const x = Math.min(...points.map((p) => coordinate(p.x))),
        y = Math.min(...points.map((p) => coordinate(p.y)));
    return {
        x,
        y,
        width: Math.max(...points.map((p) => coordinate(p.x))) - x + CARD.width,
        height: Math.max(...points.map((p) => coordinate(p.y))) - y + CARD.height,
    };
}
export function edge(from: Point, to: Point): SceneEdge['points'] {
    const dx = to.x - from.x,
        dy = to.y - from.y;
    const horizontal = Math.abs(dx) / CARD.width >= Math.abs(dy) / CARD.height;
    const sign = (horizontal ? dx : dy) >= 0 ? 1 : -1;
    const a = {
        x: from.x + CARD.width / 2 + (horizontal ? (sign * CARD.width) / 2 : 0),
        y: from.y + CARD.height / 2 + (horizontal ? 0 : (sign * CARD.height) / 2),
    };
    const b = {
        x: to.x + CARD.width / 2 - (horizontal ? (sign * CARD.width) / 2 : 0),
        y: to.y + CARD.height / 2 - (horizontal ? 0 : (sign * CARD.height) / 2),
    };
    const offset = Math.max(36, Math.abs(horizontal ? b.x - a.x : b.y - a.y) / 2);
    return [
        a,
        { x: a.x + (horizontal ? sign * offset : 0), y: a.y + (horizontal ? 0 : sign * offset) },
        { x: b.x - (horizontal ? sign * offset : 0), y: b.y - (horizontal ? 0 : sign * offset) },
        b,
    ];
}
export const edgePath = (p: SceneEdge['points']) =>
    `M${p[0].x},${p[0].y} C${p[1].x},${p[1].y} ${p[2].x},${p[2].y} ${p[3].x},${p[3].y}`;
export function scene(data: FlowSnapshot, positions: Positions): Scene {
    const box = bounds(data.nodes, positions);
    // Padding includes Bezier control points, arrowheads and the full authored layout.
    const nodes = data.nodes.map((n) => ({
        ...n,
        x: coordinate(positions[n.id]?.x ?? 0) - box.x + 100,
        y: coordinate(positions[n.id]?.y ?? 0) - box.y + 220,
    }));
    const width = Math.max(1000, box.width + 200),
        graphHeight = box.height + 320;
    const edges = nodes
        .slice(1)
        .map((n, i) => ({ from: nodes[i].id, to: n.id, points: edge(nodes[i], n) }));
    const details = [data.summary, data.timing, data.completion]
        .flatMap((line) => displayText(line).split('\n'))
        .concat(
            data.nodes.flatMap((n) => [
                '',
                ...displayText(
                    `${n.ordinal}. ${n.name} · ${n.enabled ? 'Enabled' : 'Disabled'} · ${n.intent}`,
                ).split('\n'),
                ...displayText(`${n.delay} · ${n.status}`).split('\n'),
                ...(n.criterion ? displayText(n.criterion).split('\n') : []),
                ...displayText(
                    n.command ||
                        (n.intent === 'Enter only'
                            ? '(Enter only; empty payload)'
                            : '(empty command)'),
                ).split('\n'),
            ]),
        );
    return {
        snapshot: structuredClone(data),
        nodes,
        edges,
        width,
        graphHeight,
        details,
        height: graphHeight + 88 + details.length * 20,
    };
}
export function pngSize(
    s: Pick<Scene, 'width' | 'height'>,
    downscale = false,
    pixelBudget: number = MAX_PIXELS,
) {
    const scale = Math.min(
        1,
        16384 / s.width,
        16384 / s.height,
        Math.sqrt(pixelBudget / (s.width * s.height)),
    );
    if (scale < 1 && !downscale)
        throw Error(
            `Full PNG exceeds ${pixelBudget / 1_000_000} megapixels or 16384 px per side. Choose “Allow PNG downscale”, SVG or PDF.`,
        );
    return {
        width: Math.max(1, Math.floor(s.width * scale)),
        height: Math.max(1, Math.floor(s.height * scale)),
        scale,
    };
}

import { CARD, displayText } from './model';
import type { Scene, TextRun } from './types';

export const EXPORT_FONT = 'system-ui, sans-serif';
export interface FontMetrics {
    width: number;
    left: number;
    right: number;
    ascent: number;
    descent: number;
}
export type MeasureText = (text: string, size: number) => FontMetrics;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export const fontMeasure =
    (ctx: Context): MeasureText =>
    (text, size) => {
        ctx.font = `${size}px ${EXPORT_FONT}`;
        const m = ctx.measureText(text);
        const result = {
            width: m.width,
            left: Math.max(0, m.actualBoundingBoxLeft),
            right: Math.max(m.width, m.actualBoundingBoxRight),
            ascent: Math.max(0, m.actualBoundingBoxAscent),
            descent: Math.max(0, m.actualBoundingBoxDescent),
        };
        if (Object.values(result).some((n) => !Number.isFinite(n)))
            throw Error('This engine cannot provide safe export font bounds.');
        return result;
    };
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const segments = (value: string) =>
    /^[\x20-\x7e]*$/.test(value)
        ? value.split('')
        : Array.from(segmenter.segment(value), (p) => p.segment);
const inkWidth = (m: FontMetrics) => m.left + m.right;
const fits = (m: FontMetrics, width: number) => inkWidth(m) <= width;

/** Full lines are measured in the exact renderer font, never estimated by character count. */
export async function measuredLines(
    value: string,
    width: number,
    size: number,
    measure: MeasureText,
    yieldControl: () => Promise<void> = async () => {},
): Promise<string[]> {
    const output: string[] = [];
    let work = 0;
    const check = async (text: string) => {
        work += Math.max(1, text.length);
        if (work >= 4096) {
            work = 0;
            await yieldControl();
        }
        return fits(measure(text, size), width - 4);
    };
    for (const raw of displayText(value).split('\n')) {
        const chars = segments(raw);
        if (!chars.length) {
            output.push('');
            continue;
        }
        for (let start = 0; start < chars.length;) {
            let low = 0,
                high = 1;
            while (await check(chars.slice(start, start + high).join(''))) {
                low = Math.min(high, chars.length - start);
                if (low === chars.length - start) break;
                high = Math.min(chars.length - start, high * 2);
            }
            if (!low)
                throw Error(
                    'A glyph cluster exceeds the readable export width. No cropped file was exported.',
                );
            let upper = high;
            while (low + 1 < upper) {
                const middle = Math.floor((low + upper) / 2);
                if (await check(chars.slice(start, start + middle).join(''))) low = middle;
                else upper = middle;
            }
            output.push(chars.slice(start, start + low).join(''));
            start += low;
        }
    }
    return output;
}

export function previewLine(
    value: string,
    width: number,
    height: number,
    size: number,
    measure: MeasureText,
) {
    const raw = displayText(value).replace(/\s+/g, ' '),
        chars = segments(raw);
    const fit = (text: string) => {
        const m = measure(text, size);
        return fits(m, width - 4) && m.ascent + m.descent <= height - 4;
    };
    if (fit(raw)) return raw;
    let result = '';
    for (const char of chars) {
        if (!fit(result + char + '…')) break;
        result += char;
    }
    if (!fit(result + '…')) throw Error('This engine cannot fit a readable card preview.');
    return result + '…';
}
export function textRun(
    text: string,
    x: number,
    top: number,
    size: number,
    tone: TextRun['tone'],
    role: string,
    measure: MeasureText,
    ordinal?: number,
): TextRun {
    text = displayText(text);
    const m = measure(text, size),
        left = x + 2,
        y = top + Math.max(size, m.ascent) + 2;
    return {
        text,
        x: left + m.left,
        y,
        size,
        tone,
        role,
        ordinal,
        bounds: { x: left, y: y - m.ascent, width: inkWidth(m), height: m.ascent + m.descent },
    };
}

/** Geometry and raw commands stay immutable; only the inert export copy receives measured text. */
export async function layoutScene(
    source: Scene,
    measure: MeasureText,
    yieldControl: () => Promise<void> = async () => {},
): Promise<Scene> {
    const s = structuredClone(source),
        header: TextRun[] = [],
        cards: TextRun[] = [],
        details: TextRun[] = [];
    const width = s.width - 80;
    let top = 12;
    const add = async (
        value: string,
        size: number,
        tone: TextRun['tone'],
        role: string,
        target: TextRun[],
    ) => {
        for (const line of await measuredLines(value, width, size, measure, yieldControl)) {
            const run = textRun(line, 40, top, size, tone, role, measure);
            target.push(run);
            top = Math.max(top + size + 6, run.bounds.y + run.bounds.height + 6);
        }
    };
    await add(`Automation flow · ${s.snapshot.kind}`, 22, 'ink', 'heading', header);
    for (const value of [s.snapshot.identity, s.snapshot.capturedAt, s.snapshot.timing])
        await add(value, 14, 'muted', 'metadata', header);
    const shift = Math.max(0, top + 36 - Math.min(...s.nodes.map((n) => n.y)));
    s.nodes = s.nodes.map((n) => ({ ...n, y: n.y + shift }));
    s.edges = s.edges.map((e) => ({
        ...e,
        points: e.points.map((p) => ({ ...p, y: p.y + shift })) as typeof e.points,
    }));
    s.graphHeight += shift;
    for (const n of s.nodes) {
        await yieldControl();
        for (const [value, offset, height, size, tone, role] of [
            [`${n.ordinal}. ${n.name}`, 8, 31, 16, 'ink', 'name'],
            [`${n.enabled ? 'Enabled' : 'Disabled'} · ${n.intent}`, 39, 24, 14, 'muted', 'intent'],
            [n.command || '(empty payload)', 66, 25, 14, 'ink', 'preview'],
            [n.delay, 95, 25, 14, 'muted', 'delay'],
            [n.status, 126, 28, 14, 'edge', 'status'],
        ] as const) {
            const text = previewLine(value, CARD.width - 32, height, size, measure);
            cards.push(textRun(text, n.x + 14, n.y + offset, size, tone, role, measure, n.ordinal));
        }
    }
    top = s.graphHeight;
    await add(
        'Full commands · local snapshot, not execution proof',
        18,
        'ink',
        'appendix-heading',
        details,
    );
    for (const [index, value] of s.details.entries()) {
        if (index % 16 === 0) await yieldControl();
        await add(value, 14, 'ink', 'appendix', details);
    }
    s.height = Math.ceil(top + 28);
    s.text = { header, cards, details };
    for (const run of [...header, ...cards, ...details]) {
        const b = run.bounds;
        if (b.x < 0 || b.y < 0 || b.x + b.width > s.width || b.y + b.height > s.height)
            throw Error('Measured text exceeds export bounds. No cropped file was exported.');
    }
    return s;
}

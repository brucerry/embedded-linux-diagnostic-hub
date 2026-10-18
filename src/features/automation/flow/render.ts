import { CARD, displayText, edgePath } from './model';
import { EXPORT_FONT } from './text-layout';
import type { Scene, TextRun } from './types';

const palette = {
    background: '#1d242d',
    card: '#293541',
    ink: '#e7edf4',
    muted: '#b9c4d2',
    edge: '#8bb8ff',
    line: '#738ba6',
};
const xml = (s: string) =>
    displayText(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
    );
const layout = (s: Scene) => {
    if (!s.text)
        throw Error('Export text must be laid out with actual font metrics before rendering.');
    return s.text;
};
export function svg(s: Scene): string {
    const text = layout(s);
    const run = (r: TextRun) =>
        `<text x="${r.x}" y="${r.y}" font-size="${r.size}" fill="${palette[r.tone]}" data-flow-text="${r.role}"${r.ordinal ? ` data-command="${r.ordinal}"` : ''} xml:space="preserve">${xml(r.text)}</text>`;
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}" viewBox="0 0 ${s.width} ${s.height}" role="img"><title>Automation flow · ${xml(s.snapshot.kind)}</title><desc>Complete authored order and command appendix. Local snapshot, not execution proof.</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${palette.edge}"/></marker></defs><rect width="100%" height="100%" fill="${palette.background}"/><g font-family="${EXPORT_FONT}">` +
        text.header.map(run).join('') +
        s.edges
            .map(
                (e) =>
                    `<path d="${edgePath(e.points)}" fill="none" stroke="${palette.edge}" stroke-width="2" marker-end="url(#arrow)"/>`,
            )
            .join('') +
        s.nodes
            .map(
                (n) =>
                    `<rect x="${n.x}" y="${n.y}" width="${CARD.width}" height="${CARD.height}" rx="16" fill="${palette.card}" stroke="${palette.line}" stroke-width="2"/>`,
            )
            .join('') +
        text.cards.map(run).join('') +
        text.details.map(run).join('') +
        '</g></svg>'
    );
}
type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export function canvasText(
    ctx: Context,
    value: string,
    x: number,
    y: number,
    size = 14,
    color = palette.ink,
) {
    ctx.font = `${size}px ${EXPORT_FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(displayText(value), x, y);
}
export function drawTextRun(ctx: Context, run: TextRun) {
    canvasText(ctx, run.text, run.x, run.y, run.size, palette[run.tone]);
}
export function drawGraph(ctx: Context, s: Scene) {
    const text = layout(s);
    ctx.lineWidth = 2;
    ctx.strokeStyle = palette.edge;
    for (const e of s.edges) {
        const [a, c, d, b] = e.points;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.bezierCurveTo(c.x, c.y, d.x, d.y, b.x, b.y);
        ctx.stroke();
        const angle = Math.atan2(b.y - d.y, b.x - d.x);
        ctx.fillStyle = palette.edge;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 10 * Math.cos(angle - 0.4), b.y - 10 * Math.sin(angle - 0.4));
        ctx.lineTo(b.x - 10 * Math.cos(angle + 0.4), b.y - 10 * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fill();
    }
    for (const n of s.nodes) {
        ctx.fillStyle = palette.card;
        ctx.strokeStyle = palette.line;
        ctx.beginPath();
        ctx.roundRect(n.x, n.y, CARD.width, CARD.height, 16);
        ctx.fill();
        ctx.stroke();
    }
    text.cards.forEach((r) => drawTextRun(ctx, r));
}
export function fillBackground(ctx: Context, width: number, height: number) {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, width, height);
}
export function drawScene(ctx: Context, s: Scene) {
    const text = layout(s);
    fillBackground(ctx, s.width, s.height);
    text.header.forEach((r) => drawTextRun(ctx, r));
    drawGraph(ctx, s);
    text.details.forEach((r) => drawTextRun(ctx, r));
}
export async function drawSceneAsync(ctx: Context, s: Scene, yieldControl: () => Promise<void>) {
    const text = layout(s);
    fillBackground(ctx, s.width, s.height);
    text.header.forEach((r) => drawTextRun(ctx, r));
    drawGraph(ctx, s);
    for (let i = 0; i < text.details.length; i++) {
        if (i % 24 === 0) await yieldControl();
        drawTextRun(ctx, text.details[i]);
    }
}

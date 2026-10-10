export type TaskbarEdge = 'left' | 'top' | 'right' | 'bottom';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TaskbarGeometry {
    edge: TaskbarEdge;
    monitor: Rect;
    bounds: Rect;
    button?: Rect;
}

export interface GenieGeometry {
    bounds: Rect;
    source: Rect;
    target: Rect;
    edge: TaskbarEdge;
}

function validRect(rect: Rect): boolean {
    return (
        [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
        rect.width > 0 &&
        rect.height > 0
    );
}

function overlap(a: Rect, b: Rect): number {
    return (
        Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
    );
}

/** Prefer the actual taskbar on this display, then the nearest actual taskbar. */
export function selectTaskbar(display: Rect, taskbars: TaskbarGeometry[]): TaskbarGeometry | null {
    let candidates = taskbars.filter((bar) => validRect(bar.bounds) && validRect(bar.monitor));
    const buttons = candidates.filter((bar) => bar.button && validRect(bar.button));
    if (buttons.length) candidates = buttons;
    candidates.sort((a, b) => {
        const match = overlap(b.monitor, display) - overlap(a.monitor, display);
        if (match) return match;
        const distance = (bar: TaskbarGeometry) =>
            Math.hypot(
                bar.monitor.x + bar.monitor.width / 2 - display.x - display.width / 2,
                bar.monitor.y + bar.monitor.height / 2 - display.y - display.height / 2,
            );
        return distance(a) - distance(b);
    });
    return candidates[0] ?? null;
}

/** A work-area inset is a fallback only when it identifies exactly one edge. */
export function inferTaskbar(display: Rect, work: Rect): TaskbarGeometry | null {
    const gaps: [TaskbarEdge, number, Rect][] = [
        [
            'left',
            work.x - display.x,
            { x: display.x, y: display.y, width: work.x - display.x, height: display.height },
        ],
        [
            'top',
            work.y - display.y,
            { x: display.x, y: display.y, width: display.width, height: work.y - display.y },
        ],
        [
            'right',
            display.x + display.width - work.x - work.width,
            {
                x: work.x + work.width,
                y: display.y,
                width: display.x + display.width - work.x - work.width,
                height: display.height,
            },
        ],
        [
            'bottom',
            display.y + display.height - work.y - work.height,
            {
                x: display.x,
                y: work.y + work.height,
                width: display.width,
                height: display.y + display.height - work.y - work.height,
            },
        ],
    ];
    const positive = gaps.filter(([, size]) => size > 1);
    if (positive.length !== 1) return null;
    return { edge: positive[0][0], bounds: positive[0][2], monitor: display };
}

export function genieGeometry(source: Rect, bar: TaskbarGeometry): GenieGeometry {
    if (!validRect(source) || !validRect(bar.bounds) || !validRect(bar.monitor))
        throw Error('Invalid Genie geometry.');
    const m = bar.monitor,
        r = bar.bounds;
    const clamp = (value: number, low: number, high: number) =>
        Math.max(low, Math.min(high, value));
    const button = bar.button && validRect(bar.button) ? bar.button : r;
    const cx = clamp(button.x + button.width / 2, m.x + 16, m.x + m.width - 16);
    const cy = clamp(button.y + button.height / 2, m.y + 16, m.y + m.height - 16);
    const target: Rect =
        bar.edge === 'left' || bar.edge === 'right'
            ? {
                  x: clamp(button.x + button.width / 2, m.x + 1, m.x + m.width - 1) - 1,
                  y: cy - 16,
                  width: 2,
                  height: 32,
              }
            : {
                  x: cx - 16,
                  y: clamp(button.y + button.height / 2, m.y + 1, m.y + m.height - 1) - 1,
                  width: 32,
                  height: 2,
              };
    const x = Math.floor(Math.min(source.x, target.x)),
        y = Math.floor(Math.min(source.y, target.y));
    const bounds = {
        x,
        y,
        width: Math.ceil(Math.max(source.x + source.width, target.x + target.width) - x),
        height: Math.ceil(Math.max(source.y + source.height, target.y + target.height) - y),
    };
    return {
        bounds,
        edge: bar.edge,
        source: { ...source, x: source.x - x, y: source.y - y },
        target: { ...target, x: target.x - x, y: target.y - y },
    };
}

export function snapshotSize(width: number, height: number, maxPixels = 4_000_000) {
    if (
        width <= 0 ||
        height <= 0 ||
        ![width, height, maxPixels].every(Number.isFinite) ||
        maxPixels <= 0
    )
        throw Error('Invalid snapshot dimensions.');
    const ratio = Math.min(1, Math.sqrt(maxPixels / width / height));
    return {
        width: Math.max(1, Math.floor(width * ratio)),
        height: Math.max(1, Math.floor(height * ratio)),
    };
}

/** Each strip keeps its original pixel orientation; only destination geometry is warped. */
export function genieStrips(
    geometry: GenieGeometry,
    imageWidth: number,
    imageHeight: number,
    progress: number,
): { source: Rect; destination: Rect }[] {
    const { source, target, edge } = geometry;
    const vertical = edge === 'top' || edge === 'bottom';
    const reversed = edge === 'top' || edge === 'left';
    const sign = reversed ? -1 : 1;
    const pixels = vertical ? imageHeight : imageWidth;
    const primaryLength = vertical ? source.height : source.width;
    const sourceNear =
        sign *
        (vertical
            ? source.y + (reversed ? 0 : source.height)
            : source.x + (reversed ? 0 : source.width));
    const targetPrimary =
        sign * (vertical ? target.y + target.height / 2 : target.x + target.width / 2);
    const sourceCenter = vertical ? source.x + source.width / 2 : source.y + source.height / 2;
    const targetCenter = vertical ? target.x + target.width / 2 : target.y + target.height / 2;
    const sourceAcross = vertical ? source.width : source.height;
    const targetAcross = vertical ? target.width : target.height;
    const p = Math.max(0, Math.min(1, progress));
    const squeeze = Math.min(1, p / 0.65);
    const travel = Math.pow(Math.max(0, (p - 0.2) / 0.8), 2);
    const length = primaryLength * (1 - travel) + 2 * travel;
    const far = sourceNear + (targetPrimary + 1 - sourceNear) * travel - length;
    const result = [];
    for (let pixel = 0; pixel < pixels; pixel += 2) {
        const span = Math.min(2, pixels - pixel),
            fraction = pixel / pixels;
        const taper = squeeze * (0.15 + 0.85 * fraction * fraction);
        const contraction = taper + travel * (1 - taper);
        const across = sourceAcross + (targetAcross - sourceAcross) * contraction;
        const center = sourceCenter + (targetCenter - sourceCenter) * contraction;
        const primary = reversed
            ? -(far + ((pixel + span) / pixels) * length)
            : far + fraction * length;
        const from = reversed ? pixels - pixel - span : pixel;
        result.push({
            source: vertical
                ? { x: 0, y: from, width: imageWidth, height: span }
                : { x: from, y: 0, width: span, height: imageHeight },
            destination: vertical
                ? {
                      x: center - across / 2,
                      y: primary,
                      width: across,
                      height: (length * span) / pixels,
                  }
                : {
                      x: primary,
                      y: center - across / 2,
                      width: (length * span) / pixels,
                      height: across,
                  },
        });
    }
    return result;
}

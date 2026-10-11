// Compositor coordinates are logical pixels, including negative monitor origins.
export const APPLICATION_ID = 'diagnostic-hub.desktop';
export const WINDOW_CLASS = 'diagnostic-hub';
export const UUID = 'diagnostic-hub-genie@diagnostichub.desktop';
export const SHELL_MAJORS = [46, 48, 50];

export function rectangle(value) {
    if (!value) return null;
    const result = Object.fromEntries(
        ['x', 'y', 'width', 'height'].map((key) => [key, value[key]]),
    );
    return Object.values(result).every(Number.isFinite) && result.width > 0 && result.height > 0
        ? result
        : null;
}

export function anchorEdge(icon, monitors) {
    const r = rectangle(icon);
    if (!r) return null;
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const monitor = monitors.find(
        (m) => x >= m.x && y >= m.y && x < m.x + m.width && y < m.y + m.height,
    );
    if (!monitor) return null;
    const edges = [
        ['left', Math.abs(x - monitor.x)],
        ['right', Math.abs(x - monitor.x - monitor.width)],
        ['top', Math.abs(y - monitor.y)],
        ['bottom', Math.abs(y - monitor.y - monitor.height)],
    ].sort((a, b) => a[1] - b[1]);
    return edges[0][1] <= Math.min(monitor.width, monitor.height) / 4 ? edges[0][0] : null;
}

export function deform(source, target, edge, progress, tx, ty) {
    const vertical = edge === 'top' || edge === 'bottom';
    const reversed = edge === 'top' || edge === 'left';
    const sign = reversed ? -1 : 1;
    const fraction = reversed ? 1 - (vertical ? ty : tx) : vertical ? ty : tx;
    const acrossFraction = vertical ? tx : ty;
    const p = Math.max(0, Math.min(1, progress));
    const travel = Math.max(0, (p - 0.2) / 0.8) ** 2;
    const taper = Math.min(1, p / 0.65) * (0.15 + 0.85 * fraction ** 2);
    const contraction = taper + travel * (1 - taper);
    const primaryLength = vertical ? source.height : source.width;
    const sourceNear =
        sign *
        (vertical
            ? source.y + (reversed ? 0 : source.height)
            : source.x + (reversed ? 0 : source.width));
    const targetPrimary =
        sign * (vertical ? target.y + target.height / 2 : target.x + target.width / 2);
    const length = primaryLength * (1 - travel) + 2 * travel;
    const primary =
        sign *
        (sourceNear + (targetPrimary + 1 - sourceNear) * travel - length + fraction * length);
    const sourceCenter = vertical ? source.x + source.width / 2 : source.y + source.height / 2;
    const targetCenter = vertical ? target.x + target.width / 2 : target.y + target.height / 2;
    const sourceAcross = vertical ? source.width : source.height;
    const targetAcross = vertical ? target.width : target.height;
    const across = sourceAcross + (targetAcross - sourceAcross) * contraction;
    const center = sourceCenter + (targetCenter - sourceCenter) * contraction;
    return {
        x: (vertical ? center + (acrossFraction - 0.5) * across : primary) - source.x,
        y: (vertical ? primary : center + (acrossFraction - 0.5) * across) - source.y,
    };
}

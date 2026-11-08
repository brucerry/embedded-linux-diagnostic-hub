export interface GestureRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export function reorderGesturePoints(
    source: GestureRect,
    target: GestureRect,
    viewport: { width: number; height: number },
) {
    for (const value of [
        source.x,
        source.y,
        source.width,
        source.height,
        target.x,
        target.y,
        target.width,
        target.height,
        viewport.width,
        viewport.height,
    ])
        if (!Number.isFinite(value)) throw Error('Non-finite reorder geometry.');
    if (source.width < 24 || source.height < 8 || target.width < 20 || target.height < 20)
        throw Error('Reorder gesture points do not fit their elements.');
    const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    const initiate = { x: start.x + 8, y: start.y + 2 };
    // Card CSS has 16px padding plus border. Hit testing must confirm this point.
    const drop = { x: target.x + 8, y: target.y + 8 };
    if (initiate.x >= source.x + source.width || initiate.y >= source.y + source.height)
        throw Error('Drag initiation would leave the source handle.');
    for (const point of [start, initiate, drop])
        if (
            point.x < 2 ||
            point.x > viewport.width - 2 ||
            point.y < 80 ||
            point.y > viewport.height - 80
        )
            throw Error(
                'Reorder points must remain inside the viewport and away from auto-scroll edges.',
            );
    return { start, initiate, drop };
}

import type { Mouse } from '@playwright/test';

/** Enter a new native drop target, then deliver the next move before awaiting preview. */
export async function visitReorderTarget(
    mouse: Pick<Mouse, 'move'>,
    point: { x: number; y: number },
): Promise<void> {
    await mouse.move(point.x, point.y, { steps: 1 });
    await mouse.move(point.x, point.y, { steps: 1 });
}

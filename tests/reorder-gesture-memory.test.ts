import assert from 'node:assert/strict';
import test from 'node:test';
import { reorderGesturePoints } from './ui/fixtures/reorder-gesture-geometry';

test('reorder geometry keeps initiation in source and initial/reflowed targets off scroll edges', () => {
    const viewport = { width: 1440, height: 1050 };
    for (const [sourceY, targetY] of [[177, 813], [207.5, 843.5], [860.5, 486.5]]) {
        const source = { x: 145, y: sourceY, width: 35, height: 30.5 };
        const target = { x: 128, y: targetY, width: 1174, height: 312.5 };
        const points = reorderGesturePoints(source, target, viewport);
        assert.equal(points.initiate.x - points.start.x, 8);
        assert.ok(points.initiate.x < source.x + source.width && points.initiate.y < source.y + source.height);
        assert.deepEqual(points.drop, { x: target.x + 8, y: target.y + 8 });
        for (const p of Object.values(points)) assert.ok(p.y >= 80 && p.y <= 970);
    }
});

test('reorder geometry refuses the observed offscreen source/target and malformed boxes', () => {
    const viewport = { width: 1440, height: 1050 };
    const source = { x: 145, y: 610.438, width: 35, height: 30.5 };
    const target = { x: 128, y: 1246.438, width: 1174, height: 312.5 };
    assert.throws(() => reorderGesturePoints(source, target, viewport), /viewport/);
    assert.throws(() => reorderGesturePoints({ ...source, y: -267.562 }, { ...target, y: 368.438 }, viewport), /viewport/);
    assert.throws(() => reorderGesturePoints({ ...source, x: NaN }, target, viewport), /Non-finite/);
    assert.throws(() => reorderGesturePoints({ ...source, width: 10 }, target, viewport), /fit/);
});

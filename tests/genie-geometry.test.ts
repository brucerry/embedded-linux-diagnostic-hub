import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    genieGeometry,
    genieStrips,
    inferTaskbar,
    selectTaskbar,
    snapshotSize,
    type Rect,
    type TaskbarEdge,
    type TaskbarGeometry,
} from '../electron/genie-geometry';

const monitor: Rect = { x: -1920, y: -40, width: 1920, height: 1080 };
const source: Rect = { x: -1600, y: 100, width: 640, height: 480 };
function bar(edge: TaskbarEdge): TaskbarGeometry {
    const bounds =
        edge === 'top'
            ? { ...monitor, height: 40 }
            : edge === 'bottom'
              ? { ...monitor, y: monitor.y + monitor.height - 40, height: 40 }
              : edge === 'left'
                ? { ...monitor, width: 40 }
                : { ...monitor, x: monitor.x + monitor.width - 40, width: 40 };
    return { edge, bounds, monitor };
}

function near(actual: number, expected: number) {
    assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);
}

for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    test(`Genie ${edge} starts unrotated and ends at the actual taskbar anchor`, () => {
        const geometry = genieGeometry(source, bar(edge));
        const initial = genieStrips(geometry, 1280, 960, 0);
        assert.ok(initial.length > 0);
        for (const strip of initial) {
            near(strip.destination.x, geometry.source.x + (strip.source.x / 1280) * source.width);
            near(strip.destination.y, geometry.source.y + (strip.source.y / 960) * source.height);
            near(strip.destination.width, (strip.source.width / 1280) * source.width);
            near(strip.destination.height, (strip.source.height / 960) * source.height);
        }
        const final = genieStrips(geometry, 1280, 960, 1).map((s) => s.destination);
        near(Math.min(...final.map((s) => s.x)), geometry.target.x);
        near(Math.min(...final.map((s) => s.y)), geometry.target.y);
        near(
            Math.max(...final.map((s) => s.x + s.width)),
            geometry.target.x + geometry.target.width,
        );
        near(
            Math.max(...final.map((s) => s.y + s.height)),
            geometry.target.y + geometry.target.height,
        );
        const middle = genieStrips(geometry, 1280, 960, 0.6);
        assert.ok(middle.every((s) => s.destination.width > 0 && s.destination.height > 0));
        const targetX = geometry.target.x + geometry.bounds.x;
        const targetY = geometry.target.y + geometry.bounds.y;
        assert.ok(targetX >= monitor.x && targetX < monitor.x + monitor.width);
        assert.ok(targetY >= monitor.y && targetY < monitor.y + monitor.height);
    });

    test(`Work-area fallback recognizes a ${edge} taskbar`, () => {
        const work = { ...monitor };
        if (edge === 'left') {
            work.x += 40;
            work.width -= 40;
        }
        if (edge === 'right') work.width -= 40;
        if (edge === 'top') {
            work.y += 40;
            work.height -= 40;
        }
        if (edge === 'bottom') work.height -= 40;
        assert.equal(inferTaskbar(monitor, work)?.edge, edge);
    });
}

test('Ambiguous work areas and hidden taskbars are not guessed as bottom', () => {
    assert.equal(inferTaskbar(monitor, monitor), null);
    assert.equal(
        inferTaskbar(monitor, {
            ...monitor,
            x: monitor.x + 40,
            width: monitor.width - 40,
            height: monitor.height - 40,
        }),
        null,
    );
});

test('Taskbar selection follows the active monitor and ignores invalid rectangles', () => {
    const primary = {
        edge: 'bottom',
        bounds: { x: 0, y: 1040, width: 1920, height: 40 },
        monitor: { x: 0, y: 0, width: 1920, height: 1080 },
    } as const;
    const secondary = bar('left');
    const input = [
        primary,
        secondary,
        { ...secondary, bounds: { ...secondary.bounds, width: NaN } },
    ];
    assert.equal(selectTaskbar(monitor, input), secondary);
    assert.equal(selectTaskbar(primary.monitor, input), primary);
    assert.equal(input[0], primary);
    assert.equal(selectTaskbar(monitor, []), null);
});

test('Autohide taskbar rectangles outside the display clamp to the right edge', () => {
    const right = bar('right');
    right.bounds.x = monitor.x + monitor.width;
    const geometry = genieGeometry(source, right);
    assert.equal(geometry.target.x + geometry.bounds.x, monitor.x + monitor.width - 2);
});

test('Scaling bounds large snapshots without changing their aspect ratio', () => {
    const size = snapshotSize(7680, 4320);
    assert.ok(size.width * size.height <= 4_000_000);
    assert.ok(Math.abs(size.width / size.height - 7680 / 4320) < 0.002);
    assert.deepEqual(snapshotSize(824, 495), { width: 824, height: 495 });
    assert.throws(() => snapshotSize(0, 480));
    assert.throws(() => genieGeometry({ ...source, width: NaN }, bar('top')));
});

for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    test(`The ${edge} animation anchors to the app button rather than the taskbar midpoint`, () => {
        const taskbar = bar(edge);
        taskbar.button =
            edge === 'top' || edge === 'bottom'
                ? { x: monitor.x + 280, y: taskbar.bounds.y + 4, width: 120, height: 24 }
                : { x: taskbar.bounds.x + 4, y: monitor.y + 200, width: 24, height: 120 };
        const geometry = genieGeometry(source, taskbar);
        near(
            geometry.bounds.x + geometry.target.x + geometry.target.width / 2,
            taskbar.button.x + taskbar.button.width / 2,
        );
        near(
            geometry.bounds.y + geometry.target.y + geometry.target.height / 2,
            taskbar.button.y + taskbar.button.height / 2,
        );
    });
}

test('An actual app button on another monitor takes priority over an empty local taskbar', () => {
    const local = bar('top');
    const remote: TaskbarGeometry = {
        edge: 'bottom',
        monitor: { x: 0, y: 0, width: 1920, height: 1080 },
        bounds: { x: 0, y: 1040, width: 1920, height: 40 },
        button: { x: 300, y: 1040, width: 60, height: 40 },
    };
    assert.equal(selectTaskbar(monitor, [local, remote]), remote);
});

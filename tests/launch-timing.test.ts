import test from 'node:test';
import assert from 'node:assert/strict';
import { createLaunchTimingRecorder } from '../shared/launch-timing';

test('main milestones are offsets from one injected monotonic origin', () => {
    let clock = 100;
    const recorder = createLaunchTimingRecorder('main-module-body', () => clock);
    recorder.mark('entry');
    clock = 125;
    recorder.mark('ready');
    assert.deepEqual(recorder.snapshot(), {
        schema: 1,
        clockDomain: 'main-module-body',
        milestones: [
            { name: 'entry', elapsedMs: 0 },
            { name: 'ready', elapsedMs: 25 },
        ],
    });
});

test('renderer navigation origin includes entry-body delay, unlike the main origin', () => {
    const main = createLaunchTimingRecorder('main-module-body', () => 800);
    const renderer = createLaunchTimingRecorder('renderer-navigation', () => 80, 0);
    main.mark('main');
    renderer.mark('renderer');
    assert.equal(main.snapshot().milestones[0].elapsedMs, 0);
    assert.equal(renderer.snapshot().milestones[0].elapsedMs, 80);
    assert.notEqual(main.snapshot().clockDomain, renderer.snapshot().clockDomain);
    // Deliberately no subtraction between these unrelated clock domains.
});

test('buffered FCP keeps its own browser timestamp, not the snapshot read time', () => {
    let clock = 60;
    const recorder = createLaunchTimingRecorder('renderer-navigation', () => clock, 0);
    recorder.mark('entry');
    clock = 100;
    recorder.mark('app-layout-effect');
    clock = 500;
    recorder.mark('fcp', 75);
    assert.deepEqual(recorder.snapshot().milestones, [
        { name: 'entry', elapsedMs: 60 },
        { name: 'app-layout-effect', elapsedMs: 100 },
        { name: 'fcp', elapsedMs: 75 },
    ]);
});

test('first milestone wins across StrictMode replay and repeated observations', () => {
    let calls = 0;
    const recorder = createLaunchTimingRecorder('renderer-navigation', () => ++calls, 0);
    recorder.mark('commit');
    for (let i = 0; i < 100; i++) recorder.mark('commit');
    assert.equal(calls, 1);
    assert.deepEqual(recorder.snapshot().milestones, [{ name: 'commit', elapsedMs: 1 }]);
});

test('32-entry capacity is hard and full buffers stop sampling the clock', () => {
    let calls = 0;
    const recorder = createLaunchTimingRecorder('main-module-body', () => ++calls, 0);
    for (let i = 0; i < 100; i++) recorder.mark('milestone-' + i);
    assert.equal(calls, 32);
    assert.equal(recorder.snapshot().milestones.length, 32);
    assert.deepEqual(recorder.snapshot().milestones.at(-1), {
        name: 'milestone-31',
        elapsedMs: 32,
    });
});

test('empty and overlong names are ignored without sampling', () => {
    let calls = 0;
    const recorder = createLaunchTimingRecorder('main-module-body', () => ++calls, 0);
    recorder.mark('');
    recorder.mark('x'.repeat(81));
    assert.equal(calls, 0);
    recorder.mark('x'.repeat(80));
    assert.equal(recorder.snapshot().milestones.length, 1);
});

test('invalid and pre-origin samples are absent rather than clamped to zero', () => {
    const recorder = createLaunchTimingRecorder('main-module-body', () => 100, 100);
    for (const value of [NaN, Infinity, -Infinity, 99]) recorder.mark('event', value);
    assert.deepEqual(recorder.snapshot().milestones, []);
    recorder.mark('event', 100);
    assert.deepEqual(recorder.snapshot().milestones, [{ name: 'event', elapsedMs: 0 }]);
});

test('a failed sample does not escape or prevent a later valid sample', () => {
    let fail = true;
    const recorder = createLaunchTimingRecorder(
        'main-module-body',
        () => {
            if (fail) throw new Error('fake clock unavailable');
            return 12;
        },
        10,
    );
    assert.doesNotThrow(() => recorder.mark('event'));
    assert.deepEqual(recorder.snapshot().milestones, []);
    fail = false;
    recorder.mark('event');
    assert.deepEqual(recorder.snapshot().milestones, [{ name: 'event', elapsedMs: 2 }]);
});

test('unavailable or non-finite origins do not create fabricated zero timings', () => {
    const unavailable = createLaunchTimingRecorder('main-module-body', () => {
        throw new Error('fake origin unavailable');
    });
    const nonfinite = createLaunchTimingRecorder('main-module-body', () => Infinity);
    assert.doesNotThrow(() => unavailable.mark('event', 1));
    nonfinite.mark('event', 1);
    assert.deepEqual(unavailable.snapshot().milestones, []);
    assert.deepEqual(nonfinite.snapshot().milestones, []);
});

test('snapshots are copies and cannot rewrite or grow retained evidence', () => {
    const recorder = createLaunchTimingRecorder('main-module-body', () => 10, 0);
    recorder.mark('event');
    const first = recorder.snapshot();
    first.milestones[0].elapsedMs = 999;
    first.milestones.push({ name: 'injected', elapsedMs: 999 });
    first.clockDomain = 'renderer-navigation';
    assert.deepEqual(recorder.snapshot(), {
        schema: 1,
        clockDomain: 'main-module-body',
        milestones: [{ name: 'event', elapsedMs: 10 }],
    });
});

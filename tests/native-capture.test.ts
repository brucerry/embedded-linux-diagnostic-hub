import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ElectronApplication, Page } from '@playwright/test';
import { captureNativeScreenshot } from './fixtures/native-capture';

const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ZkAAAAASUVORK5CYII=',
    'base64',
);
const protocol = () =>
    Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
function fixture(
    errors: (Error | Buffer)[],
    native = { count: 1, visible: true, minimized: false, loading: false, crashed: false },
) {
    const captures: { path: string; fullPage: boolean; timeout: number }[] = [];
    let readiness = 0,
        observations = 0;
    const page = {
        screenshot: async (options: { path: string; fullPage: boolean; timeout: number }) => {
            captures.push(options);
            const value = errors.shift();
            if (value instanceof Error) throw value;
            return value ?? png;
        },
        waitForFunction: async () => {
            readiness++;
        },
    } as unknown as Page;
    const desktop = {
        evaluate: async () => {
            observations++;
            return native;
        },
    } as unknown as ElectronApplication;
    return { page, desktop, captures, counts: () => ({ readiness, observations }) };
}

test('specific capture-surface failure still requires a full-page PNG within one shared budget', async () => {
    const f = fixture([protocol(), png]);
    await captureNativeScreenshot(f.desktop, f.page, 'capture.png');
    assert.equal(f.captures.length, 2);
    assert.ok(
        f.captures.every(
            (c) => c.fullPage && c.path === 'capture.png' && c.timeout > 0 && c.timeout <= 30_000,
        ),
    );
    assert.ok(f.captures[1].timeout <= f.captures[0].timeout);
    assert.deepEqual(f.counts(), { readiness: 1, observations: 1 });
});

test('unexpected capture errors are not retried or waived', async () => {
    const error = Error('Renderer crashed');
    const f = fixture([error]);
    await assert.rejects(
        captureNativeScreenshot(f.desktop, f.page, 'capture.png'),
        (e) => e === error,
    );
    assert.equal(f.captures.length, 1);
    assert.deepEqual(f.counts(), { readiness: 0, observations: 0 });
});

test('a repeated capture protocol failure remains a failed gate', async () => {
    const second = protocol();
    const f = fixture([protocol(), second]);
    await assert.rejects(
        captureNativeScreenshot(f.desktop, f.page, 'capture.png'),
        (e) => e === second,
    );
    assert.equal(f.captures.length, 2);
});

test('capture recovery never substitutes a hidden or minimized native window', async () => {
    const f = fixture([protocol()], {
        count: 1,
        visible: false,
        minimized: true,
        loading: false,
        crashed: false,
    });
    await assert.rejects(captureNativeScreenshot(f.desktop, f.page, 'capture.png'));
    assert.equal(f.captures.length, 1);
    assert.equal(f.counts().readiness, 0);
});

test('an empty or zero-size image cannot satisfy screenshot evidence', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(50)]) {
        const f = fixture([bytes]);
        await assert.rejects(captureNativeScreenshot(f.desktop, f.page, 'capture.png'));
        assert.equal(f.captures.length, 1);
    }
});

test('an exhausted capture deadline cannot start readiness or a fresh capture budget', async (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const f = fixture([]);
    f.page.screenshot = async (options) => {
        f.captures.push(options as { path: string; fullPage: boolean; timeout: number });
        now = 30_001;
        throw protocol();
    };
    await assert.rejects(
        captureNativeScreenshot(f.desktop, f.page, 'capture.png'),
        /exhausted its original 30000-ms budget/,
    );
    assert.equal(f.captures.length, 1);
    assert.deepEqual(f.counts(), { readiness: 0, observations: 0 });
});

test('capture recovery callback executes in a fresh context without transpiler globals', async () => {
    const f = fixture([protocol(), png]);
    f.page.waitForFunction = (async (
        predicate: unknown,
        _argument: unknown,
        options: { timeout: number },
    ) => {
        assert.equal(typeof predicate, 'function');
        const result = await runInNewContext('(' + String(predicate) + ')()', {
            document: {
                visibilityState: 'visible',
                readyState: 'complete',
                documentElement: { scrollWidth: 1280, scrollHeight: 900 },
            },
            innerWidth: 1280,
            innerHeight: 900,
            Promise,
            requestAnimationFrame: (callback: () => void) => setImmediate(callback),
        });
        assert.equal(result, true);
        assert(options.timeout > 0 && options.timeout <= f.captures[0].timeout);
        return {};
    }) as typeof f.page.waitForFunction;
    await captureNativeScreenshot(f.desktop, f.page, 'capture.png');
    assert.equal(f.captures.length, 2);
    assert(f.captures[1].timeout <= f.captures[0].timeout);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskbars, TaskbarReader } from '../electron/taskbar-reader';

test('native metadata rejects malformed, unbounded and invalid taskbar rectangles', () => {
    for (const line of [
        'invalid',
        'null',
        JSON.stringify({ bars: [null, {}, { edge: 'middle' }] }),
        ' '.repeat(16384),
    ])
        assert.deepEqual(parseTaskbars(line), []);
    const bounds = { x: -1920, y: 0, width: 40, height: 1080 };
    const bar = { edge: 'left', bounds, monitor: { x: -1920, y: 0, width: 1920, height: 1080 } };
    assert.deepEqual(parseTaskbars(JSON.stringify({ bars: [bar] })), [bar]);
    assert.deepEqual(
        parseTaskbars(JSON.stringify({ bars: [{ ...bar, bounds: { ...bounds, width: 0 } }] })),
        [],
    );
    assert.deepEqual(
        parseTaskbars(JSON.stringify({ bars: Array.from({ length: 33 }, () => bar) })),
        [],
    );
    assert.deepEqual(
        parseTaskbars(
            JSON.stringify({ bars: [{ ...bar, button: { x: 0, y: 0, width: -1, height: 32 } }] }),
        ),
        [bar],
    );
});

test('a timed-out helper is warmed before the replacement lookup deadline starts', async () => {
    const originalSpawn = childProcess.spawn;
    const bounds = { x: 0, y: 0, width: 1920, height: 32 };
    const bar = {
        edge: 'top',
        bounds,
        monitor: { x: 0, y: 0, width: 1920, height: 1080 },
        button: { x: 100, y: 0, width: 32, height: 32 },
    };
    const children: EventEmitter[] = [];
    childProcess.spawn = (() => {
        const child = new EventEmitter() as EventEmitter & {
            stdin: Writable;
            stdout: PassThrough;
            stderr: PassThrough;
            kill(): boolean;
        };
        let initialized = false;
        let killed = false;
        const timers = new Set<NodeJS.Timeout>();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
            write(chunk, _encoding, callback) {
                const request = JSON.parse(String(chunk));
                const timer = setTimeout(
                    () => {
                        timers.delete(timer);
                        initialized = true;
                        if (!killed)
                            child.stdout.write(
                                JSON.stringify({
                                    bars: [request.appId ? bar : { ...bar, button: undefined }],
                                }) + '\n',
                            );
                    },
                    initialized ? 2 : 80,
                );
                timers.add(timer);
                callback();
            },
        });
        child.kill = () => {
            killed = true;
            for (const timer of timers) clearTimeout(timer);
            child.stdin.destroy();
            child.stdout.end();
            child.stderr.end();
            queueMicrotask(() => child.emit('exit', 0));
            return true;
        };
        children.push(child);
        return child;
    }) as unknown as typeof childProcess.spawn;
    syncBuiltinESMExports();
    const reader = new TaskbarReader('dev.diagnostichub.desktop', () => 'Diagnostic Hub');
    const protocol = reader as unknown as {
        query(timeout: number, identity?: boolean): Promise<unknown[]>;
    };
    try {
        await reader.ready();
        assert.deepEqual(await protocol.query(1), []);
        assert.deepEqual(await protocol.query(30), [bar]);
        assert.equal(children.length, 2, 'Only the timed-out helper should be replaced.');
        assert.deepEqual(await protocol.query(1), []);
        const starting = protocol.query(30);
        reader.close();
        assert.deepEqual(await starting, []);
        assert.deepEqual(await protocol.query(30), []);
        assert.equal(children.length, 3, 'Disposal must not restart a warming helper.');
    } finally {
        reader.close();
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
    }
});
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';

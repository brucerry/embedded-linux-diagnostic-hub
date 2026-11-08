import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync('src/hooks/useDeviceSession.ts', 'utf8');
const begin = source.indexOf('        if (!bridge) return;\n        let cancelled = false;');
const end = source.indexOf('    }, [bridge]);', begin);
assert.ok(begin > 0 && end > begin);
const body = source.slice(begin, end);
const turns = async () => {
    for (let n = 0; n < 32; n++) await Promise.resolve();
};
function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (e: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function fixture() {
    const read = deferred<any>(),
        ack = deferred<void>(),
        generation = { current: 0 };
    const state = {
        snapshot: null as unknown,
        error: '',
        notice: '',
        imported: false,
        history: ['prior'] as unknown[],
        acks: [] as string[],
    };
    const bridge = {
        readUpdateReport: () => read.promise,
        acknowledgeUpdateReport: (id: string) => {
            state.acks.push(id);
            return ack.promise;
        },
    };
    const mount = new Function(
        'bridge',
        'dataGeneration',
        'setUpdateReport',
        'setConnected',
        'setLiveState',
        'setWorkspaceReady',
        'setSnapshot',
        'setImported',
        'setHistory',
        'setNotice',
        'setError',
        'message',
        body,
    );
    const dispose = mount(
        bridge,
        generation,
        () => {},
        () => {},
        () => {},
        () => {},
        (v: unknown) => {
            state.snapshot = v;
        },
        (v: boolean) => {
            state.imported = v;
        },
        (v: unknown[]) => {
            state.history = v;
        },
        (v: string) => {
            state.notice = v;
        },
        (v: string) => {
            state.error = v;
        },
        (e: Error) => e.message,
    ) as () => void;
    return { read, ack, generation, state, dispose };
}
const report = (mode = 'smart') => ({
    id: 'memory-recovery',
    mode,
    reportPath: '/memory/backup.json',
    snapshot: { endpoint: 'retained-only' },
});
test('acknowledgement failure describes retained available evidence rather than failed reopening', async () => {
    for (const mode of ['smart', 'preserve']) {
        const f = fixture();
        f.read.resolve(report(mode));
        await turns();
        f.ack.reject(Error('marker cleanup failed'));
        await turns();
        assert.match(f.state.error, /recovery acknowledgement failed: marker cleanup failed/);
        assert.doesNotMatch(f.state.error, /Could not reopen/);
        assert.deepEqual(f.state.snapshot, mode === 'smart' ? report().snapshot : null);
        f.dispose();
    }
});
test('retired read or acknowledgement failures cannot overwrite a newer diagnostic', async () => {
    for (const phase of ['read', 'ack']) {
        const f = fixture();
        if (phase === 'ack') {
            f.read.resolve(report());
            await turns();
        }
        f.generation.current++;
        f.state.error = 'New owner diagnostic';
        if (phase === 'read') f.read.reject(Error('old read'));
        else f.ack.reject(Error('old ack'));
        await turns();
        assert.equal(f.state.error, 'New owner diagnostic');
        f.dispose();
    }
});
test('current read failure and disposed effects retain their respective diagnostic ownership', async () => {
    const current = fixture();
    current.read.reject(Error('invalid saved record'));
    await turns();
    assert.equal(
        current.state.error,
        'Could not reopen the saved update report: invalid saved record',
    );
    assert.equal(current.state.snapshot, null);
    current.dispose();
    const disposed = fixture();
    disposed.read.resolve(report());
    await turns();
    disposed.dispose();
    disposed.state.error = 'Next component diagnostic';
    disposed.ack.reject(Error('old component ack'));
    await turns();
    assert.equal(disposed.state.error, 'Next component diagnostic');
});

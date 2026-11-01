import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeConsoleService } from '../electron/console-service';
import { NativeConsoleJournal } from '../electron/console-journal';
import { consoleHeader } from '../shared/console-journal';
import { consoleSnapshot, type ConsoleRead } from '../shared/console-storage';
import { runQuitCleanup } from '../shared/quit-cleanup';

const profile = '/__hub_memory_journal_only__';
const id = '00000000-0000-4000-8000-000000000001';
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
}
function observe<T>(promise: Promise<T>) {
    const state: { done: boolean; rejected: boolean; value?: T; error?: unknown } = {
        done: false, rejected: false,
    };
    void promise.then(
        (value) => { state.value = value; state.done = true; },
        (error: unknown) => { state.error = error; state.rejected = true; state.done = true; },
    );
    return state;
}
async function pump() {
    for (let i = 0; i < 128; i++) await Promise.resolve();
}
async function until(predicate: () => boolean) {
    for (let i = 0; i < 128 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate(), 'Memory integration did not reach its bounded observation.');
}
function reasons(error: unknown): unknown[] {
    return error instanceof AggregateError ? error.errors.flatMap(reasons) : [error];
}
function memoryJournal(options: {
    readers?: { held?: Promise<void>; failure?: Error }[];
    listHeld?: Promise<void>;
    closeFailure?: Error;
} = {}) {
    const counts = { opens: 0, reads: 0, returns: 0, lists: 0, pins: 0, releases: 0, closes: 0 };
    let closed = false;
    const capture = consoleSnapshot({
        schema: 2,
        header: consoleHeader({
            schema: 2, id, flowId: 'memory-quit', startedAt: '2026-10-29T00:00:00.000Z',
            receiveTimeSource: 'local-client',
            target: { endpoint: 'memory.invalid:22', username: 'synthetic' },
            ready: { role: 'shell-prompt', literals: ['memory# '] },
        }),
        state: 'incomplete', offset: 0, records: 0, bytes: 0, observations: 0, segments: 0,
        finalizedAt: '2026-10-29T00:00:00.000Z', reason: 'interrupted',
        observedBytes: null, failure: null, shellClosed: true,
    });
    const originalCapture = structuredClone(capture);
    const target = {
        then: undefined,
        get resourceClosed() { return closed; },
        async list() {
            assert.ok(++counts.lists <= 1);
            await options.listHeld;
            return { captures: [], next: null, mode: 'scan' as const };
        },
        read(requested: string): AsyncGenerator<ConsoleRead> {
            assert.equal(requested, id);
            const setting = options.readers?.[counts.reads++];
            assert.ok(setting, 'Unexpected memory reader admission.');
            return (async function* () {
                try {
                    yield { kind: 'metadata' as const, capture: structuredClone(capture) };
                } finally {
                    assert.ok(++counts.returns <= (options.readers?.length ?? 0));
                    await setting.held;
                    if (setting.failure) throw setting.failure;
                }
            })();
        },
        async pin() {
            assert.ok(++counts.pins <= 1);
            let released = false;
            return {
                async release() {
                    if (released) return;
                    released = true;
                    counts.releases++;
                },
            };
        },
        async close() {
            assert.ok(++counts.closes <= 1, 'Unexpected second journal close.');
            if (options.closeFailure) throw options.closeFailure;
            closed = true;
        },
    };
    // Async factory assimilation reads .then; every other unadmitted operation fails closed.
    const journal = new Proxy(target, {
        get(object, key, receiver) {
            if (!Object.hasOwn(object, key))
                throw Error('Unexpected memory journal capability: ' + String(key));
            return Reflect.get(object, key, receiver);
        },
    });
    return {
        journal, counts,
        assertUnchanged() { assert.deepEqual(capture, originalCapture); },
    };
}
async function withFactory(
    fixture: ReturnType<typeof memoryJournal>,
    body: (service: NativeConsoleService) => Promise<void>,
    opening?: Promise<void>,
) {
    assert.equal(process.versions.electron, undefined, 'Plain Node is required.');
    const descriptor = Object.getOwnPropertyDescriptor(NativeConsoleJournal, 'open');
    assert.ok(descriptor?.configurable && descriptor.writable);
    const replacement = async (requested: string, ownership: { profileOwned: true }) => {
        assert.equal(requested, profile);
        assert.deepEqual(ownership, { profileOwned: true });
        assert.ok(++fixture.counts.opens <= 1, 'Unexpected native factory admission.');
        await opening;
        return fixture.journal as unknown as NativeConsoleJournal;
    };
    Object.defineProperty(NativeConsoleJournal, 'open', { ...descriptor, value: replacement });
    try {
        await body(new NativeConsoleService(profile));
    } finally {
        Object.defineProperty(NativeConsoleJournal, 'open', descriptor);
        assert.deepEqual(Object.getOwnPropertyDescriptor(NativeConsoleJournal, 'open'), descriptor);
        fixture.assertUnchanged();
    }
}

test('actual console preparation retains a failed reader while joining sibling readers and requests', { concurrency: false }, async () => {
    const reader = gate(), listing = gate(), failure = Error('Synthetic reader return failed');
    const f = memoryJournal({ readers: [{ failure }, { held: reader.promise }], listHeld: listing.promise });
    await withFactory(f, async (service) => {
        try {
            await service.dispatch({ op: 'read', id });
            await service.dispatch({ op: 'read', id });
            await service.dispatch({ op: 'pin' });
            const request = observe(service.dispatch({ op: 'list' }));
            await until(() => f.counts.lists === 1);
            const task = service.prepareShutdown(), preparation = observe(task);
            assert.equal(service.prepareShutdown(), task);
            assert.throws(() => service.createWriter(), /shutting down/);
            await until(() => f.counts.returns === 2 && f.counts.releases === 1);
            assert.equal(preparation.done, false);
            reader.release();
            await pump();
            assert.equal(preparation.done, false, 'Existing list request must also settle.');
            listing.release();
            await until(() => preparation.done && request.done);
            assert.equal(preparation.rejected, true);
            assert.deepEqual(reasons(preparation.error), [failure]);
            assert.equal(request.rejected, true, 'Old operation is invalidated by the real epoch guard.');
            assert.equal(service.snapshot.references, 1);
            assert.equal(service.snapshot.readers, 1);
            assert.equal(service.snapshot.pins, 0);
            const finish = observe(service.finishShutdown());
            await until(() => finish.done);
            assert.equal(finish.rejected, true);
            assert.equal(f.counts.closes, 0);
            assert.equal(service.hasResources, true);
        } finally { reader.release(); listing.release(); await pump(); }
    });
});

test('actual root and service wait the producer and do not reclose its acknowledged memory journal', { concurrency: false }, async () => {
    const producer = gate(), f = memoryJournal();
    await withFactory(f, async (service) => {
        try {
            await service.createWriter();
            let producerStarted = false;
            const result = observe(runQuitCleanup({
                cancelConnection: () => {}, clearHostVerification: () => {}, disconnect: () => {},
                prepareConsole: () => service.prepareShutdown(),
                joinConnection: async () => {},
                joinSsh: async () => {
                    producerStarted = true;
                    await producer.promise;
                    await f.journal.close();
                },
                finishConsole: () => service.finishShutdown(),
                shutdownCapture: async () => {},
            }));
            await until(() => producerStarted);
            assert.equal(result.done, false);
            assert.equal(f.counts.closes, 0);
            producer.release();
            await until(() => result.done);
            assert.equal(result.rejected, false);
            assert.equal(f.counts.closes, 1);
            assert.equal(service.hasResources, false);
            const finishing = service.finishShutdown();
            assert.equal(service.finishShutdown(), finishing);
            const repeated = observe(finishing);
            await until(() => repeated.done);
            assert.equal(repeated.rejected, false);
            assert.equal(f.counts.closes, 1);
        } finally { producer.release(); await pump(); }
    });
});

test('actual idle journal close failure stays cached and owned without retry', { concurrency: false }, async () => {
    const failure = Error('Synthetic journal closure not acknowledged'), f = memoryJournal({ closeFailure: failure });
    await withFactory(f, async (service) => {
        await service.dispatch({ op: 'pin' });
        const preparation = observe(service.prepareShutdown());
        await until(() => preparation.done);
        assert.equal(preparation.rejected, false);
        const task = service.finishShutdown(), result = observe(task);
        assert.equal(service.finishShutdown(), task);
        await until(() => result.done);
        assert.equal(result.error, failure);
        assert.equal(result.rejected, true);
        assert.equal(f.counts.closes, 1);
        assert.equal(f.journal.resourceClosed, false);
        assert.equal(service.hasResources, true);
        assert.equal(service.finishShutdown(), task);
        await pump();
        assert.equal(f.counts.closes, 1);
    });
});

test('actual preparation joins the admitted factory transition and invalidated request', { concurrency: false }, async () => {
    const opening = gate(), f = memoryJournal();
    await withFactory(f, async (service) => {
        try {
            const request = observe(service.dispatch({ op: 'list' }));
            const preparation = observe(service.prepareShutdown());
            await until(() => f.counts.opens === 1);
            assert.equal(service.snapshot.transition, true);
            assert.equal(preparation.done, false);
            assert.throws(() => service.createWriter(), /shutting down/);
            opening.release();
            await until(() => request.done && preparation.done);
            assert.equal(request.rejected, true);
            assert.equal(preparation.rejected, false);
            assert.equal(service.snapshot.references, 0);
            assert.equal(f.counts.lists, 0, 'Epoch guard must refuse the stale request before list.');
            const result = observe(service.finishShutdown());
            await until(() => result.done);
            assert.equal(result.rejected, false);
            assert.equal(f.counts.closes, 1);
            assert.equal(service.hasResources, false);
        } finally { opening.release(); await pump(); }
    }, opening.promise);
});

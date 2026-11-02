import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindResultsCallbacks, boundSpans, type CallbackContext, type MemoryViewState } from './fixtures/console-results-callbacks';
import { ConsoleResultsOwner } from '../src/features/automation/capture/console-results-owner';
import { ConsoleExportDiagnostic } from '../src/features/automation/capture/console-export-diagnostic';
import { consoleSnapshot, type ConsoleArchive } from '../shared/console-storage';
const source = readFileSync('src/features/automation/capture/use-console-results.ts', 'utf8');
for (const span of boundSpans) assert.ok(source.includes(span), 'Active callback binding changed');
async function until(check: () => boolean) {
    for (let n = 0; n < 160; n++) { if (check()) return; await Promise.resolve(); }
    assert.fail('Memory callback boundary did not settle');
}
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const stamp = '2026-11-02T00:00:00.000Z';
const row = (n: number) => consoleSnapshot({
    schema: 2, header: { schema: 2, id: id(n), flowId: 'memory-flow', startedAt: stamp,
        receiveTimeSource: 'local-client', target: { endpoint: 'memory-only' },
        ready: { role: 'shell-prompt', literals: ['# '] } },
    state: 'complete', offset: 0, records: 0, bytes: 0, observations: 0, segments: 0,
    finalizedAt: stamp, reason: 'complete', observedBytes: 0, failure: null, shellClosed: true,
});

test('cancelled empty last page cannot replace newer page rows/cursor or cross-page selection', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const seen: (string | undefined)[] = [], fulfilled: unknown[] = [], rejected: unknown[] = [];
    let disposed = false, busy = false;
    const captures = Array.from({ length: 25 }, (_, n) => row(n + 2));
    const archive: ConsoleArchive = {
        async list(after, limit) {
            assert.equal(limit, 25); seen.push(after);
            if (after === id(1)) { await pending; return { captures: [], next: null, mode: 'scan' }; }
            assert.equal(after, undefined); return { captures, next: id(26), mode: 'indexed' };
        },
        async *read() { assert.fail('No raw reader needed for unfiltered metadata pages'); },
        async pin() { throw Error('No export or storage pin admitted'); },
        async delete() { assert.fail('No deletion admitted'); },
    };
    const owner = new ConsoleResultsOwner(async () => ({ archive, async dispose() { disposed = true; } }), value => { busy = value; });
    const actualRun = owner.run.bind(owner);
    owner.run = work => {
        const task = actualRun(work);
        void task.then(value => { fulfilled.push(value); }, error => { rejected.push(error); });
        return task;
    };
    await owner.ready;
    const selected = new Set([id(1), id(2)]);
    const state: MemoryViewState = { status: 'ready', failure: null, catalogFailure: null, rows: [], next: null, mode: 'scan',
        preview: null, previewLoading: false, operation: null, revision: 0, exportStatus: null, cleanupDiagnostic: null,
        selected, notice: null, confirmation: null, cursor: id(1), back: [undefined] };
    const setters: Record<string, (value: unknown) => void> = {};
    for (const key of Object.keys(state)) setters['set' + key[0].toUpperCase() + key.slice(1)] = value => {
        const data = state as unknown as Record<string, unknown>;
        data[key] = typeof value === 'function' ? value(data[key]) : value;
    };
    const context: CallbackContext = { state, setters: setters as CallbackContext['setters'], options: { visible: true }, owner, ready: true,
        current: { current: owner }, latest: { current: { visible: true, running: false } }, activeOperation: { current: null },
        armReservation: { current: null }, previewGeneration: { current: 0 }, exportDiagnosticOwner: { current: new ConsoleExportDiagnostic() },
        applied: { completion: 'complete' }, filter: {}, format: 'json', selection: 'selected',
        startConsoleExport: async () => { throw Error('No export admitted'); } };
    const oldCleanup = bindResultsCallbacks(context).refreshCatalog();
    await until(() => seen.length === 1);
    oldCleanup?.();
    // Model the committed state of a new filter/first page; React scheduling is not executed.
    state.cursor = undefined; state.back = []; context.applied = {};
    const currentCleanup = bindResultsCallbacks(context).refreshCatalog();
    try {
        await until(() => state.status === 'ready');
        assert.deepEqual(state.rows.map(value => value.header.id), captures.map(value => value.header.id));
        assert.equal(state.next, id(26)); assert.equal(state.mode, 'indexed');
        release(); await until(() => owner.resourceSnapshot.pending === 0);
        await until(() => fulfilled.length === 2);
        for (let n = 0; n < 8; n++) await Promise.resolve();
        // The old helper really resolved successfully after cancellation; publication is fenced by the hook.
        assert.deepEqual(fulfilled[1], { captures: [], next: null, mode: 'scan' });
        assert.deepEqual(rejected, []);
        assert.deepEqual(state.rows.map(value => value.header.id), captures.map(value => value.header.id));
        assert.equal(state.next, id(26)); assert.equal(state.mode, 'indexed'); assert.equal(state.status, 'ready');
        assert.equal(state.catalogFailure, null); assert.equal(state.selected, selected);
        assert.deepEqual([...state.selected], [id(1), id(2)]); assert.equal(state.cursor, undefined); assert.deepEqual(state.back, []);
    } finally { release(); oldCleanup?.(); currentCleanup?.(); await owner.close(); }
    assert.equal(disposed, true); assert.equal(busy, false);
});

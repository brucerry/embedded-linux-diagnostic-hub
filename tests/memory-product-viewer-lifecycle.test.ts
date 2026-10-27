/** Pure/model controls; EventEmitter observer models are not actual browser Worker evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Page, Worker } from '@playwright/test';
import {
    assertViewerRunUnchanged,
    assertViewerPrivateSourceNeedles,
    VIEWER_PRIVATE_NEEDLES,
    ProductViewerWorkers,
    type ViewerLiveCheckpoint,
} from './fixtures/memory-product-viewer-lifecycle';
import {
    createViewerFaultRealm,
    validViewerFaultTicket,
    VIEWER_CODEC_FAILURE,
} from './fixtures/memory-product-viewer-faults';

const firstId = '12345678-1234-4123-8123-123456789abc';
const secondId = '22345678-1234-4123-8123-123456789abc';
const make = () => createViewerFaultRealm('page', () => firstId);
function observerModel() {
    let closed = false;
    const page = Object.assign(new EventEmitter(), { workers: () => [], isClosed: () => closed });
    const observer = new ProductViewerWorkers(
        page as unknown as Page,
        (url) => url === 'model://export.worker',
    );
    return {
        page,
        observer,
        closePage() {
            closed = true;
        },
        add() {
            const worker = Object.assign(new EventEmitter(), {
                url: () => 'model://export.worker',
            });
            page.emit('worker', worker as unknown as Worker);
            return worker;
        },
    };
}
function live(): ViewerLiveCheckpoint {
    return {
        transport: 'serial',
        viewerIdentity: 'actual-inspection-id-distinct-from-run-id',
        runIdentity: 'actual-source-adapter-required',
        armGeneration: 7,
        captureId: firstId,
        busy: true,
        cleanupPending: false,
        captureState: 'active',
        commandDispatches: 1,
        transportWriteBytes: 32,
        receivedBytes: 64,
        committedBytes: 64,
        stall: { source: 'serial-prompt-withheld', id: 'pure-model-only', releasePending: true },
        acknowledgements: {
            status: 'supported',
            count: 3,
            orderedTraceSHA256: 'a'.repeat(64),
            pendingIds: ['exact-pending-A'],
        },
    };
}
test('live guard requires exact active run/capture/generation and ordered ACK identity', () => {
    assert.equal(
        assertViewerRunUnchanged(live(), structuredClone(live())).status,
        'checked-exact-trace',
    );
});
test('equal-sized replacement ACK traces or pending owners cannot mask a change', () => {
    const replacement = live();
    if (replacement.acknowledgements.status !== 'supported') throw Error('Model setup changed.');
    replacement.acknowledgements.pendingIds = ['exact-pending-B'];
    assert.throws(() => assertViewerRunUnchanged(live(), replacement), /ACK/);
    replacement.acknowledgements.pendingIds = ['exact-pending-A'];
    replacement.acknowledgements.orderedTraceSHA256 = 'b'.repeat(64);
    assert.throws(() => assertViewerRunUnchanged(live(), replacement), /ACK/);
});
test('run replacement, command/write/read/commit changes and premature idle fail', () => {
    for (const patch of [
        { viewerIdentity: 'substituted-inspection' },
        { runIdentity: 'other' },
        { captureId: secondId },
        { armGeneration: 8 },
        { commandDispatches: 2 },
        { transportWriteBytes: 33 },
        { receivedBytes: 65 },
        { committedBytes: 63 },
        { busy: false },
        { cleanupPending: true },
    ]) {
        assert.throws(() => assertViewerRunUnchanged(live(), { ...live(), ...patch }));
    }
    const invalid = live();
    invalid.receivedBytes = Number.NaN;
    assert.throws(() => assertViewerRunUnchanged(live(), invalid));
});
test('unknown ACK fields stay unsupported and cannot produce an exact-trace verdict', () => {
    const unknown = live();
    unknown.acknowledgements = {
        status: 'unsupported',
        reason: 'No actual protocol trace in this modeled adapter.',
    };
    assert.equal(assertViewerRunUnchanged(unknown, structuredClone(unknown)).status, 'unsupported');
    assert.equal(assertViewerRunUnchanged(live(), unknown).status, 'unsupported');
});
test('released/wrong target hold and missing identities cannot qualify live isolation', () => {
    const after = live();
    after.stall.releasePending = false;
    assert.throws(() => assertViewerRunUnchanged(live(), after));
    after.stall.releasePending = true;
    after.stall.id = 'different actual target';
    assert.throws(() => assertViewerRunUnchanged(live(), after));
    after.captureId = '';
    assert.throws(() => assertViewerRunUnchanged(live(), after));
});
test('private ticket schema rejects ambiguous fields/action/format and preserves exact identity', () => {
    const value = { version: 1, id: firstId, action: 'hold-request', format: 'png' };
    assert.deepEqual(validViewerFaultTicket(value), value);
    for (const patch of [
        { format: 'svg' },
        { id: '' },
        { version: 2 },
        { action: 'fake-success' },
        { hidden: true },
    ])
        assert.throws(() => validViewerFaultTicket({ ...value, ...patch }));
});
test('real Promise request gate remains pending until its exact ticket is released', async () => {
    const page = make(),
        ticket = page.arm('hold-request', 'png');
    const worker = createViewerFaultRealm('worker');
    let finished = false;
    const request = worker.enterRequest(page.requestTicket('png'), 'png').then(() => {
        finished = true;
    });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.deepEqual(worker.status().gates, [{ id: ticket.id, stage: 'request', released: false }]);
    assert.throws(() => worker.release(secondId));
    worker.release(ticket.id);
    await request;
    assert.equal(finished, true);
    assert.equal(worker.status().counters.settled, 1);
    assert.deepEqual(worker.status().gates, []);
});
test('clear cannot erase a pending gate and clearing settled configuration keeps history/counters', async () => {
    const page = make(),
        ticket = page.arm('hold-request', 'pdf'),
        worker = createViewerFaultRealm('worker');
    const request = worker.enterRequest(page.requestTicket('pdf'), 'pdf');
    assert.throws(() => worker.clear(), /pending/);
    worker.release(ticket.id);
    assert.throws(() => worker.release(ticket.id));
    await request;
    const before = worker.status();
    worker.clear();
    const after = worker.status();
    assert.equal(after.counters.requestEntered, before.counters.requestEntered);
    assert.equal(after.counters.settled, before.counters.settled);
    assert.ok(after.events.length > before.events.length);
    assert.equal(after.ticket, null);
});
test('held codec boundary throws only after explicit release and records a synthetic failure', async () => {
    const page = make(),
        ticket = page.arm('hold-codec-throw', 'png');
    const encoding = page.beforeCodec({ format: 'png', mime: 'image/png' });
    assert.equal(page.status().counters.codecEntered, 1);
    assert.equal(page.status().counters.failuresInjected, 0);
    const rejected = assert.rejects(
        encoding,
        new RegExp(VIEWER_CODEC_FAILURE.replaceAll('.', '\\.')),
    );
    page.release(ticket.id);
    await rejected;
    assert.equal(page.status().counters.failuresInjected, 1);
    await page.beforeCodec({ format: 'png', mime: 'image/png' });
    assert.equal(page.status().counters.failuresInjected, 1);
});
test('actual AbortSignal settles a foreground gate without fabricated codec success or forced release', async () => {
    const page = make();
    page.arm('hold-codec-throw', 'pdf');
    const controller = new AbortController();
    const encoding = page.beforeCodec({
        format: 'pdf',
        mime: 'image/jpeg',
        signal: controller.signal,
    });
    const rejected = assert.rejects(encoding, { name: 'AbortError' });
    controller.abort();
    await rejected;
    const status = page.status();
    assert.equal(status.counters.aborted, 1);
    assert.equal(status.counters.settled, 1);
    assert.equal(status.counters.released, 0);
    assert.equal(status.counters.failuresInjected, 0);
    assert.deepEqual(status.gates, []);
    page.clear();
});
test('worker/request realm, format and codec MIME mismatches fail before accepting the fault', async () => {
    const page = make(),
        ticket = page.arm('hold-codec-throw', 'png');
    await assert.rejects(page.enterRequest(ticket, 'png'), /actual worker/);
    await assert.rejects(createViewerFaultRealm('worker').enterRequest(ticket, 'pdf'), /identity/);
    await assert.rejects(page.beforeCodec({ format: 'png', mime: 'image/jpeg' }), /MIME/);
    assert.equal(page.status().counters.codecEntered, 0);
});
test('exact actual source needles refuse missing/duplicated integration and hooks contain no worker manipulation', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const sources = {
        viewer: fs.readFileSync(
            path.join(root, 'src/features/automation/flow/FlowViewer.tsx'),
            'utf8',
        ),
        worker: fs.readFileSync(
            path.join(root, 'src/features/automation/flow/export.worker.ts'),
            'utf8',
        ),
        raster: fs.readFileSync(path.join(root, 'src/features/automation/flow/raster.ts'), 'utf8'),
    };
    assert.equal(assertViewerPrivateSourceNeedles(sources).length, 3);
    assert.throws(() =>
        assertViewerPrivateSourceNeedles({
            ...sources,
            worker: sources.worker.replace(VIEWER_PRIVATE_NEEDLES.worker, ''),
        }),
    );
    assert.throws(() =>
        assertViewerPrivateSourceNeedles({
            ...sources,
            viewer: sources.viewer + VIEWER_PRIVATE_NEEDLES.viewer,
        }),
    );
    const helper = fs.readFileSync(
        path.join(root, 'tests/fixtures/memory-product-viewer-lifecycle.ts'),
        'utf8',
    );
    const fault = fs.readFileSync(
        path.join(root, 'tests/fixtures/memory-product-viewer-faults.ts'),
        'utf8',
    );
    assert.doesNotMatch(helper, /\.\s*(?:terminate|abort|clearTimeout)\s*\(/);
    assert.doesNotMatch(fault, /\.\s*(?:postMessage|terminate|clearTimeout)\s*\(/);
});
test('modeled observer retires only joined exact witnesses after tokens release; old tokens cannot hide new identities', async () => {
    const model = observerModel(),
        token = model.observer.baseline(),
        event = model.add();
    const witness = model.observer.since(token)[0];
    event.emit('close');
    await witness.closed;
    assert.throws(() => model.observer.retireClosed([witness]), /active comparison/);
    model.observer.releaseBaseline(token);
    model.observer.retireClosed([witness]);
    assert.throws(() => model.observer.since(token), /released/);
    assert.equal(model.observer.snapshotObserver().records.length, 0);
    assert.equal(model.observer.snapshotObserver().retiredActualClosed, 1);
    const next = model.observer.baseline(),
        second = model.add(),
        replacement = model.observer.since(next)[0];
    assert.notEqual(replacement.id, witness.id);
    assert.throws(() => model.observer.assertClosed([replacement]), /close event/);
    second.emit('close');
    await replacement.closed;
    model.observer.releaseBaseline(next);
    model.observer.retireClosed([replacement]);
    assert.equal(model.observer.snapshotObserver().observed, 2);
    assert.equal(model.observer.snapshotObserver().retiredActualClosed, 2);
    model.closePage();
    model.observer.dispose();
    assert.equal(model.page.listenerCount('worker'), 0);
});
test('modeled observer rejects foreign/open witnesses and removes only its own listeners after model page teardown', async () => {
    const model = observerModel(),
        token = model.observer.baseline(),
        event = model.add();
    const witness = model.observer.since(token)[0];
    model.observer.releaseBaseline(token);
    assert.throws(() => model.observer.assertClosed([{ ...witness }]), /substituted/);
    assert.throws(() => model.observer.retireClosed([witness]), /close event/);
    assert.throws(() => model.observer.dispose(), /page\/world/);
    event.emit('close');
    await witness.closed;
    assert.throws(() => model.observer.dispose(), /page\/world/);
    model.closePage();
    model.observer.dispose();
    assert.equal(model.page.listenerCount('worker'), 0);
    assert.equal(event.listenerCount('close'), 0);
    assert.equal(model.observer.snapshotObserver().observed, 1);
});

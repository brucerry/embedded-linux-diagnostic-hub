import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleExportDiagnostic } from '../src/features/automation/capture/console-export-diagnostic';
import { ConsoleResultsOwner } from '../src/features/automation/capture/console-results-owner';
import type { ConsoleArchive } from '../shared/console-storage';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}
function observe<T>(promise: Promise<T>) {
    const state: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
    void promise.then(
        (value) => {
            state.outcome = { ok: true, value };
        },
        (error) => {
            state.outcome = { ok: false, error };
        },
    );
    return state;
}
async function until(check: () => boolean) {
    for (let turn = 0; turn < 256; turn++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('Bounded diagnostic ownership gate did not settle');
}
const empty: ConsoleArchive = {
    async pin() {
        assert.fail('No archive pin');
    },
    async list() {
        assert.fail('No catalog read');
    },
    async *read() {
        assert.fail('No reader');
    },
    async delete() {
        assert.fail('No deletion');
    },
};

test('console export diagnostic survives view retirement and a reopening owner waiting for acknowledgement', async () => {
    const latch = new ConsoleExportDiagnostic(),
        acknowledgement = gate(),
        primary = new Error('original export failure');
    let firstDisposed = 0,
        reopened = 0,
        secondDisposed = 0,
        admitted = false;
    const first = new ConsoleResultsOwner(
        async () => ({
            archive: empty,
            dispose: async () => {
                firstDisposed++;
            },
        }),
        () => {},
    );
    const generation = latch.begin(first);
    assert.ok(generation);
    const completed = acknowledgement.promise.then(() => {
        throw primary;
    });
    const exported = observe(
        first
            .export(async () => {
                admitted = true;
                return { completed, cancel: () => acknowledgement.promise };
            })
            .finally(() => {
                latch.finish(first, generation);
            }),
    );
    let second: ConsoleResultsOwner | undefined;
    try {
        await until(() => admitted);
        assert.equal(
            latch.update(first, generation, {
                retirement: 'blocked',
                message: 'Cleanup acknowledgement is missing.',
            }),
            true,
        );
        const closing = first.close(),
            closed = observe(closing);
        second = new ConsoleResultsOwner(
            async () => {
                await closing;
                reopened++;
                return {
                    archive: empty,
                    dispose: async () => {
                        secondDisposed++;
                    },
                };
            },
            () => {},
        );
        const secondReady = observe(second.ready);
        for (let turn = 0; turn < 16; turn++) await Promise.resolve();
        assert.equal(Boolean(closed.outcome), false);
        assert.equal(Boolean(secondReady.outcome), false);
        assert.equal(firstDisposed, 0);
        assert.equal(reopened, 0);
        assert.equal(latch.snapshot?.retirement, 'blocked');
        assert.equal(
            latch.begin(second),
            null,
            'Reopening cannot replace pending export diagnostic ownership',
        );
        assert.equal(
            latch.update(first, generation, {
                retirement: 'blocked',
                message: 'Late cleanup failure from the same admitted export.',
            }),
            true,
        );
        assert.equal(
            latch.snapshot?.message,
            'Late cleanup failure from the same admitted export.',
        );
        assert.equal(latch.finish(second, generation), false);
        assert.equal(latch.snapshot?.retirement, 'blocked');
        acknowledgement.release();
        await until(
            () =>
                closed.outcome !== undefined &&
                secondReady.outcome !== undefined &&
                exported.outcome !== undefined,
        );
        assert.equal(closed.outcome!.ok, true);
        assert.equal(secondReady.outcome!.ok, true);
        assert.equal(exported.outcome!.ok, false);
        if (!exported.outcome!.ok) assert.equal(exported.outcome!.error, primary);
        assert.equal(firstDisposed, 1);
        assert.equal(reopened, 1);
        assert.equal(Boolean(latch.snapshot), false);
        const next = latch.begin(second);
        assert.ok(next);
        assert.notEqual(next, generation);
        assert.equal(
            latch.update(first, generation, {
                retirement: 'blocked',
                message: 'Stale old export.',
            }),
            false,
        );
        assert.equal(Boolean(latch.snapshot), false);
        assert.equal(
            latch.update(second, next, {
                retirement: 'pending',
                message: 'New export owns its own diagnostic.',
            }),
            true,
        );
        assert.equal(latch.finish(first, generation), false);
        assert.equal(latch.snapshot?.message, 'New export owns its own diagnostic.');
        assert.equal(latch.finish(second, next), true);
        await second.close();
        assert.equal(secondDisposed, 1);
    } finally {
        acknowledgement.release();
        const closing = observe(first.close());
        await until(() => closing.outcome !== undefined && exported.outcome !== undefined);
        if (second) {
            const closingSecond = observe(second.close());
            await until(() => closingSecond.outcome !== undefined);
        }
    }
});

test('console export diagnostic is bounded and rejects foreign owners and stale generations', () => {
    const latch = new ConsoleExportDiagnostic(),
        owner = {},
        foreign = {},
        generation = latch.begin(owner);
    assert.ok(generation);
    const input = { retirement: 'blocked' as const, message: 'warning\n' + 'x'.repeat(600) };
    assert.equal(latch.update(foreign, generation, input), false);
    assert.equal(latch.update(owner, Symbol('stale'), input), false);
    assert.equal(latch.update(owner, generation, input), true);
    const snapshot = latch.snapshot;
    assert.ok(snapshot);
    assert.equal(snapshot.message.length, 512);
    assert.equal(snapshot.message.includes('\n'), false);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(input.message.length, 608);
    assert.equal(latch.finish(foreign, generation), false);
    assert.equal(latch.snapshot, snapshot);
    assert.equal(latch.finish(owner, generation), true);
    assert.equal(Boolean(latch.snapshot), false);
    assert.equal(latch.update(owner, generation, input), false);
});

import assert from 'node:assert/strict';
import type { CDPSession, Page } from '@playwright/test';
import {
    AggregateCallTracker,
    type AggregateDiagnosticClock,
} from './memory-product-aggregate-diagnostics';
import {
    requireProductParentClosure,
    type ProductParentClosure,
} from './memory-product-parent-closure';

/** Actual Runtime destruction within one binding, distinct from inspector detach/rebind. */
export function requireInspectionRealmDestruction(
    before: ReturnType<ProductInspectionRealm['snapshot']>,
    after: ReturnType<ProductInspectionRealm['snapshot']>,
) {
    assert.equal(before.state, 'bound');
    assert.equal(after.state, 'bound');
    assert.equal(before.hasProtocol && after.hasProtocol, true);
    assert.equal(after.generation, before.generation);
    assert.ok(before.defaults.length > 0);
    assert.deepEqual(after.errors, []);
    assert.ok(
        after.history
            .slice(before.history.length)
            .some(
                (row) =>
                    row.generation === before.generation &&
                    ((row.kind === 'cleared' &&
                        row.ids?.some((id) => before.defaults.includes(id))) ||
                        (row.kind === 'destroyed' && before.defaults.includes(row.id!))),
            ),
        'Actual old execution-context destruction not observed.',
    );
}

/** Session-scoped Runtime evidence; releasing an inspector never destroys a realm. */
export class ProductInspectionRealm {
    private state: 'released' | 'binding' | 'bound' | 'releasing' | 'failed' | 'disposed' =
        'released';
    private generation = 0;
    private page?: Page;
    private protocol?: CDPSession;
    private protocolClosed = false;
    private defaults = new Set<number>();
    private history: { generation: number; kind: string; id?: number; ids?: number[] }[] = [];
    private errors: string[] = [];
    private calls: AggregateCallTracker;
    constructor(
        private emit: (stage: string, value: unknown) => Promise<void>,
        clock?: AggregateDiagnosticClock,
    ) {
        this.calls = new AggregateCallTracker(emit, 'inspection-realm-call', clock);
    }
    private record(kind: string, data: { id?: number; ids?: number[] } = {}) {
        if (this.history.length >= 4096) {
            if (this.errors.length < 16) this.errors.push('Realm history bound exceeded.');
            return;
        }
        this.history.push({ generation: this.generation, kind, ...data });
    }
    private created = ({
        context,
    }: {
        context: { id: number; auxData?: { isDefault?: boolean } };
    }) => {
        if (context.auxData?.isDefault) {
            this.defaults.add(context.id);
            this.record('created', { id: context.id });
        }
    };
    private destroyed = ({ executionContextId }: { executionContextId: number }) => {
        this.defaults.delete(executionContextId);
        this.record('destroyed', { id: executionContextId });
    };
    private cleared = () => {
        this.record('cleared', { ids: [...this.defaults] });
        this.defaults.clear();
    };
    private closed = () => {
        this.protocolClosed = true;
    };
    private removeListeners() {
        this.protocol?.off('Runtime.executionContextCreated', this.created);
        this.protocol?.off('Runtime.executionContextDestroyed', this.destroyed);
        this.protocol?.off('Runtime.executionContextsCleared', this.cleared);
        this.protocol?.off('close', this.closed);
    }
    async bind(page: Page, generation: number) {
        assert.equal(this.state, 'released');
        assert.equal(generation, this.generation + 1);
        this.calls.assertJoined();
        this.state = 'binding';
        this.page = page;
        this.generation = generation;
        try {
            await this.calls.run('open-session', async () => {
                // Retain a late returned session inside its actual call, even after a deadline.
                this.protocol = await page.context().newCDPSession(page);
                this.protocolClosed = false;
                this.protocol.once('close', this.closed);
            });
            assert.equal(this.state, 'binding');
            assert.ok(this.protocol, 'Actual Runtime session was not retained.');
            this.protocol.on('Runtime.executionContextCreated', this.created);
            this.protocol.on('Runtime.executionContextDestroyed', this.destroyed);
            this.protocol.on('Runtime.executionContextsCleared', this.cleared);
            await this.calls.run('enable-runtime', () => this.protocol!.send('Runtime.enable'));
            assert.ok(this.defaults.size > 0, 'No actual default Runtime context was observed.');
            assert.equal(this.protocolClosed, false);
            await this.calls.run('acknowledge-binding', () =>
                this.emit('inspection-realm-bound', this.snapshot()),
            );
            assert.equal(this.state, 'binding');
            assert.equal(this.protocolClosed, false);
            this.state = 'bound';
        } catch (error) {
            this.state = 'failed';
            throw error;
        }
    }
    async release() {
        assert.equal(this.state, 'bound');
        this.calls.assertJoined();
        assert.deepEqual(this.errors, []);
        this.state = 'releasing';
        try {
            await this.calls.run('detach-session', () => this.protocol!.detach());
            this.removeListeners();
            this.record('inspector-detached', { ids: [...this.defaults] });
            this.defaults.clear();
            this.protocol = undefined;
            await this.calls.run('acknowledge-release', () =>
                this.emit('inspection-realm-released', this.snapshot()),
            );
            assert.equal(this.state, 'releasing');
            this.state = 'released';
        } catch (error) {
            this.state = 'failed';
            throw error;
        }
    }
    assertReleased() {
        this.calls.assertJoined();
        assert.equal(this.state, 'released');
        assert.equal(this.protocol, undefined);
    }
    assertBound(page: Page, generation: number) {
        this.calls.assertJoined();
        assert.equal(this.state, 'bound');
        assert.equal(this.page, page);
        assert.equal(this.generation, generation);
        assert.equal(this.protocolClosed, false);
        assert.deepEqual(this.errors, []);
    }
    cleanupPage() {
        return this.page;
    }
    assertJoined() {
        this.calls.assertJoined();
    }
    disposeAfterParentClosure(proof: ProductParentClosure) {
        this.calls.assertJoined();
        assert.ok(
            !['binding', 'releasing'].includes(this.state),
            'Realm transition still owns work.',
        );
        assert.ok(this.page);
        requireProductParentClosure(proof, this.page);
        this.removeListeners();
        this.protocol = undefined;
        this.defaults.clear();
        this.state = 'disposed';
    }
    snapshot() {
        return {
            state: this.state,
            generation: this.generation,
            hasProtocol: Boolean(this.protocol),
            defaults: [...this.defaults],
            history: this.history.map((row) => ({
                ...row,
                ...(row.ids ? { ids: [...row.ids] } : {}),
            })),
            errors: [...this.errors],
            pending: this.calls.pending(),
        };
    }
}

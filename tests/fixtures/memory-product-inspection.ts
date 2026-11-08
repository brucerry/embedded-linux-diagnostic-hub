/** Private qualification ownership only; never imported by the product. */
import assert from 'node:assert/strict';
import {
    AggregateCallTracker,
    type AggregateDiagnosticClock,
} from './memory-product-aggregate-diagnostics';

export const inspectionObserverNames = [
    'host-events',
    'host-downloads',
    'aggregate-realm',
    'aggregate-viewer',
    'aggregate-export',
] as const;
export type InspectionObserverName = (typeof inspectionObserverNames)[number];
export interface InspectionObserver<Page> {
    release(): Promise<void>;
    assertReleased(): void;
    bind(page: Page, generation: number): Promise<void>;
    assertBound(page: Page, generation: number): void;
}
export interface InspectionNativeStop {
    releaseAt: number;
    deadline: number;
    cutoffOrdinal: number;
    nativeStop: {
        eventOrdinal: number;
        observedAt: number;
        version: {
            versionId: string;
            registrationId: string;
            scriptURL: string;
            status: string;
            runningStatus: string;
            controlledClients: string[];
            targetId?: string;
        };
    };
    nativeStopLatencyMilliseconds: number;
    releaseJoinMilliseconds: number;
}
export interface InspectionRebind<Page> {
    readonly page: Page;
    readonly nativePageId: string;
    readonly nativeContextId: string;
    readonly browserProduct: string;
    readonly root: { readonly pid: number; readonly created: string };
}
type Emit = (stage: string, data: unknown) => Promise<void>;

/** The owner supplies actual connection operations; no caller-supplied subset can pass. */
export class ProductInspection<Page> {
    private phase:
        'ready' | 'releasing' | 'reconnecting' | 'binding' | 'failed' | 'closing' | 'closed' =
        'ready';
    private generation = 1;
    private validating = false;
    private readonly identity: Omit<InspectionRebind<Page>, 'page'>;
    private failure?: unknown;
    private transition?: Promise<InspectionNativeStop>;
    private readonly observers = new Map<
        InspectionObserverName,
        {
            hooks: InspectionObserver<Page>;
            state: 'bound' | 'releasing' | 'released' | 'binding';
            generation: number;
        }
    >();
    private readonly operations: AggregateCallTracker;
    private readonly transitions: AggregateCallTracker;
    constructor(
        private readonly ports: {
            currentPage(): Page;
            identity: Omit<InspectionRebind<Page>, 'page'>;
            disconnect(): Promise<void>;
            reconnect(): Promise<InspectionRebind<Page>>;
            verifyCurrentIdentity(binding: InspectionRebind<Page>): Promise<void>;
            commitBinding(
                binding: InspectionRebind<Page>,
                stopped: InspectionNativeStop,
            ): Promise<void>;
            emit: Emit;
        },
        clock?: AggregateDiagnosticClock,
    ) {
        this.identity = { ...ports.identity, root: { ...ports.identity.root } };
        this.operations = new AggregateCallTracker(ports.emit, 'inspection-admitted-call', clock);
        this.transitions = new AggregateCallTracker(
            ports.emit,
            'inspection-transition-call',
            clock,
        );
    }
    assertReady() {
        assert.equal(this.phase, 'ready', 'Inspection admission is not ready: ' + this.phase);
        assert.equal(this.failure, undefined);
        assert.equal(this.validating, false, 'Inspection binding validation owns admission.');
        assert.equal(this.transition, undefined, 'Inspection transition already owns work.');
    }
    async use<T>(name: string, work: () => Promise<T>): Promise<T> {
        this.assertReady();
        this.validateBindings(() => this.requireObservers());
        this.assertReady();
        return this.operations.run(name, work);
    }
    register(name: InspectionObserverName, hooks: InspectionObserver<Page>) {
        this.assertReady();
        assert.ok(inspectionObserverNames.includes(name), 'Unknown inspection observer.');
        assert.ok(!this.observers.has(name), 'Duplicate inspection observer: ' + name);
        this.validateBindings(() => hooks.assertBound(this.ports.currentPage(), this.generation));
        this.assertReady();
        assert.ok(!this.observers.has(name), 'Duplicate inspection observer: ' + name);
        this.observers.set(name, { hooks, state: 'bound', generation: this.generation });
    }
    private validateBindings(work: () => void) {
        this.validating = true;
        try {
            work();
        } finally {
            this.validating = false;
        }
    }
    private assertPhase(phase: 'releasing' | 'reconnecting' | 'binding') {
        assert.equal(this.phase, phase, 'Inspection transition admission changed: ' + this.phase);
    }
    private async call<T>(
        phase: 'releasing' | 'reconnecting' | 'binding',
        name: string,
        work: () => Promise<T>,
    ): Promise<T> {
        this.assertPhase(phase);
        const value = await this.transitions.run(name, async () => {
            // Evidence callbacks can close admission before the actual operation starts.
            this.assertPhase(phase);
            return work();
        });
        this.assertPhase(phase);
        return value;
    }
    private requireObservers() {
        assert.deepEqual(
            [...this.observers.keys()].sort(),
            [...inspectionObserverNames].sort(),
            'Every actual inspection observer group must be registered.',
        );
        for (const [name, value] of this.observers) {
            assert.equal(value.state, 'bound', 'Observer is not bound: ' + name);
            assert.equal(value.generation, this.generation);
            value.hooks.assertBound(this.ports.currentPage(), this.generation);
        }
    }
    retire(input: {
        observeRelease(
            disconnect: () => Promise<void>,
            joinWorkerClose: () => Promise<void>,
        ): Promise<InspectionNativeStop>;
        joinWorkerClose(): Promise<void>;
        acknowledgeNativeStop(stopped: InspectionNativeStop): Promise<void>;
    }): Promise<InspectionNativeStop> {
        this.assertReady();
        assert.equal(this.transition, undefined, 'Inspection transition already owns work.');
        this.operations.assertJoined();
        this.transitions.assertJoined();
        // Close admission and publish the shared owner before any callback/evidence can reenter.
        this.phase = 'releasing';
        const task = Promise.resolve()
            .then(async () => {
                const generation = this.generation + 1;
                this.assertPhase('releasing');
                this.requireObservers();
                await this.call('releasing', 'acknowledge-release-start', () =>
                    this.ports.emit('inspection-release-start', this.snapshot()),
                );
                for (const [name, value] of this.observers) {
                    value.state = 'releasing';
                    await this.call('releasing', 'release/' + name, () => value.hooks.release());
                    value.hooks.assertReleased();
                    this.assertPhase('releasing');
                    value.state = 'released';
                }
                this.operations.assertJoined();
                const stopped = await this.call('releasing', 'observe-native-release', () =>
                    input.observeRelease(
                        () =>
                            this.call('releasing', 'disconnect-owned-automation', () =>
                                this.ports.disconnect(),
                            ),
                        () =>
                            this.call('releasing', 'join-worker-close', () =>
                                input.joinWorkerClose(),
                            ),
                    ),
                );
                await this.call('releasing', 'acknowledge-native-stop', () =>
                    input.acknowledgeNativeStop(stopped),
                );
                this.assertPhase('releasing');
                this.phase = 'reconnecting';
                const returned = await this.call('reconnecting', 'reconnect-owned-automation', () =>
                    this.ports.reconnect(),
                );
                // Own the descriptors without freezing the actual SDK Page wrapper.
                const binding = Object.freeze({
                    ...returned,
                    root: Object.freeze({ ...returned.root }),
                });
                const { page, ...identityFields } = binding;
                const identity = Object.freeze(identityFields);
                const assertStableBinding = () => {
                    const { page: retainedPage, ...retainedIdentity } = returned;
                    assert.equal(retainedPage, page, 'Retained reconnect page changed.');
                    assert.deepEqual(
                        retainedIdentity,
                        identity,
                        'Retained reconnect native identity changed.',
                    );
                };
                assert.deepEqual(
                    identity,
                    this.identity,
                    'Reconnected native browser/page/root identity changed.',
                );
                assert.ok(page !== undefined && page !== null, 'Reconnected page is missing.');
                await this.call('reconnecting', 'verify-reconnected-identity-before-bind', () =>
                    this.ports.verifyCurrentIdentity(binding),
                );
                assertStableBinding();
                this.assertPhase('reconnecting');
                this.phase = 'binding';
                for (const [name, value] of this.observers) {
                    assertStableBinding();
                    this.assertPhase('binding');
                    value.state = 'binding';
                    await this.call('binding', 'bind/' + name, () =>
                        value.hooks.bind(page, generation),
                    );
                    assertStableBinding();
                    value.hooks.assertBound(page, generation);
                    this.assertPhase('binding');
                    value.generation = generation;
                    value.state = 'bound';
                }
                await this.call('binding', 'verify-reconnected-identity', () =>
                    this.ports.verifyCurrentIdentity(binding),
                );
                assertStableBinding();
                await this.call('binding', 'commit-observer-binding', () =>
                    this.ports.commitBinding(binding, stopped),
                );
                assertStableBinding();
                this.operations.assertJoined();
                this.transitions.assertJoined();
                await this.call('binding', 'acknowledge-ready-generation', () =>
                    this.ports.emit('inspection-ready-generation', {
                        generation,
                        identity,
                        observers: inspectionObserverNames,
                        nativeStop: stopped,
                    }),
                );
                assertStableBinding();
                this.assertPhase('binding');
                this.generation = generation;
                this.phase = 'ready';
                return stopped;
            })
            .catch((error) => {
                this.failure = error;
                if (this.phase !== 'closing' && this.phase !== 'closed') this.phase = 'failed';
                throw error;
            });
        this.transition = task;
        void task
            .finally(() => {
                if (this.transition === task) this.transition = undefined;
            })
            .catch(() => {});
        return task;
    }
    closeAdmission() {
        if (this.phase !== 'closed') this.phase = 'closing';
    }
    assertJoined() {
        this.operations.assertJoined();
        this.transitions.assertJoined();
        assert.equal(this.transition, undefined, 'Inspection transition has not actually settled.');
    }
    acknowledgeClosed() {
        this.assertJoined();
        this.phase = 'closed';
    }
    snapshot() {
        return {
            phase: this.phase,
            generation: this.generation,
            failure: this.failure ? String(this.failure) : null,
            admittedCalls: this.operations.pending(),
            transitionCalls: this.transitions.pending(),
            transitionPending: Boolean(this.transition),
            observers: [...this.observers].map(([name, value]) => ({
                name,
                state: value.state,
                generation: value.generation,
            })),
        };
    }
}

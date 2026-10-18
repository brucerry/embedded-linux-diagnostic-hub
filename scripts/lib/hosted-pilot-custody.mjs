import assert from 'node:assert/strict';
import {
    bindingDigest,
    validatePilotBinding,
    pilotLimits,
    requirePilotRuntimeReady,
} from './hosted-pilot-contract.mjs';
import { createOwnershipHold } from './product-entry-custody.mjs';
/** In-memory same-owner continuation protocol. This module neither launches workloads nor weakens ordinary collector admission. */
export class SameJobPilotCustody {
    constructor(
        binding,
        {
            lease,
            verify,
            record,
            closeEvidence,
            events,
            clock,
            hold = createOwnershipHold,
            executionGate = requirePilotRuntimeReady,
        },
    ) {
        validatePilotBinding(binding, clock.now());
        const freeze = (value) => {
            if (value && typeof value === 'object') {
                Object.values(value).forEach(freeze);
                Object.freeze(value);
            }
            return value;
        };
        Object.defineProperty(this, 'binding', {
            value: freeze(JSON.parse(JSON.stringify(binding))),
            writable: false,
        });
        this.hash = bindingDigest(this.binding);
        this.ports = { lease, verify, record, closeEvidence, events, clock, hold, executionGate };
        this.state = 'new';
        this.cancelled = null;
        this.pending = 0;
        this.active = null;
        this.token = null;
        this.stages = [];
        this.handlers = ['SIGTERM', 'SIGINT', 'disconnect'].map((name) => [
            name,
            () => this.cancel(name),
        ]);
        this.handlers.push([
            'message',
            (value) =>
                this.cancel(
                    value?.kind === 'cancel-hosted-pilot' &&
                        value.nonce === binding.nonce &&
                        value.bindingSHA256 === this.hash
                        ? 'Bound pilot cancellation.'
                        : 'Invalid pilot cancellation identity.',
                ),
        ]);
        for (const [name, fn] of this.handlers) events.on(name, fn);
        this.timer = clock.set(
            () => this.cancel('Immutable pilot work deadline.'),
            binding.deadline - pilotLimits.reserveMs - clock.now(),
        );
        this.cleanupTimer = clock.set(
            () => this.hold('Immutable pilot cleanup deadline; ownership not closed.'),
            binding.deadline - clock.now(),
        );
    }
    snapshot() {
        return {
            state: this.state,
            cancelled: this.cancelled,
            bindingSHA256: this.hash,
            pending: this.pending,
            active: Boolean(this.active),
            stages: this.stages.length,
            lease: this.ports.lease.state(),
        };
    }
    check(current = this.binding, cleanup = false) {
        if (!cleanup) assert.equal(this.cancelled, null);
        assert.notEqual(this.state, 'held', 'Unknown ownership cannot release.');
        assert.notEqual(this.state, 'released');
        assert.deepEqual(
            current,
            this.binding,
            'Exact same-job/source/runtime/nonce/root/deadline binding changed.',
        );
        validatePilotBinding(current, this.ports.clock.now(), cleanup);
        this.ports.lease.check();
    }
    hold(reason) {
        this.cancelled ??= String(reason).slice(0, 1024);
        this.state = 'held';
        this.token = null;
        // Referenced hold is established by the real helper before a hold-receipt write can fail.
        this.holdOwner ??= this.ports.hold(this.snapshot(), this.ports.record);
        this.forwardCancel();
        return this.holdOwner;
    }
    forwardCancel() {
        if (this.active && !this.active.stopRequested) {
            this.active.stopRequested = true;
            try {
                assert.equal(this.active.child?.connected, true);
                this.active.child.send(
                    {
                        kind: 'cancel-hosted-pilot-stage',
                        nonce: this.binding.nonce,
                        bindingSHA256: this.hash,
                        reason: this.cancelled,
                    },
                    (error) => {
                        if (error) this.forwardError = String(error).slice(0, 1024);
                    },
                );
            } catch (error) {
                this.forwardError = String(error).slice(0, 1024);
            }
        }
    }
    cancel(reason) {
        this.cancelled ??= String(reason).slice(0, 1024);
        this.token = null;
        this.forwardCancel();
    }
    async acquireAndVerify(current = this.binding) {
        assert.equal(this.state, 'new');
        assert.equal(this.cancelled, null);
        this.state = 'verifying';
        try {
            this.ports.lease.acquire();
            this.ports.record('pilot-owned.json', {
                binding: this.binding,
                bindingSHA256: this.hash,
            });
            this.pending++;
            try {
                const observed = await this.ports.verify(this.binding);
                this.check(observed, true);
                this.verificationClosed = true;
                assert.equal(this.cancelled, null);
                assert.deepEqual(current, this.binding);
            } finally {
                this.pending--;
            }
            this.token = Object.freeze({});
            this.state = 'approved';
            return this.token;
        } catch (e) {
            if (this.ports.lease.state().created && !this.verificationClosed) this.hold(e);
            else {
                this.cancel(e);
                this.state = 'approved';
            }
            throw e;
        }
    }
    start(stage, token, current, spawn) {
        let active;
        try {
            this.ports.executionGate();
            this.check(current);
            assert.equal(token, this.token, 'No serialized/replayed approval capability.');
            assert.equal(this.state, 'approved');
            assert.equal(this.active, null);
            assert(['real-os-pty', 'native-electron-store'].includes(stage));
            assert(!this.stages.includes(stage), 'No retry/repeated stage.');
            assert.equal(
                stage,
                ['real-os-pty', 'native-electron-store'][this.stages.length],
                'Pilot stage order changed.',
            );
            active = {
                stage,
                child: null,
                spawn: false,
                exit: false,
                close: false,
                code: null,
                signal: null,
                uncertain: true,
            };
            this.active = active;
            // Register uncertainty before invoking a synchronous spawn; no await separates final check and spawn.
            this.check(current);
            active.child = spawn();
            assert(active.child && typeof active.child.once === 'function');
            this.state = 'running';
            this.stages.push(stage);
            active.child.once('spawn', () => (active.spawn = true));
            active.child.once('exit', (code, signal) =>
                Object.assign(active, { exit: true, code, signal }),
            );
            active.child.once('close', (code, signal) => {
                active.close = true;
                active.closeCode = code;
                active.closeSignal = signal;
            });
            active.child.once('error', (e) => this.hold(e));
            active.uncertain = false;
            return active.child;
        } catch (e) {
            this.hold(e);
            throw e;
        }
    }
    async joinStage(joinDescendantsAndEvidence) {
        const active = this.active;
        assert(active);
        try {
            assert(
                active.spawn && active.exit && active.close && !active.uncertain,
                'Actual spawn/exit/pipe-close incomplete.',
            );
            assert.equal(active.code, active.closeCode);
            assert.equal(active.signal, active.closeSignal);
            if (active.signal !== null || active.code !== 0)
                this.cancel('Pilot stage failed: ' + active.code + '/' + active.signal);
            this.pending++;
            let proof;
            try {
                proof = await joinDescendantsAndEvidence(active.child, this.binding);
            } finally {
                this.pending--;
            }
            assert(
                proof.descendantsClosed === true &&
                    proof.leafReceiptsClosed === true &&
                    proof.logsClosed === true,
                'Actual leaf/descendant/evidence closure required.',
            );
            this.check(this.binding, true);
            this.ports.record('pilot-' + active.stage + '-closed.json', {
                bindingSHA256: this.hash,
                proof,
            });
            this.active = null;
            this.state = 'approved';
        } catch (e) {
            this.hold(e);
            throw e;
        }
    }
    async release({ inputsUnchanged, rootsCleanupClosed, resultClosed }) {
        try {
            this.check(this.binding, true);
            assert.equal(this.state, 'approved');
            assert.equal(this.pending, 0);
            assert.equal(this.active, null);
            if (!this.cancelled)
                assert.deepEqual(this.stages, ['real-os-pty', 'native-electron-store']);
            assert(this.verificationClosed, 'Same-job verification never settled.');
            assert(
                inputsUnchanged === true && rootsCleanupClosed === true && resultClosed === true,
            );
            const closure = await this.ports.closeEvidence();
            assert.equal(closure.complete, true);
            this.check(this.binding, true);
            this.ports.lease.release({
                admissionCertain: true,
                directParentsClosed: true,
                evidenceClosed: true,
                inputsUnchanged: true,
                leafReceiptsClosed: true,
                resultClosed: true,
            });
            this.state = 'released';
            this.verdict = this.cancelled ? 'failed' : 'passed';
            this.token = null;
            this.ports.clock.clear(this.timer);
            this.ports.clock.clear(this.cleanupTimer);
            for (const [name, fn] of this.handlers) this.ports.events.off(name, fn);
        } catch (e) {
            this.hold(e);
            throw e;
        }
    }
}

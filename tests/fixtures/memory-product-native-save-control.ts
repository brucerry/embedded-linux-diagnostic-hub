import assert from 'node:assert/strict';
import type { CaptureReportFormat } from '../../shared/capture-report';

interface SavePort {
    destination(format: CaptureReportFormat): Promise<string | null>;
    exports: Set<Promise<boolean>>;
}
/** Private build only. It controls Save selection; the actual trusted host owns pins and streaming. */
export class NativeSaveControl {
    private active?: {
        file: string;
        original: SavePort['destination'];
        invoked: boolean;
        held: boolean;
        decision: 'save' | 'cancel' | null;
        format: string | null;
        resolve?(file: string | null): void;
    };
    constructor(
        private readonly host: SavePort,
        private readonly validate: (file: string) => void,
    ) {}
    arm(file: string, held: boolean) {
        assert.equal(this.active, undefined, 'Native Save control already owned.');
        assert.equal(this.host.exports.size, 0, 'An actual export is still owned.');
        this.validate(file);
        const state = {
            file,
            original: this.host.destination,
            invoked: false,
            held,
            decision: null as 'save' | 'cancel' | null,
            format: null as string | null,
            resolve: undefined as ((file: string | null) => void) | undefined,
        };
        this.active = state;
        this.host.destination = async (format) => {
            assert.equal(this.active, state);
            assert.equal(state.invoked, false, 'Duplicate native Save selection.');
            state.invoked = true;
            state.format = format;
            if (!held) {
                state.decision = 'save';
                return file;
            }
            return new Promise<string | null>((resolve) => {
                state.resolve = resolve;
            });
        };
    }
    status() {
        const state = this.active;
        return state
            ? {
                  file: state.file,
                  invoked: state.invoked,
                  held: state.held,
                  pending: Boolean(state.resolve),
                  decision: state.decision,
                  format: state.format,
              }
            : null;
    }
    release(decision: 'save' | 'cancel') {
        const state = this.active;
        assert.ok(
            state?.invoked && state.resolve,
            'Native Save destination is not actually pending.',
        );
        assert.equal(state.decision, null);
        state.decision = decision;
        const resolve = state.resolve;
        state.resolve = undefined;
        resolve(decision === 'save' ? state.file : null);
    }
    cancelForShutdown() {
        if (this.active?.resolve) this.release('cancel');
    }
    restoreAfterJoin() {
        assert.equal(this.host.exports.size, 0);
        assert.ok(!this.active?.resolve, 'Save decision is still pending.');
        if (this.active) this.host.destination = this.active.original;
        this.active = undefined;
    }
    finish() {
        const state = this.active;
        assert.ok(
            state?.invoked && state.decision && !state.resolve,
            'Native Save decision has not settled.',
        );
        assert.equal(this.host.exports.size, 0, 'Actual native report export is still owned.');
        this.host.destination = state.original;
        const receipt = this.status();
        this.active = undefined;
        return receipt;
    }
}

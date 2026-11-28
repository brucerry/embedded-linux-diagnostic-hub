import assert from 'node:assert/strict';
import { observeOwnedChild, requireObservedClosure } from './owned-child.mjs';

/** Observe a child already submitted by the caller that owns its output streams.
 * This never launches or detaches a process. Caller must drain both streams, and
 * owns termination/retention on failures. Direct-child closure is not tree closure.
 */
export function observeLinuxOwnedLaunch(child, { requestStop, totalMs = 30000, reserveMs = 1000 }) {
    assert.equal(typeof requestStop, 'function', 'A cancellation/retention owner is required.');
    assert.ok(child.stdout && child.stderr, 'Both owned output streams must be observable.');
    const observer = observeOwnedChild(child, { totalMs, reserveMs, requestStop });
    return Object.freeze({
        async readback() {
            const facts = await observer.outcome;
            requireObservedClosure(facts);
            assert.equal(facts.code, 0, 'Owned launch exited nonzero.');
            assert.equal(facts.terminationRequested, false);
            assert.deepEqual(facts.killErrors, []);
            assert.equal(child.stdout.readableEnded, true, 'Missing stdout EOF.');
            assert.equal(child.stderr.readableEnded, true, 'Missing stderr EOF.');
            return Object.freeze({
                kind: 'linux-owned-direct-child-observation/v1',
                pid: facts.pid,
                code: facts.code,
                stdoutEOF: true,
                stderrEOF: true,
                processTreeRetired: 'not-verified',
                releaseAcceptance: false,
            });
        },
    });
}

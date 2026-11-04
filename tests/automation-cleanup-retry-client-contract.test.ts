import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowRunner, type FlowState, type RunClock } from '../src/features/automation/runner';
import { sshConsoleBackend } from '../src/features/automation/capture/console-backend';
import type { AutomationPlan } from '../shared/automation';
import { consoleOwner } from '../shared/console-rpc';
import { createCleanupRetryBoundary, CLEANUP_CONNECTION, CLEANUP_LEASE, RETRY_OUTCOME, EVIDENCE_FAILURE } from './ui/fixtures/cleanup-retry';
import { settled, until } from './fixtures/runner-cancel-fixture';

test('the mounted retry boundary reaches actual runner/client evidence-failure output after held acknowledgement', async () => {
    const host = createCleanupRetryBoundary(), states: FlowState[] = [];
    const clock: RunClock = { local: () => Date.UTC(2028, 1, 29), mono: () => 0,
        watch: () => () => {}, sleep: async () => { throw Error('No timer wait admitted.'); } };
    let failedOutcomes = 0;
    const runner = new FlowRunner(s => states.push(s), row => {
        assert.equal(row.consoleCapture, undefined);
        assert.equal(row.stderr, EVIDENCE_FAILURE);
        assert.equal(++failedOutcomes, 1);
        // Same failure route as Page's onRecord when no stored evidence was acknowledged.
        throw Error(row.stderr);
    }, clock);
    const backend = sshConsoleBackend({ automationConnection: () => CLEANUP_CONNECTION,
        automationConsole: request => host.rpc(request) }, 'local-client',
        { endpoint: 'in-memory service boundary, no actual connection' }, () => true);
    const criterion = { role: 'shell-prompt' as const, literals: ['fixture# '] };
    const plan: AutomationPlan = { transport: 'ssh', timeoutSeconds: 10,
        repeatSeconds: null, start: null,
        serial: { lineEnding: 'CR', prompt: '# ', timestampPrefix: '' },
        ssh: { mode: 'console', ready: criterion, completion: criterion },
        steps: ['FAIL_ONCE', 'NEVER_SEND'].map((command, index) => ({ id: 'retry-step-' + index,
            name: command, enabled: true, command, delaySeconds: 0,
            ssh: { intent: 'script' as const, completion: criterion } })) };
    assert.equal(consoleOwner({ id: CLEANUP_LEASE, connection: CLEANUP_CONNECTION,
        capability: 'd'.repeat(64) }).connection, CLEANUP_CONNECTION);
    const lease = await host.acquireActivity();
    await settled(runner.start(plan, backend));
    assert.equal(runner.cleanupPending, true);
    assert.match(states.at(-1)!.message, /Console cleanup remains pending/);
    assert.deepEqual(host.snapshot().commands, ['FAIL_ONCE']);
    assert.equal(failedOutcomes, 1);
    const retry = runner.retryCleanup();
    try {
        await until(() => host.snapshot().retryPending);
        assert.equal(runner.retryCleanup(), retry);
        assert.equal(runner.busy, true);
        assert.throws(() => runner.start(plan, backend), /awaiting cleanup/);
        await assert.rejects(host.releaseActivity('stale-owner'), /activity released/);
        assert.equal(host.snapshot().activityReleases, 0);
        assert.equal(host.snapshot().ownerReleased, 0);
    } finally {
        host.acknowledgeRetry();
        await settled(retry);
    }
    assert.equal(runner.busy, false);
    assert.deepEqual(states.at(-1), { state: 'paused', message: RETRY_OUTCOME + ' Flow paused; arm explicitly to resume.' });
    assert.equal(host.snapshot().ownerReleased, 1);
    await host.releaseActivity(lease);
    assert.deepEqual(host.snapshot().commands, ['FAIL_ONCE']);
    assert.equal(host.snapshot().activityReleases, 1);
    assert.equal(host.snapshot().leaseHeld, false);
    await settled(runner.retryCleanup());
    assert.equal(host.snapshot().finishes, 2);
});

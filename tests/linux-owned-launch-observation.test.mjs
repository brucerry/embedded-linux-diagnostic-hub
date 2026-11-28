import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeLinuxOwnedLaunch } from '../scripts/lib/linux-owned-launch-observation.mjs';

test('Linux observer waits for actual events and EOF of an owned benign child', async () => {
    const child = spawn(process.execPath, ['-e', 'console.log("owned fixture")'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
    });
    let cancelled = false;
    const witness = observeLinuxOwnedLaunch(child, { requestStop: () => { cancelled = true; } });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const value = await witness.readback();
    assert.equal(stdout, 'owned fixture\n');
    assert.equal(value.pid, child.pid);
    assert.equal(value.code, 0);
    assert.equal(value.releaseAcceptance, false);
    assert.equal(value.processTreeRetired, 'not-verified');
    assert.equal(cancelled, false);
});

test('Linux observer refuses both missing closure and incomplete stream drain', async () => {
    const simulated = () => Object.assign(new EventEmitter(), {
        pid: 123, stdout: { readableEnded: true }, stderr: { readableEnded: false },
    });
    const closed = simulated(), owned = observeLinuxOwnedLaunch(closed, { requestStop() {} });
    closed.emit('spawn');
    closed.emit('exit', 0, null);
    closed.emit('close', 0, null);
    await assert.rejects(owned.readback(), /Missing stderr EOF/);

    let retained = false;
    const pending = simulated();
    const missing = observeLinuxOwnedLaunch(pending, {
        requestStop() { retained = true; }, totalMs: 20, reserveMs: 10,
    });
    pending.emit('spawn');
    pending.emit('exit', 0, null);
    await assert.rejects(missing.readback(), /spawn\/exit\/close incomplete/);
    assert.equal(retained, true);
});

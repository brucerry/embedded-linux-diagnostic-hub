import assert from 'node:assert/strict';
export function finalPtyClosure(stderr: string) {
    const rows = stderr.split(/\r?\n/).filter((s) => s.startsWith('HUB_OS_PTY_CLOSE '));
    assert.equal(rows.length, 1, 'Exactly one final PTY leaf receipt required.');
    const r = JSON.parse(rows[0].slice('HUB_OS_PTY_CLOSE '.length));
    for (const k of [
        'complete',
        'bashExited',
        'agentExited',
        'inputPumpJoined',
        'outputPumpJoined',
        'outputDrained',
        'pipesClosed',
        'handlesClosed',
        'terminationConfirmed',
    ])
        assert.equal(r[k], true, 'PTY closure unconfirmed: ' + k);
    for (const k of ['childPid', 'agentPid']) assert(Number.isSafeInteger(r[k]) && r[k] > 0);
    for (const k of ['childCreated', 'agentCreated']) assert(/^[1-9]\d+$/.test(r[k]));
    return r;
}

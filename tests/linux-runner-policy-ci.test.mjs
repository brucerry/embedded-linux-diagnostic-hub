import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { verifyLinuxPolicy } from '../scripts/ci/verify-linux-memory-policy.mjs';

const bytes = Buffer.from('{"fixture":true}');
const sha = createHash('sha256').update(bytes).digest('hex');
const env = { HUB_MEMORY_POLICY_JSON: String(bytes), HUB_MEMORY_POLICY_SHA256: sha };
const root = process.cwd();
function fixture(override = {}) {
    const calls = [];
    const target = path.join(root, 'validation/memory-policies', sha + '.json');
    return { calls, target, io: {
        async run(args) { calls.push(args); },
        async readJson() { return { status:'staged-reviewed-policy-bytes', policySHA256:sha, policyPath:target, ...override }; },
        async readBytes() { return bytes; },
    }};
}
test('preflight rejects missing and wrong bytes before any dependency or workload command', async () => {
    const f = fixture();
    await assert.rejects(verifyLinuxPolicy('preflight', {}, root, f.io));
    await assert.rejects(verifyLinuxPolicy('preflight', {...env,HUB_MEMORY_POLICY_SHA256:'0'.repeat(64)}, root, f.io));
    await verifyLinuxPolicy('preflight', env, root, f.io);
    assert.deepEqual(f.calls, []);
    const cli = spawnSync(process.execPath,['scripts/ci/verify-linux-memory-policy.mjs','preflight'], {
        env:{...process.env,...env}, encoding:'utf8',
    });
    assert.equal(cli.status,0,cli.stderr);
});
test('exact staged receipt reaches enforcement and wrong receipt or bytes stop early', async () => {
    const f = fixture();
    await verifyLinuxPolicy('enforce', env, root, f.io);
    assert.equal(f.calls.length,2);
    assert.ok(f.calls[0].includes('--entry=policy'));
    assert.ok(f.calls[1].includes('--entry=fast'));
    assert.ok(f.calls[1].includes('--policy-sha256='+sha));
    for (const opts of [{status:'synthetic'}, {policySHA256:'0'.repeat(64)}, {policyPath:'/tmp/wrong'}]) {
        const bad = fixture(opts);
        await assert.rejects(verifyLinuxPolicy('enforce', env, root, bad.io));
        assert.equal(bad.calls.length,1);
    }
    const bad = fixture();
    bad.io.readBytes = async () => Buffer.from('altered');
    await assert.rejects(verifyLinuxPolicy('enforce', env, root, bad.io));
    assert.equal(bad.calls.length,1);
});

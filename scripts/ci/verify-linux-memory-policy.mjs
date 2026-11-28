import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBoundedJSON, readBoundedReceiptBytes } from '../lib/bounded-receipt-json.mjs';

const MAX = 64 * 1024;
const STAGE = 'validation/memory/ci-policy-stage.json';
const SHA = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function selectedPolicy(env) {
    const json = env.HUB_MEMORY_POLICY_JSON;
    const sha = env.HUB_MEMORY_POLICY_SHA256;
    assert.ok(typeof json === 'string' && json.length && Buffer.byteLength(json) <= MAX &&
        typeof sha === 'string' && SHA.test(sha),
        'Provide reviewed HUB_MEMORY_POLICY_JSON and its independent SHA-256 before dependency install.');
    assert.equal(digest(json), sha, 'Reviewed Linux policy bytes do not match the selected digest.');
    let value;
    try { value = JSON.parse(json); }
    catch { throw Error('Reviewed Linux policy bytes are not valid JSON.'); }
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected a Linux policy object.');
    return sha;
}

export async function verifyLinuxPolicy(mode, env, root, io) {
    const sha = selectedPolicy(env);
    if (mode === 'preflight') return;
    assert.equal(mode, 'enforce');
    await io.run(['scripts/memory-runtime.mjs','--entry=policy','--policy-kind=fast','--profile=fast','--out='+STAGE]);
    const staged = await io.readJson(path.resolve(root, STAGE), MAX);
    assert.equal(staged?.status, 'staged-reviewed-policy-bytes', 'Memory harness did not stage the reviewed policy.');
    assert.equal(staged.policySHA256, sha);
    const target = path.resolve(root, 'validation/memory-policies', sha + '.json');
    assert.equal(staged.policyPath, target, 'Unexpected staged memory policy path.');
    const bytes = await io.readBytes(target, MAX);
    assert.equal(digest(bytes), sha, 'The staged memory policy changed before enforcement.');
    await io.run(['scripts/memory-runtime.mjs','--entry=fast','--profile=fast','--policy='+target,
        '--policy-sha256='+sha,'--out=validation/memory/ci-fast']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        await verifyLinuxPolicy(process.argv[2], process.env, process.cwd(), {
            readJson: readBoundedJSON,
            readBytes: readBoundedReceiptBytes,
            run(args) {
                const r = spawnSync(process.execPath, args, { stdio: 'inherit', shell: false });
                if (r.error || r.signal || r.status !== 0) throw Error('The Linux memory harness did not pass.');
            },
        });
    } catch (error) {
        // Do not echo supplied policy bytes, paths returned by a child, or environment values.
        console.error(error?.code === 'ERR_ASSERTION' ? 'Linux memory policy check refused the selected input or staged receipt.' : 'Linux memory policy execution blocked.');
        process.exitCode = 1;
    }
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './memory-resource-identity';

export const fastProtocol = Object.freeze({
    schema: 1,
    warmup: 3,
    measured: 12,
    checkpoint: 'original-warmup-baseline/two-turn-two-gc/closed-cycle-forced-second/v1',
    scenario: 'nativeCycle/success-cancel-rearm-quota-four-exports-ssh/empty-catalog/v1',
    samplerTargetMs: 250,
    totalChildMs: 120000,
    cleanupReserveMs: 1000,
    supervision:
        'shared-monotonic-deadline/before-preflight/ipc-cancel/owner-retained-until-leaf-close/v1',
});
export type FastIdentity = {
    schema: 1;
    protocol: typeof fastProtocol;
    files: Record<string, string>;
    ssh: { id: string; manifestSHA256: string; files: Record<string, string> };
    observer: string;
    launchInputs: Record<string, string>;
};
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validateFastIdentity(value: unknown): asserts value is FastIdentity {
    const identity = value as FastIdentity;
    assert.equal(identity?.schema, 1, 'Missing finite fast identity.');
    assert.deepEqual(identity.protocol, fastProtocol, 'Fast checkpoint/workload/deadline changed.');
    assert.ok(['sampled', 'disabled'].includes(identity.observer));
    assert.deepEqual(Object.keys(identity.files).sort(), [
        'collector',
        'driver',
        'evidence',
        'identity',
        'invocation',
        'lifecycle',
        'negative',
        'owner',
        'policy',
        'receipt',
    ]);
    assert.ok(Object.values(identity.files).every(hash));
    assert.ok(hash(identity.ssh.id) && hash(identity.ssh.manifestSHA256));
    assert.deepEqual(Object.keys(identity.ssh.files).sort(), ['preload.cjs', 'ssh2.cjs']);
    assert.ok(Object.values(identity.ssh.files).every(hash));
    assert.ok(Object.keys(identity.launchInputs).length > 0);
    for (const [file, digest] of Object.entries(identity.launchInputs))
        assert.ok(path.isAbsolute(file) && hash(digest));
}

/** Hash actual source and every generated profile/tool input; no workload or memory sample. */
export async function fastIdentity(
    root: string,
    observer: string,
    sshRuntime: any,
    argv = process.execArgv,
): Promise<FastIdentity> {
    assert.equal(
        (process.env.NODE_OPTIONS ?? '').trim(),
        '',
        'Finite identity refuses injected NODE_OPTIONS; use the explicit hash-bound harness arguments.',
    );
    assert.equal(
        sshRuntime.kind,
        'ssh2-js-bundle',
        'Fast contract needs the pinned generated JS profile.',
    );
    const manifestBytes = await fs.readFile(sshRuntime.manifestPath);
    const manifest = JSON.parse(manifestBytes.toString()),
        { id, ...core } = manifest;
    assert.equal(sha256(JSON.stringify(core)), id);
    assert.equal(sha256(await fs.readFile(path.join(root, 'package-lock.json'))), core.lockSHA256);
    const files = {
        driver: 'tests/fixtures/memory-resource-regression.ts',
        collector: 'tests/fixtures/memory-resource-regression.ts',
        evidence: 'tests/fixtures/memory-resource-evidence.ts',
        identity: 'tests/fixtures/memory-fast-identity.ts',
        invocation: 'scripts/memory-runtime.mjs',
        lifecycle: 'scripts/lib/owned-child.mjs',
        owner: 'scripts/lib/resource-owner.mjs',
        negative: 'tests/fixtures/memory-resource-negative.ts',
        policy: 'tests/fixtures/memory-resource-policy.ts',
        receipt: 'tests/fixtures/memory-fast-receipt.ts',
    };
    const actual: Record<string, string> = {};
    for (const [name, relative] of Object.entries(files))
        actual[name] = sha256(await fs.readFile(path.join(root, relative)));
    for (const input of [...core.packages, ...core.inputs, ...core.loaderInputs]) {
        if (input.virtual) continue;
        const file = input.manifestPath ?? input.path,
            expected = input.manifestSHA256 ?? input.sha256;
        assert.ok(path.isAbsolute(file) && hash(expected), 'Incomplete profile input.');
        assert.equal(
            sha256(await fs.readFile(file)),
            expected,
            'Generated SSH/loader input changed: ' + file,
        );
    }
    for (const [name, expected] of Object.entries(core.files)) {
        assert.ok(['preload.cjs', 'ssh2.cjs'].includes(name));
        assert.equal(
            sha256(await fs.readFile(path.join(path.dirname(sshRuntime.manifestPath), name))),
            expected,
        );
    }
    const launchInputs: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const match = /^(--require|--import|--loader|--experimental-loader|-r)(?:=(.*))?$/.exec(
            argv[i],
        );
        if (!match) continue;
        const value = match[2] ?? argv[++i];
        assert.ok(value, 'Missing launch input.');
        const file = value.startsWith('file:') ? fileURLToPath(value) : value;
        assert.ok(
            path.isAbsolute(file),
            'Unhashable/relative launch input requires separate review.',
        );
        launchInputs[file] = sha256(await fs.readFile(file));
    }
    const identity: FastIdentity = {
        schema: 1,
        protocol: fastProtocol,
        files: actual,
        ssh: { id, manifestSHA256: sha256(manifestBytes), files: core.files },
        observer,
        launchInputs,
    };
    validateFastIdentity(identity);
    return identity;
}

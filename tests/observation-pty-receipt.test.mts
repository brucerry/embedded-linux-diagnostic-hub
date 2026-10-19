// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preserveObservationPty } from '../scripts/lib/observation-pty-receipt.mjs';
import { pilotLimits, bindingDigest } from '../scripts/lib/hosted-pilot-contract.mjs';
import { ptyObservationPolicy } from '../scripts/lib/pty-observation-scope.mjs';
import { metadataIdentity, digest } from '../scripts/lib/windows-preflight.mjs';
const sourceRoot = path.resolve(import.meta.dirname, '..'),
    sha = 'a'.repeat(64),
    nonce = '11111111-1111-4111-8111-111111111111',
    parent = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
function fixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-receipt-'))),
        policySHA256 = digest(
            fs.readFileSync(
                path.join(sourceRoot, 'scripts/lib/hosted-pty-observation-policy.json'),
            ),
        ),
        scopeJSON = JSON.stringify({
            ...ptyObservationPolicy,
            kind: 'windows-hosted-pty-observation-scope-v1',
            reviewed: true,
            sourceSHA256: sha,
            policySHA256,
        }),
        scopeSHA256 = digest(scopeJSON),
        host = {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            attempt: '1',
            run: '123',
            commit: 'b'.repeat(40),
            environment: 'github-hosted',
        };
    const b = {
        schema: 1,
        kind: 'windows-hosted-pty-observation-v1',
        mode: 'pty-observation-only',
        collectionApproval: false,
        host,
        nonce,
        principalSID: 'S-1-5-21-1-2-3-500',
        sourceSHA256: sha,
        scopeSHA256,
        pilotPolicySHA256: policySHA256,
        dependenciesSHA256: sha,
        runtime: {
            platform: 'win32',
            arch: 'x64',
            ...Object.fromEntries(
                [
                    'node',
                    'tsx',
                    'powershell',
                    'git',
                    'bash',
                    'cygpath',
                    'winptyDll',
                    'winptyAgent',
                ].map((k) => [
                    k,
                    {
                        path: 'C:\\runtime\\' + k,
                        sha256: sha,
                        ...(k === 'node' ? { version: 'v24.22.0' } : {}),
                    },
                ]),
            ),
        },
        roots: {
            canonicalTemp: { path: parent, dev: '1', ino: '1', descriptorSHA256: sha },
            privateRoot: {
                path: parent + '\\diagnostic-hub-native-pilot-' + nonce,
                dev: '1',
                ino: '2',
                descriptorSHA256: sha,
            },
            evidenceRoot: { path: 'D:\\report', dev: '1', ino: '3', identitySHA256: sha },
        },
        startedAt: 0,
        deadline: pilotLimits.totalMs,
        limits: pilotLimits,
    };
    const rows = [
        { stage: 'pilot-owned.json', data: { binding: b, bindingSHA256: bindingDigest(b) } },
        {
            stage: 'pilot-real-os-pty-closed.json',
            data: {
                bindingSHA256: bindingDigest(b),
                proof: { descendantsClosed: true, leafReceiptsClosed: true, logsClosed: true },
            },
        },
        {
            stage: 'pilot-result',
            data: { bindingSHA256: bindingDigest(b), passed: true, collectionApproval: false },
        },
    ];
    const write = () =>
        fs.writeFileSync(
            path.join(root, 'pilot.jsonl'),
            rows.map((r) => JSON.stringify(r) + '\n').join(''),
        );
    write();
    const holds = [],
        ownerCheck = () => {};
    ownerCheck.many = () => {};
    const options = {
        sourceRoot,
        host,
        canonicalTemp: parent,
        ownerCheck,
        hold: (s) => holds.push(s),
        identity: (file) =>
            file === parent
                ? { dev: '1', ino: '1' }
                : { ...metadataIdentity(root), path: 'D:\\report', dev: '1', ino: '3' },
    };
    return {
        root,
        rows,
        write,
        holds,
        options,
        expected: { sourceSHA256: sha, policySHA256, scopeSHA256, scopeJSON },
        close: () => fs.rmSync(root, { recursive: true }),
    };
}
test('actual durable journal binding and closure are preserved and unchanged after an approval wait', () => {
    const f = fixture();
    try {
        const first = preserveObservationPty(f.root, f.expected, f.options);
        assert.deepEqual(preserveObservationPty(f.root, f.expected, f.options), first);
        assert(first.closed && first.durable);
        assert.equal(f.holds.length, 0);
        assert.equal(first.files.length, 1);
    } finally {
        f.close();
    }
});
for (const mutation of ['source', 'scope', 'policy', 'closure', 'host', 'corrupt'])
    test('PTY receipt refuses ' + mutation + ' rather than trusting copied request fields', () => {
        const f = fixture();
        try {
            if (mutation === 'source') f.expected.sourceSHA256 = 'c'.repeat(64);
            if (mutation === 'scope') f.expected.scopeSHA256 = 'c'.repeat(64);
            if (mutation === 'policy') f.expected.policySHA256 = 'c'.repeat(64);
            if (mutation === 'host') f.options.host = { ...f.options.host, run: '124' };
            if (mutation === 'closure') {
                f.rows[1].data.proof.logsClosed = false;
                f.write();
            }
            if (mutation === 'corrupt')
                fs.appendFileSync(path.join(f.root, 'pilot.jsonl'), 'partial');
            assert.throws(() => preserveObservationPty(f.root, f.expected, f.options));
            assert(f.holds.length > 0);
        } finally {
            f.close();
        }
    });
test('post-wait digest detects added evidence and sync/close uncertainty stays held', () => {
    const f = fixture();
    try {
        const first = preserveObservationPty(f.root, f.expected, f.options);
        fs.writeFileSync(path.join(f.root, 'new-record'), 'x');
        assert.notDeepEqual(preserveObservationPty(f.root, f.expected, f.options), first);
        assert.throws(() =>
            preserveObservationPty(f.root, f.expected, {
                ...f.options,
                io: {
                    ...fs,
                    fsyncSync() {
                        throw Error('sync fault');
                    },
                },
            }),
        );
        assert(f.holds.length > 0);
    } finally {
        f.close();
    }
});

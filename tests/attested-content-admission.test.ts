import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
    ADMISSION_REVIEW_LEASE_MS,
    VERIFIER_CANDIDATE,
    inspectVerifierAdmission,
} from '../scripts/lib/attested-content-admission.mjs';
import { verifyLocalAttestation } from '../scripts/lib/attested-content-verifier.mjs';

const nowMs = Date.UTC(2026, 10, 5, 12);
const operationMs = 180000;
const roles = ['root', 'timestamp', 'snapshot', 'targets'] as const;
const hash = (label: string) => createHash('sha256').update(label).digest('hex');
const liveBlocked =
    'Live verifier blocked: independent binary/root admission and owned process retirement unavailable.';

/** Labels generate synthetic identifiers only; no executable, package or trust-root bytes exist. */
function complete(): any {
    return {
        schemaVersion: 1,
        kind: 'diagnostic-hub-verifier-admission-selection',
        binary: {
            platform: 'linux',
            arch: 'x64',
            version: '2.103.3',
            sourceCommit: '63837fb778d6a39f02be0ce76ff89f2bc8d74bdc',
            packageName: 'gh_2.103.3_linux_amd64.tar.gz',
            packageSHA256: '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d',
            executableSHA256: hash('synthetic executable selection'),
            provenanceReceiptSHA256: hash('synthetic unauthenticated binary provenance receipt'),
        },
        root: {
            instance: 'sigstore-public-good',
            mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
            bootstrapSHA256: hash('synthetic unauthenticated bootstrap selection'),
            exportSHA256: hash('synthetic unauthenticated JSONL export selection'),
            targetSHA256: hash('synthetic unauthenticated trusted-root target selection'),
            targetBytes: 100,
            metadata: Object.fromEntries(
                roles.map((role, i) => [
                    role,
                    {
                        version: i + 10,
                        sha256: hash('synthetic ' + role + ' metadata selection'),
                        expiresMs: nowMs + 2 * ADMISSION_REVIEW_LEASE_MS,
                    },
                ]),
            ),
            exportedAtMs: nowMs - 60000,
            tufReceiptSHA256: hash('synthetic unauthenticated TUF receipt'),
            exportBindingReceiptSHA256: hash('synthetic unauthenticated export binding receipt'),
        },
        freshness: {
            checkedAtMs: nowMs - 30000,
            leaseUntilMs: nowMs + 60 * 60 * 1000,
            advisorySnapshotSHA256: hash('synthetic unauthenticated advisory source'),
            denylistSHA256: hash('synthetic unauthenticated denylist source'),
            deniedDigests: [],
            versionFloors: Object.fromEntries(roles.map((role, i) => [role, i + 9])),
        },
        process: {
            ownerImplementationSHA256: hash('synthetic unverified owner implementation'),
            requestBindingSHA256: hash('synthetic unverified request binding'),
            mode: 'owned-no-signals',
            commands: 4,
            maxAttempts: 1,
            workMs: 30000,
            closeReserveMs: 5000,
            totalMs: operationMs,
            stdoutLimit: 16 * 1024 ** 2,
            stderrLimit: 1024 ** 2,
            signals: [],
            onUncertain: 'retain-custody-no-retry',
            descendants: 'independent-retirement-required',
        },
    };
}
function unknown() {
    const plan = complete();
    for (const field of ['executableSHA256', 'provenanceReceiptSHA256']) plan.binary[field] = null;
    for (const field of [
        'bootstrapSHA256',
        'exportSHA256',
        'targetSHA256',
        'targetBytes',
        'exportedAtMs',
        'tufReceiptSHA256',
        'exportBindingReceiptSHA256',
    ])
        plan.root[field] = null;
    for (const role of roles) {
        plan.root.metadata[role] = null;
        plan.freshness.versionFloors[role] = 0; // Selected initial anti-rollback baseline, not an observed metadata version.
    }
    for (const field of ['checkedAtMs', 'leaseUntilMs', 'advisorySnapshotSHA256', 'denylistSHA256'])
        plan.freshness[field] = null;
    plan.process.ownerImplementationSHA256 = null;
    plan.process.requestBindingSHA256 = null;
    return plan;
}
function inspect(plan: any) {
    return inspectVerifierAdmission(plan, { nowMs });
}
function remainsBlocked(value: any) {
    for (const field of [
        'executionAllowed',
        'artifactAccessAllowed',
        'qualification',
        'releaseAcceptance',
        'rootAuthenticationProven',
        'binaryProvenanceProven',
        'retirementProven',
    ])
        assert.equal(value[field], false, field);
    assert.equal(value.revocationStatus, 'not-established');
    assert.equal(value.reviewLeaseCapMs, 24 * 60 * 60 * 1000);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(value.missing), true);
}
function selectedHashes(plan: any) {
    return [
        ['binary.packageSHA256', plan.binary.packageSHA256],
        ['binary.executableSHA256', plan.binary.executableSHA256],
        ['binary.provenanceReceiptSHA256', plan.binary.provenanceReceiptSHA256],
        ...[
            'bootstrapSHA256',
            'exportSHA256',
            'targetSHA256',
            'tufReceiptSHA256',
            'exportBindingReceiptSHA256',
        ].map((field) => ['root.' + field, plan.root[field]]),
        ...roles.map((role) => ['root.metadata.' + role, plan.root.metadata[role].sha256]),
        ['freshness.advisorySnapshotSHA256', plan.freshness.advisorySnapshotSHA256],
        ['freshness.denylistSHA256', plan.freshness.denylistSHA256],
        ['process.ownerImplementationSHA256', plan.process.ownerImplementationSHA256],
        ['process.requestBindingSHA256', plan.process.requestBindingSHA256],
    ];
}

test('complete synthetic selections are consistency records and cannot establish authority', () => {
    const plan = complete(),
        before = structuredClone(plan),
        result = inspect(plan);
    assert.equal(result.status, 'blocked-unverified-admission-evidence');
    assert.deepEqual(result.missing, []);
    assert.equal(result.selectionSHA256, hash(JSON.stringify(plan)));
    assert.deepEqual(plan, before);
    remainsBlocked(result);
});

test('realistically unknown actual facts stay null and never become claimed authentication', () => {
    const plan = unknown(),
        before = structuredClone(plan),
        result = inspect(plan);
    assert.equal(result.status, 'blocked-missing-admission-evidence');
    assert.equal(result.missing.length, 19);
    for (const name of [
        'binary.executableSHA256',
        'binary.provenanceReceiptSHA256',
        'root.bootstrapSHA256',
        'root.exportSHA256',
        'root.targetSHA256',
        'root.targetBytes',
        'root.exportedAtMs',
        'root.tufReceiptSHA256',
        'root.exportBindingReceiptSHA256',
        ...roles.map((role) => 'root.metadata.' + role),
        'freshness.checkedAtMs',
        'freshness.leaseUntilMs',
        'freshness.advisorySnapshotSHA256',
        'freshness.denylistSHA256',
        'process.ownerImplementationSHA256',
        'process.requestBindingSHA256',
    ])
        assert.ok(result.missing.includes(name), name);
    assert.deepEqual(plan, before);
    remainsBlocked(result);
});

test('official publication constants select packages and cannot stand in for executable hashes', () => {
    assert.equal(VERIFIER_CANDIDATE.version, '2.103.3');
    assert.equal(VERIFIER_CANDIDATE.sourceCommit, '63837fb778d6a39f02be0ce76ff89f2bc8d74bdc');
    assert.equal(VERIFIER_CANDIDATE.publishedPackageSHA256.x64, complete().binary.packageSHA256);
    assert.equal(Object.isFrozen(VERIFIER_CANDIDATE), true);
    assert.equal(Object.isFrozen(VERIFIER_CANDIDATE.publishedPackageSHA256), true);
    assert.ok(!('executableSHA256' in VERIFIER_CANDIDATE));
});

for (const [arch, packageName, packageSHA256] of [
    [
        'x64',
        'gh_2.103.3_linux_amd64.tar.gz',
        '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d',
    ],
    [
        'x64',
        'gh_2.103.3_linux_amd64.deb',
        'e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d',
    ],
    [
        'arm64',
        'gh_2.103.3_linux_arm64.tar.gz',
        'ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63',
    ],
])
    test('supported package route remains blocked: ' + packageName, () => {
        const plan = complete();
        Object.assign(plan.binary, { arch, packageName, packageSHA256 });
        remainsBlocked(inspect(plan));
    });

for (const instance of ['sigstore-public-good', 'github-private'])
    test('selected trust instance remains unauthenticated: ' + instance, () => {
        const plan = complete();
        plan.root.instance = instance;
        remainsBlocked(inspect(plan));
    });

for (const [label, mutate] of [
    ['old2.46', (p: any) => (p.binary.version = '2.46.0')],
    ['vulnerable-floor', (p: any) => (p.binary.version = '2.101.0')],
    ['different-reviewed-release', (p: any) => (p.binary.version = '2.102.0')],
    ['future-release', (p: any) => (p.binary.version = '2.103.4')],
    ['major-version', (p: any) => (p.binary.version = '3.0.0')],
    ['foreign-source', (p: any) => (p.binary.sourceCommit = 'f'.repeat(40))],
    ['foreign-package', (p: any) => (p.binary.packageSHA256 = hash('foreign package'))],
    ['cross-architecture-package', (p: any) => (p.binary.arch = 'arm64')],
    ['cross-package-name', (p: any) => (p.binary.packageName = 'gh_2.103.3_linux_amd64.deb')],
    ['unregistered-package', (p: any) => (p.binary.packageName = 'gh_2.103.3_linux_amd64.rpm')],
    ['foreign-platform', (p: any) => (p.binary.platform = 'darwin')],
    ['unsupported-architecture', (p: any) => (p.binary.arch = 'ia32')],
    ['staging-root', (p: any) => (p.root.instance = 'sigstore-staging')],
    [
        'new-root-media',
        (p: any) => (p.root.mediaType = 'application/vnd.dev.sigstore.trustedroot.v0.2+json'),
    ],
    [
        'renamed-root-media',
        (p: any) => (p.root.mediaType = 'application/vnd.dev.sigstore.trustedroot.v0.1+json'),
    ],
    ['oversized-target', (p: any) => (p.root.targetBytes = 4 * 1024 ** 2 + 1)],
    ['empty-target', (p: any) => (p.root.targetBytes = 0)],
] as const)
    test('foreign or unsupported selection refuses ' + label, () => {
        const plan = complete();
        mutate(plan);
        assert.throws(() => inspect(plan));
    });

for (const [name] of selectedHashes(complete()))
    test('denylist applies to selected digest ' + name, () => {
        const plan = complete();
        plan.freshness.deniedDigests = [
            selectedHashes(plan).find(([candidate]) => candidate === name)![1],
        ];
        assert.throws(() => inspect(plan), /denied/);
    });

for (const role of roles) {
    for (const delta of [-1, 0, operationMs - 1, operationMs])
        test('role expiry covers the complete operation: ' + role + '/' + delta, () => {
            const plan = complete();
            plan.root.metadata[role].expiresMs = nowMs + delta;
            plan.freshness.leaseUntilMs = nowMs + operationMs + 1;
            assert.throws(() => inspect(plan));
        });
    for (const delta of [operationMs - 1, operationMs])
        test('known role expiry cannot hide behind an unknown lease: ' + role + '/' + delta, () => {
            const plan = complete();
            plan.root.metadata[role].expiresMs = nowMs + delta;
            plan.freshness.leaseUntilMs = null;
            assert.throws(() => inspect(plan), /expires during/);
        });
    test('role rollback is refused independently for ' + role, () => {
        const plan = complete();
        plan.freshness.versionFloors[role] = plan.root.metadata[role].version + 1;
        assert.throws(() => inspect(plan), /rollback/);
    });
    test('equal remembered role floor is consistent but unverified for ' + role, () => {
        const plan = complete();
        plan.freshness.versionFloors[role] = plan.root.metadata[role].version;
        remainsBlocked(inspect(plan));
    });
    test('missing role remains an explicit unknown for ' + role, () => {
        const plan = complete();
        plan.root.metadata[role] = null;
        const result = inspect(plan);
        assert.ok(result.missing.includes('root.metadata.' + role));
        remainsBlocked(result);
    });
}

test('one millisecond of validity beyond the operation is consistent but cannot grant access', () => {
    const plan = complete();
    for (const role of roles) plan.root.metadata[role].expiresMs = nowMs + operationMs + 1;
    plan.freshness.leaseUntilMs = nowMs + operationMs + 1;
    remainsBlocked(inspect(plan));
});
for (const delta of [-1, 0, operationMs - 1, operationMs, ADMISSION_REVIEW_LEASE_MS + 1])
    test('administrative lease refuses uncovered or excessive validity ' + delta, () => {
        const plan = complete();
        plan.root.exportedAtMs = nowMs;
        plan.freshness.checkedAtMs = nowMs;
        plan.freshness.leaseUntilMs = nowMs + delta;
        assert.throws(() => inspect(plan));
    });
test('the exact 24-hour administrative cap remains blocked and is not a revocation guarantee', () => {
    const plan = complete();
    plan.root.exportedAtMs = nowMs;
    plan.freshness.checkedAtMs = nowMs;
    plan.freshness.leaseUntilMs = nowMs + ADMISSION_REVIEW_LEASE_MS;
    remainsBlocked(inspect(plan));
});
for (const [label, mutate] of [
    ['future-security-review', (p: any) => (p.freshness.checkedAtMs = nowMs + 1)],
    ['future-export', (p: any) => (p.root.exportedAtMs = nowMs + 1)],
    [
        'stale-security-review',
        (p: any) => (p.freshness.checkedAtMs = nowMs - ADMISSION_REVIEW_LEASE_MS),
    ],
    ['stale-export', (p: any) => (p.root.exportedAtMs = nowMs - ADMISSION_REVIEW_LEASE_MS)],
    [
        'lease-after-security-cap',
        (p: any) =>
            (p.freshness.leaseUntilMs = p.freshness.checkedAtMs + ADMISSION_REVIEW_LEASE_MS + 1),
    ],
    [
        'lease-after-export-cap',
        (p: any) => {
            p.freshness.checkedAtMs = nowMs;
            p.freshness.leaseUntilMs = p.root.exportedAtMs + ADMISSION_REVIEW_LEASE_MS + 1;
        },
    ],
    [
        'lease-after-first-role-expiry',
        (p: any) => (p.root.metadata.targets.expiresMs = p.freshness.leaseUntilMs - 1),
    ],
    [
        'duplicate-denylist-entry',
        (p: any) => (p.freshness.deniedDigests = [hash('unselected'), hash('unselected')]),
    ],
    ['malformed-denylist-digest', (p: any) => (p.freshness.deniedDigests = ['not-a-digest'])],
    [
        'unbounded-denylist',
        (p: any) =>
            (p.freshness.deniedDigests = Array.from({ length: 1025 }, (_, i) =>
                hash('unselected' + i),
            )),
    ],
] as const)
    test('freshness consistency refuses ' + label, () => {
        const plan = complete();
        mutate(plan);
        assert.throws(() => inspect(plan));
    });

for (const [field, value] of [
    ['mode', 'synchronous-unowned'],
    ['commands', 3],
    ['commands', 5],
    ['maxAttempts', 2],
    ['workMs', 60000],
    ['closeReserveMs', 0],
    ['totalMs', operationMs + 1],
    ['stdoutLimit', 16 * 1024 ** 2 + 1],
    ['stderrLimit', 1024 ** 2 + 1],
    ['signals', ['SIGTERM']],
    ['signals', ['SIGKILL']],
    ['onUncertain', 'retry'],
    ['onUncertain', 'release-custody'],
    ['descendants', 'parent-close-is-enough'],
] as const)
    test('process plan refuses alternate ' + field + '=' + JSON.stringify(value), () => {
        const plan = complete();
        plan.process[field] = value;
        assert.throws(() => inspect(plan));
    });

for (const [label, select] of [
    ['plan', (p: any) => p],
    ['binary', (p: any) => p.binary],
    ['root', (p: any) => p.root],
    ['metadata', (p: any) => p.root.metadata],
    ['role', (p: any) => p.root.metadata.root],
    ['freshness', (p: any) => p.freshness],
    ['floors', (p: any) => p.freshness.versionFloors],
    ['process', (p: any) => p.process],
] as const)
    test('unknown approved=true cannot establish authority in ' + label, () => {
        const plan = complete();
        select(plan).approved = true;
        assert.throws(() => inspect(plan), /Unknown or missing/);
    });
test('context and malformed selections cannot supply a clock or authority fallback', () => {
    for (const context of [
        undefined,
        {},
        { nowMs: 0 },
        { nowMs: -1 },
        { nowMs: NaN },
        { nowMs: '1793880000000' },
        { nowMs, approved: true },
        { nowMs: Number.MAX_SAFE_INTEGER },
    ])
        assert.throws(() => inspectVerifierAdmission(complete(), context));
    for (const bad of [
        undefined,
        null,
        [],
        { ...complete(), schemaVersion: 2 },
        { ...complete(), executionAllowed: true },
    ])
        assert.throws(() => inspect(bad));
    const plan = complete();
    delete plan.root.metadata.targets;
    assert.throws(() => inspect(plan));
});

test('neither a complete model nor payload authority booleans can activate the real default verifier', async () => {
    const review = inspect(complete());
    for (const request of [
        review,
        { admission: review, approved: true, executionAllowed: true, artifactAccessAllowed: true },
    ])
        await assert.rejects(verifyLocalAttestation(request), { message: liveBlocked });
    let touched = 0;
    const unreadable = new Proxy(
        {},
        {
            get() {
                touched++;
                throw Error('Request was touched before the live guard.');
            },
            ownKeys() {
                touched++;
                throw Error('Request was cloned before the live guard.');
            },
        },
    );
    await assert.rejects(verifyLocalAttestation(unreadable), { message: liveBlocked });
    assert.equal(touched, 0);
});

/** Historical acquired data, not a fresh authorization or independently verified runtime witness. */
async function acquiredSelection() {
    return JSON.parse(
        await readFile(
            new URL('../docs/verifier-admission-candidate.json', import.meta.url),
            'utf8',
        ),
    );
}
const acquiredMissing = [
    'freshness.checkedAtMs',
    'freshness.advisorySnapshotSHA256',
    'freshness.denylistSHA256',
    'freshness.leaseUntilMs',
    'process.ownerImplementationSHA256',
    'process.requestBindingSHA256',
];
test('checked-in acquired observations match the frozen selection and retain exactly six unknowns', async () => {
    const plan = await acquiredSelection();
    assert.equal(
        hash(JSON.stringify(plan)),
        '06ac141289976e5375e3f81d497dd14e936277a2273672ad3926e53eaf202163',
    );
    const result = inspect(plan);
    assert.deepEqual(result.missing, acquiredMissing);
    assert.equal(result.status, 'blocked-missing-admission-evidence');
    remainsBlocked(result);
});
test('historical acquired selection expires rather than becoming an evergreen root or security lease', async () => {
    const plan = await acquiredSelection();
    assert.throws(
        () =>
            inspectVerifierAdmission(plan, {
                nowMs: plan.root.exportedAtMs + ADMISSION_REVIEW_LEASE_MS,
            }),
        /fresh admission review/,
    );
});
test('a model source hash and arbitrary review hashes cannot turn acquired content into admission authority', async () => {
    const plan = await acquiredSelection();
    plan.process.ownerImplementationSHA256 =
        '068ff081ab25a40d2fdefd13e934075c3f97c6b3dea0bc33c586b59783e57b0f';
    plan.process.requestBindingSHA256 = hash(
        'unadmitted template; selected artifact paths/bytes unavailable',
    );
    plan.freshness.checkedAtMs = nowMs;
    plan.freshness.leaseUntilMs = nowMs + 600000;
    plan.freshness.advisorySnapshotSHA256 = hash('not an observed advisory snapshot');
    plan.freshness.denylistSHA256 = hash('not an authenticated denylist');
    const result = inspect(plan);
    assert.deepEqual(result.missing, []);
    assert.equal(result.status, 'blocked-unverified-admission-evidence');
    remainsBlocked(result);
});
test('acquired identity and invented retirement flags cannot enable default file/process access', async () => {
    const plan = await acquiredSelection();
    await assert.rejects(
        verifyLocalAttestation({
            ...plan,
            executionAllowed: true,
            identityPreservingFileCustody: true,
            retirementProven: true,
        }),
        (error) => {
            assert.equal((error as Error).message, liveBlocked);
            return true;
        },
    );
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadataIdentity, ancestryIdentity, checkAncestry, digest } from './windows-preflight.mjs';
import { bindObservationDirectory } from './observation-paths.mjs';
import { observationInventory } from './observation-accounting.mjs';
export const queryPolicy = Object.freeze(
    JSON.parse(
        fs.readFileSync(
            new URL('./security-query-diagnostic-policy.json', import.meta.url),
            'utf8',
        ),
    ),
);
export const querySourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const oldQueryInputs = Object.freeze({
    windows_preflight_only: false,
    windows_native_pilot: false,
    windows_pty_observation_only: false,
    windows_pilot_winps_contract: false,
    windows_observation_pair: false,
    pty_source_sha256: '',
    pty_policy_sha256: '',
    pty_scope_sha256: '',
    pty_scope_json: '',
    pilot_source_sha256: '',
    pilot_policy_sha256: '',
    pilot_coverage_sha256: '',
    pilot_coverage_json: '',
    contract_source_sha256: '',
    observation_request_json: '',
    observation_approve_json: '',
});
export function requireQueryInputs(inputs, request) {
    assert.deepEqual(
        Object.keys(inputs).sort(),
        [
            ...Object.keys(oldQueryInputs),
            'windows_security_query_only',
            'security_query_request_json',
        ].sort(),
    );
    assert.equal(inputs.windows_security_query_only, true);
    assert.equal(inputs.security_query_request_json, request);
    for (const [k, v] of Object.entries(oldQueryInputs))
        assert.equal(inputs[k], v, 'Exclusive query input: ' + k);
}
export function parseQueryRequest(raw, environment) {
    assert(typeof raw === 'string' && Buffer.byteLength(raw) <= 8192);
    const r = JSON.parse(raw);
    assert.equal(JSON.stringify(r), raw, 'Canonical exact request required');
    assert.deepEqual(
        Object.keys(r).sort(),
        [
            'schema',
            'kind',
            'repository',
            'ref',
            'commit',
            'sourceSHA256',
            'policySHA256',
            'workflowSHA256',
            'lockfileSHA256',
            'diagnostic',
        ].sort(),
    );
    assert.equal(r.schema, 1);
    assert.equal(r.kind, queryPolicy.kind);
    assert.equal(r.diagnostic, true);
    assert.equal(r.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.equal(r.ref, 'refs/heads/validation/windows-metadata-3577982-20261018');
    assert.match(r.commit, /^[a-f0-9]{40}$/);
    for (const k of ['sourceSHA256', 'policySHA256', 'workflowSHA256', 'lockfileSHA256'])
        assert.match(r[k], /^[a-f0-9]{64}$/);
    assert.equal(environment.GITHUB_SHA, r.commit);
    assert.equal(environment.GITHUB_REF, r.ref);
    return Object.freeze(r);
}
export function queryHostedContext(
    env,
    {
        platform = process.platform,
        arch = process.arch,
        version = process.version,
        tmp = os.tmpdir(),
        bind = bindObservationDirectory,
    } = {},
) {
    assert.equal(platform, 'win32');
    assert.equal(arch, 'x64');
    assert.equal(version, queryPolicy.node);
    for (const [k, v] of Object.entries({
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'X64',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_ACTOR: 'brucerry',
        GITHUB_TRIGGERING_ACTOR: 'brucerry',
        GITHUB_RUN_ATTEMPT: '1',
        HUB_WINDOWS_SECURITY_QUERY_ONLY: '1',
    }))
        assert.equal(env[k], v, 'Query host ' + k);
    assert.match(env.GITHUB_RUN_ID, /^[1-9]\d{0,19}$/);
    assert.equal(env.SystemRoot?.toLowerCase(), 'c:\\windows');
    for (const k of Object.keys(env)) {
        assert(!/^(NODE_|TSX_|ESBUILD_|ELECTRON_)/i.test(k), 'Runtime override');
        assert(
            !/^HUB_/i.test(k) || k === 'HUB_WINDOWS_SECURITY_QUERY_ONLY',
            'Other Hub capability',
        );
    }
    assert(/^C:\\Users\\[^\\]+$/i.test(env.USERPROFILE));
    const expected = path.win32.join(env.USERPROFILE, 'AppData', 'Local', 'Temp');
    const bindings = [
        bind(tmp, expected),
        bind(env.TEMP, expected),
        bind(env.TMP, expected),
        bind(env.LOCALAPPDATA, path.win32.dirname(expected)),
        bind(env.USERPROFILE, env.USERPROFILE),
    ];
    const pinned = { ...env };
    return {
        parent: bindings[0].path,
        host: {
            repository: env.GITHUB_REPOSITORY,
            run: env.GITHUB_RUN_ID,
            attempt: '1',
            commit: env.GITHUB_SHA,
            actor: env.GITHUB_ACTOR,
        },
        check() {
            for (const k of Object.keys(pinned))
                assert.equal(env[k], pinned[k], 'Host environment rebound');
            assert.deepEqual(Object.keys(env).sort(), Object.keys(pinned).sort());
            for (const b of bindings) b.check();
        },
    };
}
/** Fixed phase sequence. A failed admission never advances to a later helper. */
export class QueryLifecycle {
    constructor(
        startedAt,
        {
            now = () => Number(process.hrtime.bigint() / 1000000n),
            hold = () => {},
            policy = queryPolicy,
        } = {},
    ) {
        assert(Number.isSafeInteger(startedAt) && startedAt >= 0);
        this.now = now;
        this.hold = hold;
        this.policy = policy;
        this.startedAt = startedAt;
        this.deadline = startedAt + policy.ownerMs;
        this.workDeadline = this.deadline - policy.cleanupMs;
        this.last = startedAt;
        this.cancelled = null;
        this.held = false;
        this.counts = { parent: 0, contract: 0, target: 0, node: 1 };
        this.contractClosed = false;
        this.targetAdmitted = false;
        this.workClosed = null;
        this.leafExited = false;
        this.leafClosed = false;
    }
    tick() {
        const n = this.now();
        assert(Number.isSafeInteger(n) && n >= this.last, 'Monotonic clock');
        this.last = n;
        return n;
    }
    closeWork(reason = 'Owner work deadline') {
        this.workClosed ??= String(reason).slice(0, 256);
    }
    cancel(reason) {
        this.cancelled ??= String(reason).slice(0, 256);
    }
    retain(reason) {
        if (this.held) return;
        this.held = true;
        this.cancel('Custody held');
        this.hold(reason);
    }
    check({ cleanup = false, headroom = 0 } = {}) {
        assert(!this.held, 'Query custody held');
        assert(!this.cancelled, 'Query admission cancelled');
        assert(cleanup || !this.workClosed, 'Normal query work admission closed');
        assert(
            this.tick() + headroom < (cleanup ? this.deadline : this.workDeadline),
            'Immutable query deadline',
        );
    }
    admit(kind, { cleanup = false } = {}) {
        if (cleanup)
            assert(
                kind === 'parent' &&
                    this.contractClosed &&
                    this.targetAdmitted &&
                    this.leafExited &&
                    this.leafClosed,
                'Cleanup helpers require positive leaf closure',
            );
        this.check({
            cleanup,
            headroom:
                kind === 'node' ? this.policy.queryMs + this.policy.grantMs : this.policy.queryMs,
        });
        const max = {
            parent: this.policy.parentQueries,
            contract: this.policy.contractQueries,
            target: 1,
            node: 2,
        };
        assert(this.counts[kind] < max[kind], 'Helper inventory exhausted');
        if (kind === 'target') {
            assert(this.contractClosed && !this.targetAdmitted);
            this.targetAdmitted = true;
        }
        this.counts[kind]++;
    }
    contract(result) {
        assert(
            result.passed &&
                result.casesPassed === 30 &&
                result.casesRequired === 30 &&
                result.cleanup?.removed === true &&
                result.evidenceClosure?.complete === true,
            'Fresh contract and positive cleanup required',
        );
        assert.equal(this.counts.contract, 30);
        this.contractClosed = true;
    }
    proof({ logsClosed, receiptClosed, inputsUnchanged, evidenceClosed }) {
        this.check({ cleanup: true });
        assert(
            this.contractClosed &&
                this.targetAdmitted &&
                this.leafExited &&
                this.leafClosed &&
                logsClosed &&
                receiptClosed &&
                inputsUnchanged &&
                evidenceClosed,
            'Actual closure and durable evidence required',
        );
        return {
            admissionCertain: true,
            directParentsClosed: true,
            evidenceClosed: true,
            inputsUnchanged: true,
            leafReceiptsClosed: true,
            resultClosed: true,
        };
    }
}
/** All owned files are counted once; external temp identity growth counted separately.
 * Sampled apparent bytes are not a quota, allocation bound, or inter-sample peak proof. */
export class QueryAccounting {
    constructor(
        root,
        tmp,
        {
            inventory = observationInventory,
            free = () => {
                const s = fs.statfsSync(tmp, { bigint: true });
                return Number(s.bavail * s.bsize);
            },
            policy = queryPolicy,
        } = {},
    ) {
        this.root = root;
        this.tmp = tmp;
        this.inventory = inventory;
        this.free = free;
        this.policy = policy;
        this.polls = 0;
        this.peak = 0;
        this.exclude = (p) => p === root;
        this.baseline = inventory(tmp, { exclude: this.exclude });
        assert(free() >= policy.admissionFreeBytes, '2GiB admission');
        this.scan();
    }
    scan(pending = 0) {
        assert(Number.isSafeInteger(pending) && pending >= 0);
        const p = this.policy,
            own = this.inventory(this.root),
            external = this.inventory(this.tmp, { exclude: this.exclude });
        let growth = 0;
        for (const [f, r] of external.files) {
            const b = this.baseline.files.get(f);
            growth += b?.identity === r.identity ? Math.max(0, r.bytes - b.bytes) : r.bytes;
        }
        // Every private byte is conservatively charged to both evidence and writable tree caps.
        // Reserve the complete future raw logs, ledgers and terminal/hold partition before effects.
        assert(own.bytes + pending <= p.evidenceBytes, '10MiB aggregate evidence');
        assert(own.bytes + pending <= p.treeBytes, '246MiB writable tree');
        assert(own.bytes + growth + pending <= p.jobBytes, '256MiB aggregate job');
        assert(
            own.bytes + growth + pending <= p.cohortBytes && growth <= p.cohortBytes,
            '512MiB cohort/external growth',
        );
        assert(own.files.size <= p.files && external.files.size <= p.files, '8192 file census');
        assert(this.free() >= p.stopFreeBytes, '128MiB free-space stop');
        this.polls++;
        this.peak = Math.max(this.peak, growth);
        return (this.latest = {
            ownedBytes: own.bytes,
            externalGrowthBytes: growth,
            files: own.files.size,
            pending,
            allocatedBytes: own.allocatedBytes ?? null,
        });
    }
    reserve() {
        return this.scan(
            4 * this.policy.streamBytes +
                this.policy.parentEvidenceBytes +
                this.policy.contractEvidenceBytes +
                this.policy.leafEvidenceBytes +
                this.policy.terminalBytes +
                this.policy.holdBytes +
                65536,
        );
    }
    snapshot() {
        return {
            polls: this.polls,
            externalPeakApparentBytes: this.peak,
            latest: this.latest,
            betweenPollPeakProved: false,
            filesystemQuotaClaim: false,
            scope: 'Owned tree and canonical temp growth; action internals, non-temp OS writes and unobserved peaks are not covered.',
        };
    }
}
export function bindQueryTree(root) {
    const ancestry = ancestryIdentity(root);
    return () => checkAncestry(ancestry);
}
export function verifyQueryInputs(root, request) {
    for (const [rel, expected] of [
        ['scripts/lib/security-query-diagnostic-policy.json', request.policySHA256],
        ['.github/workflows/windows-portable.yml', request.workflowSHA256],
        ['package-lock.json', request.lockfileSHA256],
    ])
        assert.equal(digest(fs.readFileSync(path.join(root, rel))), expected);
}
export function bindQueryIdentity(file) {
    const before = metadataIdentity(file);
    return () => assert.deepEqual(metadataIdentity(file), before);
}

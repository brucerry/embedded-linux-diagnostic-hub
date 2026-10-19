import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const pilotLimits = Object.freeze({
    treeBytes: 246 * 1024 ** 2,
    treeFiles: 8192,
    jobBytes: 256 * 1024 ** 2,
    cohortBytes: 512 * 1024 ** 2,
    evidenceBytes: 10 * 1024 ** 2,
    totalMs: 600000,
    reserveMs: 60000,
    ptyTestMs: 25000,
    streamBytes: 1048576,
});
export const bindingDigest = (value) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ptyObservationMode = 'pty-observation-only';
export const nativeReadinessMode = 'native-readiness';
/** A distinct binding kind prevents a native coverage capability standing in for PTY scope. */
export function pilotBindingMode(value) {
    if (value.kind === 'windows-hosted-pty-observation-v1') {
        assert.equal(value.mode, ptyObservationMode, 'Explicit PTY observation mode required.');
        assert(!('coveragePolicySHA256' in value), 'Native coverage cannot authorize PTY scope.');
        assert(/^[a-f0-9]{64}$/.test(value.scopeSHA256));
        return ptyObservationMode;
    }
    assert.equal(value.kind, 'windows-hosted-native-readiness-pilot-v1');
    assert(value.mode === undefined || value.mode === nativeReadinessMode);
    assert(!('scopeSHA256' in value), 'PTY scope cannot authorize native work.');
    return nativeReadinessMode;
}
export function pilotStages(binding) {
    return Object.freeze(
        pilotBindingMode(binding) === ptyObservationMode
            ? ['real-os-pty']
            : ['real-os-pty', 'native-electron-store'],
    );
}
export function validatePilotBinding(value, now, cleanup = false) {
    assert.equal(value.schema, 1);
    const mode = pilotBindingMode(value);
    assert.equal(value.collectionApproval, false);
    assert.equal(value.host.repository, 'brucerry/embedded-linux-diagnostic-hub');
    assert.equal(value.host.attempt, '1');
    assert.equal(value.host.environment, 'github-hosted');
    assert(/^[1-9]\d{0,19}$/.test(value.host.run));
    assert(/^[a-f0-9]{40}$/.test(value.host.commit));
    assert(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.nonce),
    );
    assert(/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(value.principalSID));
    for (const field of [
        'sourceSHA256',
        ...(mode === ptyObservationMode ? ['scopeSHA256'] : ['coveragePolicySHA256']),
        'pilotPolicySHA256',
        'dependenciesSHA256',
    ])
        assert(/^[a-f0-9]{64}$/.test(value[field]));
    for (const key of [
        'node',
        'tsx',
        ...(mode === ptyObservationMode ? [] : ['electron']),
        'powershell',
        'git',
        'bash',
        'cygpath',
        'winptyDll',
        'winptyAgent',
    ]) {
        const row = value.runtime[key];
        assert(row && /^[a-f0-9]{64}$/.test(row.sha256) && /^[A-Za-z]:\\/.test(row.path));
    }
    assert.equal(value.runtime.node.version, 'v24.22.0');
    if (mode === ptyObservationMode)
        assert(!('electron' in value.runtime), 'PTY-only has no Electron runtime.');
    else assert.equal(value.runtime.electron.version, '44.5.1');
    assert.equal(value.runtime.arch, 'x64');
    assert.equal(value.runtime.platform, 'win32');
    for (const key of ['canonicalTemp', 'privateRoot', 'evidenceRoot']) {
        const row = value.roots[key];
        assert(row && /^[A-Za-z]:\\/.test(row.path));
        assert.equal(path.win32.normalize(row.path), row.path);
        assert(!/[\0\r\n"]/.test(row.path));
        assert(
            /^\d+$/.test(row.dev) &&
                /^[1-9]\d*$/.test(row.ino) &&
                /^[a-f0-9]{64}$/.test(
                    key === 'evidenceRoot' ? row.identitySHA256 : row.descriptorSHA256,
                ),
        );
    }
    const parent = value.roots.canonicalTemp.path.replace(/\\$/, '');
    assert(/^C:\\Users\\[^\\]+\\AppData\\Local\\Temp$/i.test(parent));
    assert(
        value.roots.privateRoot.path === parent + '\\diagnostic-hub-native-pilot-' + value.nonce,
    );
    assert(Number.isSafeInteger(value.startedAt) && value.startedAt <= now);
    assert.equal(value.deadline - value.startedAt, pilotLimits.totalMs);
    assert(
        now < value.deadline - (cleanup ? 0 : pilotLimits.reserveMs),
        cleanup ? 'Pilot cleanup deadline expired.' : 'Pilot work admission expired.',
    );
    assert.deepEqual(value.limits, pilotLimits);
    return value;
}
/** Conservative pre-write reservations; observations never manufacture headroom or certify unknown writers. */
export class PilotSpaceLedger {
    constructor() {
        this.bytes = 0;
        this.files = 0;
        this.evidence = 0;
        this.reservations = [];
    }
    reserve({ writer, bytes, files, reviewedPrewriteBound }) {
        assert(typeof writer === 'string' && writer.length <= 128);
        assert.equal(
            reviewedPrewriteBound,
            true,
            'Unbounded/native writer needs separate reviewed pre-write/overshoot basis.',
        );
        assert(
            Number.isSafeInteger(bytes) && bytes >= 0 && Number.isSafeInteger(files) && files >= 0,
        );
        assert(
            this.bytes + bytes <= pilotLimits.treeBytes &&
                this.files + files <= pilotLimits.treeFiles,
        );
        assert(this.bytes + bytes + this.evidence <= pilotLimits.jobBytes);
        this.bytes += bytes;
        this.files += files;
        const token = Object.freeze({ writer, bytes, files });
        this.reservations.push(token);
        return token;
    }
    reserveEvidence(bytes) {
        assert(
            Number.isSafeInteger(bytes) &&
                bytes >= 0 &&
                this.evidence + bytes <= pilotLimits.evidenceBytes,
        );
        assert(this.bytes + this.evidence + bytes <= pilotLimits.jobBytes);
        this.evidence += bytes;
    }
    observe({ bytes, files, scanMs, gapMs }) {
        for (const n of [bytes, files, scanMs, gapMs]) assert(Number.isSafeInteger(n) && n >= 0);
        assert(
            bytes <= this.bytes && files <= this.files,
            'Observed output exceeded pre-write reservation.',
        );
        return {
            bytes,
            files,
            scanMs,
            gapMs,
            reservedBytes: this.bytes,
            reservedFiles: this.files,
            reservedHeadroom: this.bytes - bytes,
            observerOnlyCannotQualifyNativeWriters: true,
        };
    }
    snapshot() {
        return {
            reservedTreeBytes: this.bytes,
            reservedTreeFiles: this.files,
            evidenceBytes: this.evidence,
            jobCharge: this.bytes + this.evidence,
            cohortCharge: this.bytes + this.evidence,
        };
    }
}
/** Pilot-only selector. This does not authorize collection or certify native capacity. */
export function requirePilotRuntimeReady(env = process.env) {
    assert.equal(env.HUB_WINDOWS_NATIVE_PILOT, '1', 'Separate native pilot selector required.');
    assert.notEqual(
        env.HUB_WINDOWS_PTY_OBSERVATION_ONLY,
        '1',
        'PTY-only cannot launch native work.',
    );
    assert.notEqual(
        env.HUB_WINDOWS_PILOT_WINPS_CONTRACT,
        '1',
        'WinPS-only contract cannot launch native work.',
    );
    assert.notEqual(
        env.HUB_WINDOWS_PREFLIGHT_ONLY,
        '1',
        'Metadata-only cannot launch native work.',
    );
}
export function requirePilotMode(mode, env = process.env) {
    if (mode === nativeReadinessMode) return requirePilotRuntimeReady(env);
    assert.equal(mode, ptyObservationMode, 'Recognized pilot mode required.');
    assert.equal(env.HUB_WINDOWS_PTY_OBSERVATION_ONLY, '1', 'Separate PTY-only selector required.');
    for (const key of [
        'HUB_WINDOWS_NATIVE_PILOT',
        'HUB_WINDOWS_PREFLIGHT_ONLY',
        'HUB_WINDOWS_PILOT_WINPS_CONTRACT',
    ])
        assert.notEqual(env[key], '1', 'PTY-only selectors must be exclusive: ' + key);
}
/** Called before a stage starts its runtime worker or imports either workload. */
export function requirePilotStage(
    binding,
    stage,
    env = process.env,
    now = Number(process.hrtime.bigint() / 1000000n),
) {
    validatePilotBinding(binding, now);
    requirePilotMode(pilotBindingMode(binding), env);
    assert(pilotStages(binding).includes(stage), 'Stage excluded by immutable pilot mode.');
}

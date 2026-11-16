// Pure orchestration/reporting only. Injected ports are not authenticated evidence.
export const CACHE_BRANCH = 'refs/heads/ci/v060-macos-cache-metadata-20261116';
export const CACHE_WORKFLOW = '.github/workflows/macos-cache-metadata.yml';
export const CACHE_REPOSITORY = 'brucerry/embedded-linux-diagnostic-hub';
export const CACHE_REASONS = Object.freeze([
    'context',
    'path',
    'unsafe',
    'incomplete',
    'architecture',
    'changed',
    'read-failed',
    'scope',
    'budget',
    'dependency',
    'short-read',
    'closure-unknown',
    'stopped',
]);
export const ENTRY_REASONS = Object.freeze([
    'entry-context',
    'entry-runtime',
    'entry-source',
    'entry-source-custody',
    'entry-inspection',
    'entry-summary',
    'entry-report',
]);
const custodyKinds = ['NO_DESCRIPTOR', 'CLOSED', 'RETAINED_UNKNOWN', 'NOT_OBSERVED'];
const flags = Object.freeze({
    nativeQualification: false,
    releaseAcceptance: false,
    binaryAuthenticated: false,
    actualRuntimeVersion: 'unverified',
    hostedProvenance: 'unverified',
});
export class ObservationFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const report = (status, reason, custody) => Object.freeze({ status, reason, custody, ...flags });
export const unobservedReport = (reason = 'entry-report', custody = 'NOT_OBSERVED') =>
    report('NOT_OBSERVED', ENTRY_REASONS.includes(reason) ? reason : 'entry-report', custody);

export function observationContext(config, identity) {
    const hex = (x) => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
    if (
        !config ||
        !identity ||
        config.repository !== CACHE_REPOSITORY ||
        config.repositoryId !== '1405501450' ||
        config.private !== 'false' ||
        config.actions !== 'true' ||
        config.event !== 'push' ||
        config.ref !== CACHE_BRANCH ||
        config.attempt !== '1' ||
        !/^[1-9][0-9]{0,19}$/.test(config.runId ?? '') ||
        config.job !== 'cache_metadata' ||
        config.workflowRef !== `${CACHE_REPOSITORY}/${CACHE_WORKFLOW}@${CACHE_BRANCH}` ||
        !hex(config.sha) ||
        config.workflowSHA !== config.sha ||
        config.runnerEnvironment !== 'github-hosted' ||
        config.runnerOS !== 'macOS' ||
        !['x64', 'arm64'].includes(config.arch) ||
        config.runnerArch !== (config.arch === 'x64' ? 'X64' : 'ARM64') ||
        config.startup?.BASH_ENV !== '/dev/null' ||
        config.startup?.ENV !== '/dev/null' ||
        config.startup?.NODE_OPTIONS !== '--no-addons' ||
        config.startup?.NODE_PATH !== '' ||
        config.startup?.NODE_COMPILE_CACHE !== '' ||
        config.startup?.NODE_DISABLE_COMPILE_CACHE !== '1' ||
        config.startup?.ESBUILD_BINARY_PATH !== ''
    )
        return 'entry-context';
    if (
        identity.platform !== 'darwin' ||
        identity.arch !== config.arch ||
        typeof identity.node !== 'string' ||
        !/^24\.\d+\.\d+$/.test(identity.node) ||
        !Number.isSafeInteger(identity.uid) ||
        identity.uid <= 0 ||
        identity.euid !== identity.uid
    )
        return 'entry-runtime';
    return null;
}

export function summarizeObservation(value) {
    const r = value?.resources;
    if (
        !r ||
        !['filesystemCalls', 'opened', 'closed', 'confirmedBytes', 'retainedUnknown'].every(
            (k) => Number.isSafeInteger(r[k]) && r[k] >= 0,
        ) ||
        r.filesystemCalls > 4097 ||
        r.opened > 1 ||
        r.closed > r.opened ||
        r.confirmedBytes > 32 ||
        r.retainedUnknown !== r.opened - r.closed ||
        typeof r.closeFailed !== 'boolean' ||
        r.closeFailed !== r.retainedUnknown > 0 ||
        (r.confirmedBytes > 0 && r.opened !== 1) ||
        Object.entries(flags).some(([key, expected]) => value[key] !== expected)
    )
        return unobservedReport('entry-summary');
    const custody = r.retainedUnknown ? 'RETAINED_UNKNOWN' : r.opened ? 'CLOSED' : 'NO_DESCRIPTOR';
    if (
        value.status === 'CACHE_METADATA_CANDIDATE' &&
        value.reason === 'none' &&
        r.opened === 1 &&
        r.closed === 1 &&
        r.confirmedBytes === 32 &&
        !r.closeFailed
    )
        return report(value.status, 'none', 'CLOSED');
    if (value.status === 'REFUSED' && CACHE_REASONS.includes(value.reason))
        return report('REFUSED', value.reason, custody);
    return unobservedReport('entry-summary', custody);
}

export async function collectCacheObservation(config, identity, ports) {
    const context = observationContext(config, identity);
    if (context) return unobservedReport(context);
    try {
        await ports.verifySources();
    } catch (error) {
        return error instanceof ObservationFailure && error.code === 'entry-source-custody'
            ? unobservedReport('entry-source-custody', 'RETAINED_UNKNOWN')
            : unobservedReport('entry-source');
    }
    try {
        return summarizeObservation(await ports.inspect(config.arch));
    } catch {
        return unobservedReport('entry-inspection');
    }
}

export function finiteReport(value) {
    if (
        !value ||
        Object.entries(flags).some(([k, v]) => value[k] !== v) ||
        !custodyKinds.includes(value.custody)
    )
        return false;
    if (value.status === 'CACHE_METADATA_CANDIDATE')
        return value.reason === 'none' && value.custody === 'CLOSED';
    if (value.status === 'REFUSED')
        return CACHE_REASONS.includes(value.reason) && value.custody !== 'NOT_OBSERVED';
    return value.status === 'NOT_OBSERVED' && ENTRY_REASONS.includes(value.reason);
}

export function encodeObservationOutput(value) {
    if (!finiteReport(value)) throw new ObservationFailure('entry-report');
    // Marker last; actual step success additionally requires confirmed output close.
    const text = `status=${value.status}\nreason=${value.reason}\ncustody=${value.custody}\nvalid=1\n`;
    if (Buffer.byteLength(text) >= 1024) throw new ObservationFailure('entry-report');
    return text;
}

export function reportFromStep(step) {
    if (step?.outcome !== 'success' || step.valid !== '1') return unobservedReport();
    const value = report(step.status, step.reason, step.custody);
    return finiteReport(value) ? value : unobservedReport();
}

export function observationLabel(arch, value) {
    if (!['x64', 'arm64'].includes(arch) || !finiteReport(value))
        throw new ObservationFailure('entry-report');
    return `Cache ${arch} — ${value.status} / ${value.reason} / ${value.custody}`;
}

// Testable orchestration; no default IO/identity. A fixture cannot issue CI proof.
export async function executeObservation(mode, config, identity, ports, step) {
    if (mode === 'report') {
        const value = reportFromStep(step);
        return observationContext(config, identity) === null &&
            value.status === 'CACHE_METADATA_CANDIDATE'
            ? 0
            : 1;
    }
    if (mode !== 'observe') return 1;
    const value = await collectCacheObservation(config, identity, ports);
    try {
        if ((await ports.writeOutput(encodeObservationOutput(value))) !== undefined) return 1;
    } catch {
        return 1;
    }
    return 0;
}

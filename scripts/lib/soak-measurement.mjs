// @ts-nocheck
import assert from 'node:assert/strict';
export const soakMeasurementContract = Object.freeze({
    schema: 2,
    slopeUnit: 'bytes-per-comparable-checkpoint',
    spacingMs: 250,
    warm: 3,
    measured: 3,
    maxSeries: 1024,
    maxProcessInstances: 256,
    ephemeralRoles: Object.freeze([
        'electron-renderer',
        'electron-GPU',
        'electron-Utility',
        'owned-descendant',
        'fixture-root',
    ]),
    ephemeralMeaning:
        'Real three spaced warm and measured checkpoints within the same actual PID/creation lifetime. No cross-process/cross-cycle retention claim for a replaced process.',
});
const metrics = ['heapUsedBytes', 'arrayBuffersBytes', 'externalBytes', 'rssBytes'];
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
/** Calibration and enforcement share this threshold-independent completeness gate. */
export class MatchedCheckpoints {
    constructor(roles) {
        assert(
            Array.isArray(roles) &&
                roles.length &&
                roles.length <= 256 &&
                roles.every(
                    (role) => typeof role === 'string' && role.length && role.length <= 128,
                ) &&
                new Set(roles).size === roles.length,
            'Checkpoint role declaration',
        );
        this.roles = new Set(roles);
        this.contract = soakMeasurementContract;
        this.series = new Map();
        this.instances = new Set();
        this.unavailable = new Map();
        this.lastGlobalOrdinal = -1;
        this.lastWindowEnd = null;
        this.failure = null;
    }
    guard(work) {
        if (this.failure) throw this.failure;
        try {
            return work();
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }
    keys(samples, state) {
        assert(
            typeof state === 'string' &&
                state.length &&
                state.length <= 128 &&
                Array.isArray(samples) &&
                samples.length <= 256 &&
                samples.length,
            'Checkpoint state/sample bound',
        );
        const result = [],
            identities = new Set();
        for (const s of samples) {
            assert(
                Number.isSafeInteger(s.pid) &&
                    s.pid > 0 &&
                    typeof s.created === 'string' &&
                    s.created.length &&
                    s.created.length <= 512 &&
                    this.roles.has(s.role) &&
                    ['running', 'terminated'].includes(s.state),
                'Checkpoint process identity',
            );
            const instance = JSON.stringify([s.pid, s.created, s.role]);
            assert(!identities.has(instance), 'Duplicate process in checkpoint');
            identities.add(instance);
            this.instances.add(instance);
            assert(
                this.instances.size <= this.contract.maxProcessInstances,
                'Checkpoint process history bound',
            );
            for (const metric of metrics) {
                const value = s[metric];
                if (s.state === 'terminated') {
                    assert(value === null, 'Terminated memory is not zero');
                    continue;
                }
                if (value === null) {
                    assert(
                        Array.isArray(s.unsupported) &&
                            s.unsupported.length &&
                            s.unsupported.every(
                                (reason) => typeof reason === 'string' && reason.length,
                            ),
                        'Unavailable metric requires reason',
                    );
                    this.unavailable.set(
                        JSON.stringify([s.role, metric]),
                        s.unsupported.join('; ').slice(0, 512),
                    );
                    assert(
                        this.unavailable.size <= this.contract.maxSeries,
                        'Unavailable metric scope bound',
                    );
                    continue;
                }
                assert(nonnegativeInteger(value), 'Checkpoint metric value');
                result.push({
                    key: JSON.stringify([state, s.pid, s.created, s.role, metric]),
                    s,
                    metric,
                });
            }
        }
        return result;
    }
    needsWarm(samples, state) {
        return this.guard(() =>
            this.keys(samples, state).filter(
                ({ key }) => (this.series.get(key)?.warm ?? 0) < this.contract.warm,
            ),
        );
    }
    visit(samples, state, phase, window) {
        return this.guard(() => {
            assert(['warmup', 'ephemeral-warm', 'measured'].includes(phase), 'Checkpoint phase');
            assert(
                window?.clockDomain === 'node-performance' &&
                    Number.isFinite(window.startMono) &&
                    window.startMono >= 0 &&
                    Number.isFinite(window.endMono) &&
                    window.endMono >= window.startMono,
                'Checkpoint monotonic window',
            );
            assert(
                nonnegativeInteger(window.globalOrdinal) &&
                    window.globalOrdinal > this.lastGlobalOrdinal,
                'Checkpoint global ordinal must increase',
            );
            if (this.lastWindowEnd !== null)
                assert(
                    window.startMono - this.lastWindowEnd >= this.contract.spacingMs,
                    'Checkpoints must be genuinely spaced',
                );
            for (const { key, s, metric } of this.keys(samples, state)) {
                let item = this.series.get(key);
                if (!item) {
                    item = {
                        key,
                        role: s.role,
                        metric,
                        pid: s.pid,
                        created: s.created,
                        warm: 0,
                        measured: 0,
                        lastEnd: null,
                        firstGlobalOrdinal: window.globalOrdinal,
                        lastGlobalOrdinal: window.globalOrdinal,
                        firstStartMono: window.startMono,
                        lastEndMono: window.endMono,
                        kind: this.contract.ephemeralRoles.includes(s.role)
                            ? 'lifecycle-local'
                            : 'stable-process',
                    };
                    this.series.set(key, item);
                    assert(this.series.size <= this.contract.maxSeries, 'Checkpoint series bound');
                }
                if (phase === 'ephemeral-warm')
                    assert(
                        item.kind === 'lifecycle-local' && item.measured === 0,
                        'Stable series cannot borrow new measured warmup',
                    );
                if (phase === 'measured') {
                    assert(
                        item.warm >= this.contract.warm,
                        'Missing three exact matched warm checkpoints',
                    );
                    item.measured++;
                } else item.warm = Math.min(this.contract.warm, item.warm + 1);
                item.lastEnd = window.endMono;
                item.lastEndMono = window.endMono;
                item.lastGlobalOrdinal = window.globalOrdinal;
            }
            this.lastGlobalOrdinal = window.globalOrdinal;
            this.lastWindowEnd = window.endMono;
        });
    }
    fork() {
        if (this.failure) throw this.failure;
        const next = new MatchedCheckpoints([...this.roles]);
        next.series = new Map([...this.series].map(([key, value]) => [key, { ...value }]));
        next.instances = new Set(this.instances);
        next.unavailable = new Map(this.unavailable);
        next.lastGlobalOrdinal = this.lastGlobalOrdinal;
        next.lastWindowEnd = this.lastWindowEnd;
        return next;
    }
    finish() {
        return this.guard(() => {
            const measured = [...this.series.values()].filter((s) => s.measured);
            assert(measured.length, 'No measured comparable series');
            assert(
                measured.every(
                    (s) => s.warm >= this.contract.warm && s.measured >= this.contract.measured,
                ),
                'Fewer than three matched warm/measured checkpoints',
            );
            for (const role of this.roles)
                assert(
                    measured.some((s) => s.role === role),
                    'Declared role never measured: ' + role,
                );
            return {
                schema: 2,
                complete: true,
                slopeUnit: this.contract.slopeUnit,
                series: measured.map((s) => ({ ...s })),
                unavailable: [...this.unavailable].map(([key, reason]) => ({ key, reason })),
                processInstances: this.instances.size,
            };
        });
    }
}
export function assertSoakGcCapability(mode, identity, gc) {
    assert(['normal', 'forced'].includes(mode));
    assert(
        Array.isArray(identity?.execArgv) &&
            identity.execArgv.every((flag) => typeof flag === 'string'),
        'GC launch identity requires execArgv',
    );
    if (mode === 'forced') {
        assert(typeof gc === 'function', 'Forced harness GC unavailable before payload');
        assert(
            identity.execArgv.includes('--expose-gc'),
            'Forced launch identity missing expose-gc',
        );
    }
    return {
        mode,
        forcedCalls: 0,
        execArgv: [...identity.execArgv],
        available: mode === 'normal' || typeof gc === 'function',
    };
}

/** Read windows describe actual serialized work, including slow reads and coalesced requests. */
export class SamplingWindows {
    constructor() {
        this.count = 0;
        this.lastEnd = null;
        this.totals = null;
        this.failure = null;
        this.totalReadMs = 0;
        this.maxReadMs = 0;
    }
    guard(work) {
        if (this.failure) throw this.failure;
        try {
            return work();
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }
    counts(value) {
        assert(value && typeof value === 'object' && !Array.isArray(value), 'Sampling counters');
        assert.deepEqual(
            Object.keys(value).sort(),
            ['requests', 'attempted', 'usable', 'unavailable', 'coalesced'].sort(),
            'Sampling counter keys',
        );
        assert(Object.values(value).every(nonnegativeInteger), 'Sampling integer counters');
        assert(
            value.usable + value.unavailable === value.attempted &&
                value.requests >= value.attempted + value.coalesced,
            'Sampling counter conservation',
        );
    }
    accept(data) {
        return this.guard(() => {
            assert(
                data?.schema === 1 &&
                    data.clockDomain === 'node-performance' &&
                    data.attempt === this.count + 1 &&
                    typeof data.quiescent === 'boolean' &&
                    typeof data.forceGc === 'boolean' &&
                    (!data.forceGc || data.quiescent) &&
                    Number.isFinite(data.readStartedMono) &&
                    data.readStartedMono >= 0 &&
                    Number.isFinite(data.readEndedMono) &&
                    data.readEndedMono >= data.readStartedMono &&
                    (this.lastEnd === null || data.readStartedMono >= this.lastEnd),
                'Invalid sampling read window',
            );
            assert(['usable', 'unavailable'].includes(data.status), 'Sampling status');
            if (data.status === 'unavailable')
                assert(
                    typeof data.error === 'string' &&
                        data.error.length &&
                        data.error.length <= 4096,
                    'Unavailable sample reason',
                );
            this.counts(data.counts);
            assert(data.counts.attempted === data.attempt, 'Sampling attempt counter');
            const previous = this.totals ?? {
                requests: 0,
                attempted: 0,
                usable: 0,
                unavailable: 0,
                coalesced: 0,
            };
            for (const key of Object.keys(previous))
                assert(data.counts[key] >= previous[key], 'Sampling counter regression');
            assert(
                data.counts.usable - previous.usable === (data.status === 'usable' ? 1 : 0) &&
                    data.counts.unavailable - previous.unavailable ===
                        (data.status === 'unavailable' ? 1 : 0),
                'Sampling status counter',
            );
            this.firstStart ??= data.readStartedMono;
            this.lastEnd = data.readEndedMono;
            this.count++;
            this.totals = { ...data.counts };
            const duration = data.readEndedMono - data.readStartedMono;
            this.totalReadMs += duration;
            this.maxReadMs = Math.max(this.maxReadMs, duration);
        });
    }
    fork() {
        if (this.failure) throw this.failure;
        const next = Object.assign(new SamplingWindows(), this);
        next.totals = this.totals ? { ...this.totals } : null;
        return next;
    }
    finish(counts) {
        return this.guard(() => {
            this.counts(counts);
            assert(
                this.count > 0 && counts.requests === counts.attempted + counts.coalesced,
                'Sampling final request conservation',
            );
            assert(
                counts.attempted === this.count &&
                    counts.usable === this.count &&
                    counts.unavailable === 0,
                'Incomplete or unavailable sampling',
            );
            for (const key of ['requests', 'coalesced'])
                assert(counts[key] >= this.totals[key], 'Sampling final counter regression');
            return {
                actualReadWindows: this.count,
                requests: counts.requests,
                coalesced: counts.coalesced,
                firstStartMono: this.firstStart,
                lastEndMono: this.lastEnd,
                totalReadMs: this.totalReadMs,
                maxReadMs: this.maxReadMs,
                clockDomain: 'node-performance',
                cadenceMeaning:
                    '250 ms target; actual read durations and coalesced requests remain explicit.',
            };
        });
    }
}

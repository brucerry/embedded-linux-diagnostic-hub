import assert from 'node:assert/strict';
import path from 'node:path';
const events = Object.freeze([
    'stdin-finish',
    'stdin-close',
    'stdout-end',
    'stdout-close',
    'stderr-end',
    'stderr-close',
    'channel-end',
    'channel-close',
    'channel-drain',
    'write-false',
    'stdout-pause',
    'stdout-resume',
    'stdout-data',
    'stderr-data',
    'stop-requested',
    'process-exit',
    'outer-close',
    'fixture-join',
    'fixture-timeout',
    'fixture-failure',
    'input-discard',
]);
const bool = (value) => (typeof value === 'boolean' ? value : null);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
function stream(value) {
    return {
        paused: typeof value?.isPaused === 'function' ? bool(value.isPaused()) : null,
        flowing: bool(value?.readableFlowing),
        readableLength: count(value?.readableLength),
        readableEnded: bool(value?.readableEnded),
        destroyed: bool(value?.destroyed),
        closed: bool(value?.closed),
        writableLength: count(value?.writableLength),
        writableEnded: bool(value?.writableEnded),
        writableFinished: bool(value?.writableFinished),
    };
}
/** Fixed counters and16 prefix events; at most4 terminal frames, never a closure capability.
 * @param {{child:any, channel:any, identity?:()=>any, stopping:()=>boolean, emit:(data:any)=>any, hold:(error:any)=>void, clock?:()=>number}} options
 */
export function ptyTerminalObservation({
    child,
    channel,
    identity = () => null,
    stopping,
    emit,
    hold,
    clock = () => performance.now(),
}) {
    const counters = Object.fromEntries(events.map((e) => [e, 0]));
    const trace = [],
        sent = new Set();
    let sequence = 0,
        overflow = 0,
        observed = 0,
        discarded = 0,
        handedToChannel = 0,
        stderrBytes = 0,
        discardedInput = 0;
    const lastEvents = {},
        lastData = {},
        lastTransitions = {};
    const channelState = () => ({
        destroyed: bool(channel.destroyed),
        writable: bool(channel.writable),
        writableEnded: bool(channel.writableEnded),
        outgoingState:
            typeof channel.outgoing?.state === 'string'
                ? channel.outgoing.state.slice(0, 32)
                : null,
    });
    /** @param {string} type @param {{bytes?:number,disposition?:string}} details */
    const event = (type, { bytes = 0, disposition } = {}) => {
        try {
            assert(events.includes(type), 'Unknown PTY terminal event');
            assert(Number.isSafeInteger(bytes) && bytes >= 0);
            assert(Number.isSafeInteger(++sequence));
            assert(Number.isSafeInteger(++counters[type]));
            if (type === 'stdout-data') {
                observed += bytes;
                if (disposition === 'discarded') discarded += bytes;
                else if (disposition === 'channel-write') handedToChannel += bytes;
            }
            if (type === 'stderr-data') stderrBytes += bytes;
            assert([observed, discarded, handedToChannel, stderrBytes].every(Number.isSafeInteger));
            const row = {
                sequence,
                at: clock(),
                type,
                bytes,
                ...(disposition ? { disposition } : {}),
            };
            lastEvents[type] = [sequence, row.at, bytes];
            if (type === 'input-discard') discardedInput += bytes;
            if (type === 'stdout-data' || type === 'stderr-data')
                lastData[type] = {
                    sequence,
                    at: row.at,
                    bytes,
                    state: stream(type === 'stdout-data' ? child.stdout : child.stderr),
                    channel: channelState(),
                    stopRequested: Boolean(stopping()),
                };
            if (
                [
                    'channel-end',
                    'channel-close',
                    'channel-drain',
                    'write-false',
                    'stdout-pause',
                    'stdout-resume',
                ].includes(type)
            )
                lastTransitions[type] = {
                    sequence,
                    at: row.at,
                    stdout: stream(child.stdout),
                    channel: channelState(),
                    stopRequested: Boolean(stopping()),
                };
            if (trace.length < 16) trace.push(row);
            else overflow++;
        } catch (e) {
            hold(e);
        }
    };
    const snapshot = (phase, extra = {}) => {
        try {
            assert(['stop', 'exit', 'close', 'final'].includes(phase));
            if (sent.has(phase)) return;
            sent.add(phase);
            const id = identity();
            const data = {
                schema: 1,
                kind: 'pty-terminal-observation',
                phase,
                clockDomain: 'node-performance',
                at: clock(),
                pid: child.pid ?? null,
                created:
                    typeof id?.created === 'string' && id.created.length <= 128 ? id.created : null,
                identityAvailable: Boolean(id?.created),
                stopRequested: Boolean(stopping()),
                streams: {
                    stdin: stream(child.stdin),
                    stdout: stream(child.stdout),
                    stderr: stream(child.stderr),
                },
                channel: {
                    ...stream(channel),
                    writable: bool(channel.writable),
                    outgoingState:
                        typeof channel.outgoing?.state === 'string'
                            ? channel.outgoing.state.slice(0, 32)
                            : null,
                },
                counters: { ...counters },
                bytes: {
                    observedStdout: observed,
                    discardedStdout: discarded,
                    handedToChannel,
                    stderr: stderrBytes,
                    discardedInput,
                },
                lastEvents: { ...lastEvents },
                lastData: structuredClone(lastData),
                lastTransitions: structuredClone(lastTransitions),
                trace: [...trace],
                traceOverflow: overflow,
                traceComplete: overflow === 0,
                sequence,
                ...extra,
                closureProven: false,
                authority:
                    'Observation only; sticky hold and actual closure gates remain unchanged.',
            };
            assert(Buffer.byteLength(JSON.stringify(data)) <= 8192, 'PTY terminal frame bound');
            void Promise.resolve(emit(data)).catch(hold);
        } catch (e) {
            hold(e);
        }
    };
    for (const [value, pairs] of [
        [
            child.stdin,
            [
                ['finish', 'stdin-finish'],
                ['close', 'stdin-close'],
            ],
        ],
        [
            child.stdout,
            [
                ['end', 'stdout-end'],
                ['close', 'stdout-close'],
                ['pause', 'stdout-pause'],
                ['resume', 'stdout-resume'],
            ],
        ],
        [
            child.stderr,
            [
                ['end', 'stderr-end'],
                ['close', 'stderr-close'],
            ],
        ],
    ])
        for (const [name, label] of pairs) value?.on(name, () => event(label));
    return Object.freeze({ event, snapshot });
}

/** Same-helper call observation, never a compiler-cause or process-closure attestation. */
export function ptyCompileObservation(stderr, expectedPID) {
    const lines = stderr
        .split(/\r?\n/)
        .slice(0, -1)
        .filter((line) => line.startsWith('HUB_OS_PTY_COMPILE '));
    if (!lines.length) return undefined;
    assert.equal(lines.length, 1, 'One compile observation per helper invocation');
    const raw = lines[0].slice('HUB_OS_PTY_COMPILE '.length);
    assert(Buffer.byteLength(raw) <= 8192, 'Compile frame bound');
    const data = JSON.parse(raw);
    assert.equal(data.schema, 1);
    assert.equal(data.kind, 'pty-compile-observation');
    assert.equal(data.clockDomain, 'helper-stopwatch');
    assert.equal(data.pid, expectedPID);
    const ticks = (value) => {
        assert(typeof value === 'string' && /^[0-9]{1,20}$/.test(value), 'Compile tick schema');
        return BigInt(value);
    };
    assert(ticks(data.frequency) > 0n);
    assert(ticks(data.callEnd) >= ticks(data.callStart));
    assert(ticks(data.beforeLoggingEnd) >= ticks(data.beforeLoggingStart));
    assert(ticks(data.beforeLoggingEnd) <= ticks(data.callStart));
    assert(typeof data.callSucceeded === 'boolean');
    if (data.callSucceeded) {
        assert.equal(data.callError, null);
        assert(ticks(data.afterLoggingStart) >= ticks(data.callEnd));
        assert(ticks(data.afterLoggingEnd) >= ticks(data.afterLoggingStart));
    } else {
        assert.equal(data.afterLoggingStart, null);
        assert.equal(data.afterLoggingEnd, null);
        assert(typeof data.callError === 'string' && data.callError.length <= 1024);
    }
    for (const cpu of [data.cpuBefore, data.cpuAfter]) {
        assert(cpu && typeof cpu.available === 'boolean');
        if (cpu.available) {
            for (const k of ['totalTicks', 'userTicks', 'kernelTicks', 'sampledAt']) ticks(cpu[k]);
        } else {
            assert(typeof cpu.reason === 'string' && cpu.reason.length <= 512);
            assert(!('totalTicks' in cpu), 'Unavailable CPU cannot invent zero');
        }
    }
    if (data.cpuBefore.available) {
        assert(ticks(data.cpuBefore.sampledAt) <= ticks(data.callStart));
    }
    if (data.cpuAfter.available) {
        assert(ticks(data.cpuAfter.sampledAt) >= ticks(data.callEnd));
    }
    if (data.cpuBefore.available && data.cpuAfter.available)
        for (const k of ['totalTicks', 'userTicks', 'kernelTicks'])
            assert(ticks(data.cpuAfter[k]) >= ticks(data.cpuBefore[k]));
    assert(data.createdFileTime === null || /^[1-9][0-9]{0,19}$/.test(data.createdFileTime));
    assert(ticks(data.identityCaptureEnd) >= ticks(data.identityCaptureStart));
    if (data.loadedAssemblies !== null) {
        assert(Array.isArray(data.loadedAssemblies) && data.loadedAssemblies.length === 4);
        const names = new Set();
        for (const row of data.loadedAssemblies) {
            assert(
                [
                    'System.Management.Automation',
                    'System.Private.CoreLib',
                    'Microsoft.CodeAnalysis',
                    'Microsoft.CodeAnalysis.CSharp',
                ].includes(row.name) && !names.has(row.name),
            );
            names.add(row.name);
            if (row.available) {
                assert(typeof row.fullName === 'string' && row.fullName.length <= 1024);
                assert(
                    typeof row.moduleVersionId === 'string' &&
                        /^[a-f0-9-]{36}$/i.test(row.moduleVersionId),
                );
                assert.equal(row.physicalIdentity?.available, false);
                assert(
                    typeof row.physicalIdentity.reason === 'string' &&
                        row.physicalIdentity.reason.length <= 512,
                );
                for (const key of ['path', 'bytes', 'sha256'])
                    assert(!(key in row), 'No physical assembly identity read');
            } else assert(typeof row.reason === 'string' && row.reason.length <= 512);
        }
    }
    assert(
        data.powershellFile &&
            path.win32.isAbsolute(data.powershellFile.path) &&
            /^[a-f0-9]{64}$/.test(data.powershellFile.sha256),
    );
    for (const key of ['powershellVersion', 'edition', 'dotnetVersion'])
        assert(typeof data[key] === 'string' && data[key].length > 0 && data[key].length <= 64);
    assert(
        Number.isSafeInteger(data.processorCount) &&
            data.processorCount > 0 &&
            data.processorCount <= 1024,
    );
    assert(data.hostLoad?.available === false, 'No additional host-load authority');
    return data;
}

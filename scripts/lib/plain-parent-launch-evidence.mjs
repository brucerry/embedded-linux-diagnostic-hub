import assert from 'node:assert/strict';
import path from 'node:path';

const capabilities = new WeakMap();
export const plainParentEvidenceLimits = Object.freeze({ inputBytes: 256, resultBytes: 1024 });
const inputUnavailable = Object.freeze({ schema: 1, available: false });
const resultUnavailable = Object.freeze({
    schema: 1,
    kind: 'first-plain-parent-return',
    available: false,
    actualExitOrPipeCloseObserved: false,
});
const tick = (clock) => {
    try {
        const n = clock();
        return Number.isSafeInteger(n) && n >= 0 ? n : null;
    } catch {
        return null;
    }
};
const property = (object, key) => {
    try {
        return object?.[key];
    } catch {
        return undefined;
    }
};
const absolute = (p) => typeof p === 'string' && (path.isAbsolute(p) || path.win32.isAbsolute(p));
function bounded(value, maximum, fallback, format) {
    try {
        Object.freeze(value);
        const text = format(value);
        if (typeof text !== 'string' || Buffer.byteLength(text) > maximum) return fallback;
        // Only fixed primitives built here are returned, never formatter output or caller objects.
        return Object.freeze(value);
    } catch {
        return fallback;
    }
}

/** Dedicated query owner only. Inert without an explicitly bound, one-shot caller.
 * The native callback still runs inside the ORIGINAL owner guard. No environment,
 * cwd, launch option, input, decoder or admission change is made here. */
export function firstPlainParentLaunchEvidence({
    sourceRoot,
    powershell,
    plans,
    environment,
    clock = () => Number(process.hrtime.bigint() / 1000000n),
    format = JSON.stringify,
}) {
    assert(absolute(sourceRoot) && absolute(powershell));
    assert(Array.isArray(plans) && plans.length === 3);
    for (const plan of plans) {
        assert.deepEqual(Object.keys(plan).sort(), ['kind', 'path']);
        assert(plan.kind === 'directory' && absolute(plan.path));
    }
    assert(environment && typeof environment === 'object');
    assert.equal(typeof clock, 'function');
    assert.equal(typeof format, 'function');
    const rawJSON = JSON.stringify(plans);
    assert(Buffer.byteLength(rawJSON) <= 16384);
    let used = false;
    return Object.freeze({
        run(invoke, native) {
            assert(!used, 'First plain parent evidence already consumed');
            used = true; // Binding/launch/persistence failures consume the same attempt too.
            assert.equal(typeof invoke, 'function');
            assert.equal(typeof native, 'function');
            const token = Object.freeze({});
            const state = {
                sourceRoot,
                powershell,
                rawJSON,
                environment,
                clock,
                format,
                claimed: false,
                expired: false,
                boundary: false,
                launchAtMs: null,
                postCustodyAtMs: null,
                returnObserved: false,
            };
            capabilities.set(token, state);
            const nativeAtBoundary = (...args) => {
                assert(
                    state.claimed && !state.expired && !state.boundary,
                    'Original guarded launch boundary required once',
                );
                state.boundary = true;
                state.launchAtMs = tick(clock);
                return native(...args); // Exact original arguments/options; no retry or catch here.
            };
            try {
                const result = invoke(token, nativeAtBoundary);
                assert(!result?.then, 'First parent launch evidence is synchronous only');
                return result;
            } finally {
                state.expired = true;
            }
        },
    });
}

/** Called by the existing command wrapper before input persistence or process effects.
 * A forged/reused/wrong binding refuses; optional observation failures never do. */
export function takePlainParentLaunchEvidence(
    token,
    { sourceRoot, powershell, rawJSON, environment, red, timeout, diagnostic, launch },
) {
    const state = capabilities.get(token);
    assert(state && !state.claimed && !state.expired, 'Foreign or consumed plain parent evidence');
    state.claimed = true;
    assert.equal(sourceRoot, state.sourceRoot);
    assert.equal(powershell, state.powershell);
    assert.equal(rawJSON, state.rawJSON, 'Exact original three-plan bytes required');
    assert.equal(environment, state.environment, 'Original parent environment identity required');
    assert.equal(red, false);
    assert.equal(timeout, 10000);
    assert.equal(diagnostic, undefined, 'Plain parent evidence cannot activate v2');
    assert.equal(launch.options.encoding, 'utf8');
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.shell, false);
    assert(!Object.hasOwn(launch.options, 'cwd'), 'Inherited parent cwd required');
    const input = bounded(
        {
            schema: 1,
            kind: 'first-plain-parent-launch',
            available: true,
            encoding: launch.options.encoding,
            windowsHide: launch.options.windowsHide,
            cwdInherited: true,
        },
        plainParentEvidenceLimits.inputBytes,
        inputUnavailable,
        state.format,
    );
    return Object.freeze({
        input,
        afterCustody() {
            // No diagnostic clock/property/format access may precede the custody callback.
            if (!state.expired && !state.returnObserved) {
                state.returnObserved = true;
                state.postCustodyAtMs = tick(state.clock);
            }
        },
        result(returned, processState) {
            try {
                if (state.expired || !state.returnObserved) return resultUnavailable;
                const end = state.postCustodyAtMs;
                const complete =
                    state.boundary &&
                    state.launchAtMs !== null &&
                    end !== null &&
                    end >= state.launchAtMs;
                const error = processState.errorPresent ? property(returned, 'error') : null;
                const code = property(error, 'code');
                const errno = property(error, 'errno');
                const syscall = property(error, 'syscall');
                const pid = property(returned, 'pid');
                return bounded(
                    {
                        schema: 1,
                        kind: 'first-plain-parent-return',
                        available: true,
                        spawnCallBoundaryReached: state.boundary,
                        launchBoundaryAtMs: state.launchAtMs,
                        postCustodyObservedAtMs: complete ? end : null,
                        observedElapsedMs: complete ? end - state.launchAtMs : null,
                        clockComplete: complete,
                        returnedPID: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
                        errorCode: !processState.errorPresent
                            ? null
                            : [
                                    'ETIMEDOUT',
                                    'ENOENT',
                                    'EACCES',
                                    'EPERM',
                                    'ENOBUFS',
                                    'ECANCELED',
                                ].includes(code)
                              ? code
                              : 'OTHER',
                        errno:
                            Number.isSafeInteger(errno) &&
                            errno >= -2147483648 &&
                            errno <= 2147483647
                                ? errno
                                : null,
                        syscall:
                            typeof syscall === 'string'
                                ? syscall.startsWith('spawnSync')
                                    ? 'spawnSync'
                                    : 'OTHER'
                                : null,
                        actualExitOrPipeCloseObserved: false,
                    },
                    plainParentEvidenceLimits.resultBytes,
                    resultUnavailable,
                    state.format,
                );
            } catch {
                return resultUnavailable;
            }
        },
    });
}

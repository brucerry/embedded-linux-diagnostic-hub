import assert from 'node:assert/strict';

// Query owner only. This module has no live environment or process access.
export const queryOwnerRemovalNames = Object.freeze([
    'LOGONSERVER',
    'SYSTEMDRIVE',
    'USERDOMAIN',
    'USERNAME',
]);

const normalizations = new WeakMap();

function scan(environment) {
    try {
        if (environment === null || typeof environment !== 'object' || Array.isArray(environment))
            throw Error();
        const seen = new Set();
        const present = Object.fromEntries(queryOwnerRemovalNames.map((name) => [name, false]));
        for (const key of Object.keys(environment)) {
            const folded = key.toUpperCase();
            if (seen.has(folded)) throw Error();
            seen.add(folded);
            if (Object.hasOwn(present, folded)) {
                if (!/^[A-Za-z]+$/.test(key)) throw Error();
                present[folded] = true;
            }
        }
        return present;
    } catch {
        // Never disclose an arbitrary key, value, getter or native deletion error.
        throw Error('Query owner environment unreadable or case-ambiguous');
    }
}

/** A read-only launch guard; never removes or tolerates a reappearing field. */
export function assertQueryOwnerEnvironmentAbsent(environment) {
    const current = scan(environment);
    if (queryOwnerRemovalNames.some((name) => current[name]))
        throw Error('Query owner environment removal unproved or rebound');
}

/** One-way removal on an explicitly supplied native-backed environment.
 * Production binds this argument to process.env; tests supply a fake native store.
 * No restoration, value reads, helper process, file, timer or new evidence row. */
export function normalizeQueryOwnerEnvironment(environment, nativeEnvironment = environment) {
    if (environment !== nativeEnvironment)
        throw Error('Native-backed query owner environment required');
    const before = scan(environment);
    for (const name of queryOwnerRemovalNames) {
        if (!before[name]) continue;
        let removed = false;
        try {
            removed = Reflect.deleteProperty(environment, name);
        } catch {
            // A native/proxy exception may contain values; use a fixed refusal.
        }
        if (!removed) throw Error('Query owner environment removal failed');
    }
    let refused = false;
    const assertAbsent = () => {
        if (refused) throw Error('Query owner environment refusal latched');
        try {
            assertQueryOwnerEnvironmentAbsent(environment);
        } catch {
            refused = true;
            throw Error('Query owner environment removal unproved or rebound');
        }
    };
    assertAbsent();
    const flags = Object.freeze(
        Object.fromEntries(
            queryOwnerRemovalNames.map((name) => [
                name,
                Object.freeze({ present: before[name], removed: before[name], absent: true }),
            ]),
        ),
    );
    const normalization = Object.freeze({
        flags,
        assertAbsent,
        beforeSpawn(check, launch, ...args) {
            assertAbsent();
            check();
            assertAbsent();
            // Nothing after launch may throw and lose custody of a returned handle.
            return launch(...args);
        },
    });
    normalizations.set(normalization, environment);
    return normalization;
}

/** Preserve the hosted context's full immutable snapshot, with one exact transition.
 * Only a successful normalization receipt for this same object can authorize
 * the four removals. Every other original key and value stays bound. */
export function bindQueryOwnerEnvironment(environment) {
    let pinned;
    try {
        pinned = { ...environment };
    } catch {
        assert(false, 'Host environment unreadable');
    }
    let transitioned = false;
    function matches(expected) {
        try {
            const keys = Object.keys(environment).sort();
            const expectedKeys = Object.keys(expected).sort();
            return (
                keys.length === expectedKeys.length &&
                keys.every((key, index) => key === expectedKeys[index]) &&
                keys.every((key) => Object.is(environment[key], expected[key]))
            );
        } catch {
            return false;
        }
    }
    return Object.freeze({
        check() {
            assert(matches(pinned), 'Host environment rebound');
        },
        acceptNormalization(normalization) {
            assert(!transitioned, 'Owner environment transition already consumed');
            transitioned = true; // Failed attempts are consumed too; never retry/rebaseline.
            assert(
                normalizations.get(normalization) === environment,
                'Bound native owner normalization required',
            );
            normalization.assertAbsent();
            const expected = {};
            const originalPresence = Object.fromEntries(
                queryOwnerRemovalNames.map((name) => [name, false]),
            );
            for (const key of Object.keys(pinned)) {
                const folded = key.toUpperCase();
                if (/^[A-Za-z]+$/.test(key) && Object.hasOwn(originalPresence, folded))
                    originalPresence[folded] = true;
                else
                    Object.defineProperty(expected, key, {
                        value: pinned[key],
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
            }
            assert(
                queryOwnerRemovalNames.every(
                    (name) => normalization.flags[name].present === originalPresence[name],
                ),
                'Original native presence binding changed',
            );
            assert(matches(expected), 'Host environment changed beyond authorized removals');
            // Drop only the four authorized fields, without adopting any fresh values.
            pinned = expected;
        },
    });
}

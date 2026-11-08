/**
 * Independent nonshipping replacement for the unavailable external cleanup helper.
 * This guards an injected synchronous observer; it is not the historical launcher.
 * No process/filesystem implementation or native marker-release adapter is supplied.
 * The release port must condition removal on the exact identity at use; a pathname
 * read followed by unlink does not meet that contract. Synthetic ports prove only
 * this guard's decisions, never OS retirement, provenance or release qualification.
 */
import assert from 'node:assert/strict';

type Marker = Readonly<{ token: string; pid: number; cohort: string }>;
type Checks = {
    resultRead: boolean;
    cleanupVerified: boolean;
    receiptWritten: boolean;
    sourceVerified: boolean;
};
type Outcome = Readonly<{ status: unknown; signal: unknown; error?: unknown }>;
type Proof = Checks & {
    childStarted: boolean;
    outcome: Outcome | null;
    failureLatched: boolean;
};
interface Ports {
    runChild(): unknown;
    verify(): Checks;
    readMarker(): unknown;
    releaseOwnedMarker(expected: Marker): { released: true; identity: Marker };
    writeHeldReceipt(receipt: {
        status: 'cleanup-verification-required';
        qualification: false;
        marker: 'retained-or-unknown';
    }): void;
}
function record(value: unknown): asserts value is Record<string, unknown> {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    const proto = Object.getPrototypeOf(value);
    assert.ok(proto === Object.prototype || proto === null);
}
function field(value: unknown, key: string): unknown {
    record(value);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value'), 'Missing own data field: ' + key);
    return descriptor.value;
}
function marker(value: unknown): Marker {
    record(value);
    assert.deepEqual(Object.keys(value).sort(), ['cohort', 'pid', 'token']);
    const token = field(value, 'token'),
        pid = field(value, 'pid'),
        cohort = field(value, 'cohort');
    assert.ok(typeof token === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(token));
    assert.ok(typeof cohort === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(cohort));
    assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
    return Object.freeze({ token, pid, cohort });
}
function outcome(value: unknown): Outcome {
    const status = field(value, 'status'),
        signal = field(value, 'signal');
    record(value);
    const error = Object.hasOwn(value, 'error') ? field(value, 'error') : undefined;
    return Object.freeze({ status, signal, error });
}
const checkKeys = ['resultRead', 'cleanupVerified', 'receiptWritten', 'sourceVerified'] as const;
export function canReleaseObserver(value: unknown): boolean {
    try {
        if (field(value, 'childStarted') !== true || field(value, 'failureLatched') !== false)
            return false;
        const observed = outcome(field(value, 'outcome'));
        return (
            observed.status === 0 &&
            observed.signal === null &&
            observed.error === undefined &&
            checkKeys.every((key) => field(value, key) === true)
        );
    } catch {
        return false;
    }
}

/** One admitted run, no implicit retry. All failed/unknown outcomes retain custody. */
export function createObserverCleanupGuard(identity: Marker, ports: Ports) {
    const expected = marker(identity);
    let used = false;
    return {
        run() {
            assert.equal(used, false, 'Observer guard already used.');
            used = true;
            const failures: unknown[] = [];
            const proof: Proof = {
                childStarted: false,
                outcome: null,
                failureLatched: false,
                resultRead: false,
                cleanupVerified: false,
                receiptWritten: false,
                sourceVerified: false,
            };
            let released = false;
            const fail = (error: unknown) => {
                proof.failureLatched = true;
                failures.push(
                    error instanceof Error
                        ? error
                        : new Error('Observer operation failed with a non-Error value.', {
                              cause: error,
                          }),
                );
            };
            try {
                // Conservative even if the port throws after creating a child.
                proof.childStarted = true;
                proof.outcome = outcome(ports.runChild());
                if (proof.outcome.error !== undefined) throw proof.outcome.error;
                assert.ok(
                    proof.outcome.status === 0 &&
                        proof.outcome.signal === null &&
                        proof.outcome.error === undefined,
                    'Observer child did not report normal successful completion.',
                );
                const checked = ports.verify();
                for (const key of checkKeys) {
                    const verified = field(checked, key);
                    assert.equal(verified, true, 'Required observer verification absent: ' + key);
                    proof[key] = true;
                }
            } catch (error) {
                fail(error);
            }
            try {
                assert.deepEqual(marker(ports.readMarker()), expected, 'Foreign observer marker.');
                if (canReleaseObserver(proof)) {
                    const acknowledgement = ports.releaseOwnedMarker(expected);
                    assert.equal(field(acknowledgement, 'released'), true);
                    assert.deepEqual(marker(field(acknowledgement, 'identity')), expected);
                    released = true;
                }
            } catch (error) {
                fail(error);
            }
            if (!released)
                try {
                    const acknowledgement = ports.writeHeldReceipt({
                        status: 'cleanup-verification-required',
                        qualification: false,
                        marker: 'retained-or-unknown',
                    });
                    assert.equal(
                        acknowledgement,
                        undefined,
                        'Held receipt port must acknowledge synchronously.',
                    );
                } catch (error) {
                    fail(error);
                }
            return Object.freeze({
                releaseProof: Object.freeze(proof),
                disposition: released ? ('released' as const) : ('retained-or-unknown' as const),
                qualification: false as const,
                failure:
                    failures.length > 1
                        ? new AggregateError(failures, 'Observer cleanup remains unverified.')
                        : failures[0],
            });
        },
    };
}

/** Current console-native smoke summary only; never a final-artifact cleanup proof. */
export function verifyProductCleanup(mode: unknown, result: unknown, events: unknown) {
    assert.equal(mode, 'console-native', 'Unsupported observer cleanup mode.');
    assert.equal(field(result, 'qualified'), false);
    assert.equal(field(result, 'status'), 'actual-console-development-passed');
    assert.equal(field(result, 'native'), true);
    assert.equal(field(result, 'failure'), null, 'Product failure remains latched.');
    assert.ok(Array.isArray(events) && events.length > 0 && events.length <= 4096);
    const required = new Map([
        ['actual-process-exit', 0],
        ['actual-gateway-exit', 0],
    ]);
    for (const event of events) {
        const stage = field(event, 'stage');
        assert.ok(typeof stage === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(stage));
        assert.ok(stage !== 'failure' && !stage.endsWith('-failure'), 'Cleanup failure latched.');
        if (required.has(stage)) {
            assert.equal(field(field(event, 'data'), 'verified'), true);
            required.set(stage, required.get(stage)! + 1);
        } else
            assert.ok(
                !(stage.startsWith('actual-') && stage.endsWith('-exit')),
                'Unsupported process-exit role.',
            );
    }
    for (const [stage, count] of required) assert.equal(count, 1, 'Missing or duplicate ' + stage);
    return Object.freeze({
        verified: true,
        qualification: false,
        scope: 'diagnostic-summary-only',
    });
}

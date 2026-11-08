import assert from 'node:assert/strict';
import {
    verifyLocalAttestation,
    ATTESTATION_VERIFIER_LIMITS,
} from './attested-content-verifier.mjs';

/** Source-owned ports only. No native adapter/default, signals, retry or authority grant.
 * The independent observer below is an injected MODEL boundary, not an OS proof.
 */
export function createVerifierCustody({
    filesystem,
    dispatch,
    observeGroupRetirement,
    clock,
    uid,
    platform,
}) {
    for (const name of ['realpath', 'lstat', 'readdir', 'open'])
        assert.equal(typeof filesystem?.[name], 'function');
    for (const fn of [dispatch, observeGroupRetirement, clock?.now, clock?.set, clock?.clear])
        assert.equal(typeof fn, 'function');
    assert.ok(Number.isSafeInteger(uid) && uid >= 0 && platform === 'linux');
    let active = null,
        ordinal = 0;
    function begin(request) {
        assert.equal(active, null, 'Verifier custody still held; new admission blocked.');
        assert.ok(Number.isSafeInteger(ordinal + 1));
        const attempt = {
            id: ++ordinal,
            files: new Set(),
            processes: new Set(),
            pending: 0,
            done: false,
            primary: null,
            diagnostics: [],
            completionDone: false,
            retired: false,
            clockUncertain: false,
            clockReceipts: [],
        };
        active = attempt; // Admission precedes every await/acquisition and callback.
        let complete, retire, value, timer;
        const completion = new Promise((resolve) => (complete = resolve)),
            retirement = new Promise((resolve) => (retire = resolve));
        let start = NaN,
            last = NaN;
        try {
            start = clock.now();
            last = start;
        } catch (error) {
            fail(error);
        }
        function snapshot() {
            return Object.freeze({
                attempt: attempt.id,
                status: attempt.retired
                    ? 'retired-model-only'
                    : attempt.primary
                      ? 'failed-custody-held'
                      : 'running-custody-held',
                operationSettled: attempt.done,
                pendingCalls: attempt.pending,
                filesHeld: attempt.files.size,
                processesHeld: attempt.processes.size,
                cleanupDiagnostics: attempt.diagnostics.length,
                clockCustodyUnknown: attempt.clockUncertain,
                stdoutBufferedBytes: [...attempt.processes].reduce((n, p) => n + p.storedBytes, 0),
                stdoutBufferBlocks: [...attempt.processes].reduce((n, p) => n + p.chunks.length, 0),
                executionAllowed: false,
                retirementProven: false,
                qualification: false,
            });
        }
        function fail(error) {
            if (attempt.retired || active !== attempt) return;
            if (!attempt.primary)
                attempt.primary =
                    error instanceof Error
                        ? error
                        : new Error('Verifier owner observation failed.', { cause: error });
            else if (error !== attempt.primary && attempt.diagnostics.length < 32)
                attempt.diagnostics.push(error);
            if (!attempt.completionDone) {
                attempt.completionDone = true;
                complete(
                    Object.freeze({
                        status: 'failed',
                        error: attempt.primary,
                        snapshot: snapshot(),
                    }),
                );
            }
        }
        function checked() {
            let now;
            try {
                now = clock.now();
            } catch (error) {
                fail(error);
                throw attempt.primary;
            }
            if (!Number.isFinite(now) || !Number.isFinite(last) || now < last)
                fail(new Error('Verifier monotonic clock invalid or regressed.'));
            else last = now;
            if (last - start >= 180000)
                fail(new Error('Verifier total allocation expired; custody retained.'));
            if (attempt.primary) throw attempt.primary;
        }
        // Only a reviewed synchronous fake clock is supported. Unknown acquisition/clear cannot retire.
        function clockReceipt(receipt) {
            if (receipt && typeof receipt.then === 'function') {
                attempt.clockReceipts.push(receipt);
                Promise.resolve(receipt).catch(() => {});
            }
        }
        function setTimer(fn, ms) {
            try {
                const id = clock.set(fn, ms);
                if (!Number.isSafeInteger(id) || id < 0) {
                    clockReceipt(id);
                    throw new Error('Unsupported asynchronous or opaque clock acquisition.');
                }
                return id;
            } catch (error) {
                attempt.clockUncertain = true;
                throw error;
            }
        }
        function clearTimer(id) {
            try {
                const receipt = clock.clear(id);
                if (receipt !== undefined) {
                    clockReceipt(receipt);
                    throw new Error('Unsupported clock retirement acknowledgement.');
                }
            } catch (error) {
                attempt.clockUncertain = true;
                throw error;
            }
        }
        function release() {
            if (
                attempt.retired ||
                !attempt.done ||
                attempt.pending ||
                attempt.clockUncertain ||
                attempt.files.size ||
                attempt.processes.size
            )
                return;
            // The operation itself must finish, even after an early error/cancellation.
            if (timer !== undefined) {
                try {
                    clearTimer(timer);
                } catch (error) {
                    fail(error);
                    return;
                }
            }
            attempt.retired = true;
            assert.equal(active, attempt);
            active = null;
            const state = snapshot();
            if (!attempt.completionDone) {
                attempt.completionDone = true;
                complete(Object.freeze({ status: 'completed-model-only', value, snapshot: state }));
            }
            retire(state);
        }
        async function call(fn, guarded = true) {
            if (guarded) checked();
            attempt.pending++;
            try {
                return await fn();
            } catch (error) {
                if (guarded) fail(error);
                throw error;
            } finally {
                attempt.pending--;
                release();
            }
        }
        const wrapped = Object.fromEntries(
            ['realpath', 'lstat', 'readdir'].map((name) => [
                name,
                (...args) => call(() => filesystem[name](...args)),
            ]),
        );
        wrapped.open = async (...args) => {
            checked();
            const record = {
                handle: null,
                openSettled: false,
                absent: false,
                closed: false,
                closeDispatched: false,
                closePromise: null,
                retired: false,
            };
            attempt.files.add(record);
            function retireFile() {
                if (record.retired || !record.openSettled || !(record.closed || record.absent))
                    return;
                record.retired = true;
                record.handle = null;
                attempt.files.delete(record);
                release();
            }
            const observations = Object.freeze({
                notAcquired() {
                    if (record.retired || record.handle) return false;
                    record.absent = true;
                    retireFile();
                    return true;
                },
                closed(handle) {
                    if (record.retired || handle !== record.handle || !record.closeDispatched)
                        return false;
                    record.closed = true;
                    retireFile();
                    return true;
                },
            });
            let handle;
            try {
                handle = await call(() => filesystem.open(...args, observations));
                record.handle = handle;
                record.openSettled = true;
                if (record.absent) {
                    record.absent = false;
                    throw new Error('Contradictory no-file observation; handle custody retained.');
                }
                assert.ok(
                    handle &&
                        typeof handle === 'object' &&
                        ['read', 'stat', 'close'].every(
                            (name) => typeof handle[name] === 'function',
                        ),
                    'Invalid owned file handle.',
                );
                assert.equal(record.absent, false, 'Contradictory no-file observation.');
            } catch (error) {
                record.openSettled = true;
                fail(error);
                retireFile();
                throw error;
            }
            return {
                read: (...a) => call(() => handle.read(...a)),
                stat: (...a) => call(() => handle.stat(...a)),
                close() {
                    if (record.closePromise) return record.closePromise;
                    record.closeDispatched = true;
                    record.closePromise = call(() => handle.close(), false).then(
                        () => {
                            record.closed = true;
                            retireFile();
                        },
                        (error) => {
                            fail(error);
                            retireFile();
                            throw error;
                        },
                    );
                    return record.closePromise;
                },
            };
        };
        async function execute(file, args, options) {
            checked();
            const maximum = options.maxBuffer;
            assert.ok(
                Number.isSafeInteger(maximum) &&
                    maximum > 0 &&
                    maximum <= ATTESTATION_VERIFIER_LIMITS.output,
            );
            options = Object.freeze({ ...options, stdio: Object.freeze([...options.stdio]) });
            const record = {
                reference: null,
                references: new Set(),
                pid: null,
                dispatchSettled: false,
                absent: false,
                spawn: false,
                exit: null,
                close: null,
                stdoutClosed: false,
                stderrClosed: false,
                group: false,
                groupInvalid: false,
                retired: false,
                error: null,
                stdoutBytes: 0,
                stderrBytes: 0,
                chunks: [],
                storedBytes: 0,
                chunkUsed: 0,
                unsubscribe: null,
                unsubscribeStarted: false,
            };
            attempt.processes.add(record);
            let resolve, reject;
            const result = new Promise((yes, no) => {
                resolve = yes;
                reject = no;
            });
            // Attach rejection handling before any synchronous port callback.
            const awaited = result.then(
                (v) => v,
                (error) => {
                    throw error;
                },
            );
            awaited.catch(() => {}); // Failure may precede a held dispatch acknowledgement.
            let work,
                final,
                dispatchInvoked = false;
            function bad(error) {
                record.error ??= error;
                fail(error);
                reject(record.error);
            }
            function finish() {
                if (record.retired || !record.dispatchSettled) return;
                const closed =
                    (record.absent && !record.groupInvalid) ||
                    (record.reference &&
                        record.spawn &&
                        record.exit &&
                        record.close &&
                        record.stdoutClosed &&
                        record.stderrClosed &&
                        record.group &&
                        !record.groupInvalid);
                if (!closed) return;
                if (!record.absent && !record.unsubscribeStarted) {
                    record.unsubscribeStarted = true;
                    // Observer disposal is another acknowledged acquisition/lifetime, not a finally-forget.
                    call(() => record.unsubscribe(), false).then(() => {
                        record.unsubscribe = null;
                        finish();
                    }, bad);
                    return;
                }
                if (record.unsubscribe) return;
                try {
                    if (work !== undefined) clearTimer(work);
                    if (final !== undefined) clearTimer(final);
                } catch (error) {
                    bad(error);
                    return;
                }
                record.retired = true;
                record.reference = null;
                record.references.clear();
                attempt.processes.delete(record);
                if (record.absent)
                    bad(
                        record.error ??
                            new Error('Verifier dispatch explicitly did not acquire a process.'),
                    );
                else if (
                    record.exit.code !== 0 ||
                    record.close.code !== record.exit.code ||
                    record.exit.signal !== null ||
                    record.close.signal !== null
                )
                    bad(
                        new Error(
                            'Verifier process did not close normally with matching zero status.',
                        ),
                    );
                else if (!record.error && !attempt.primary)
                    resolve(Buffer.concat(record.chunks, record.storedBytes));
                else reject(record.error ?? attempt.primary);
                record.chunks = [];
                record.storedBytes = 0;
                release();
            }
            const live = () => !record.retired && active === attempt;
            const sink = Object.freeze({
                adopt(reference, pid) {
                    if (!live()) return false;
                    if (reference && typeof reference === 'object')
                        record.references.add(reference);
                    if (
                        record.reference ||
                        record.absent ||
                        !reference ||
                        typeof reference !== 'object' ||
                        !Number.isSafeInteger(pid) ||
                        pid <= 0
                    ) {
                        record.absent = false;
                        record.groupInvalid = true;
                        record.group = false;
                        record.reference ??= reference;
                        bad(
                            new Error(
                                'Contradictory or invalid process adoption; custody retained.',
                            ),
                        );
                        return false;
                    }
                    record.reference = reference;
                    record.pid = pid;
                    record.unsubscribe = observeGroupRetirement(reference, (witness) => {
                        if (!live()) return false;
                        if (
                            !witness ||
                            Object.keys(witness).sort().join(',') !== 'disposition,pid,remaining' ||
                            witness.pid !== record.pid ||
                            witness.disposition !== 'normal' ||
                            witness.remaining !== 0 ||
                            !record.spawn ||
                            !record.exit ||
                            !record.close ||
                            !record.stdoutClosed ||
                            !record.stderrClosed ||
                            record.groupInvalid ||
                            record.exit.signal !== null ||
                            record.close.signal !== null
                        ) {
                            record.groupInvalid = true;
                            record.group = false;
                            bad(
                                new Error(
                                    'Unsupported or forced group retirement observation; custody retained.',
                                ),
                            );
                            return false;
                        }
                        record.group = true;
                        finish();
                        return true;
                    });
                    assert.equal(
                        typeof record.unsubscribe,
                        'function',
                        'Missing group-observer disposal acknowledgement.',
                    );
                    return true;
                },
                notStarted() {
                    if (!live() || record.reference || record.spawn) return false;
                    record.absent = true;
                    finish();
                    return true;
                },
                spawned() {
                    if (!live() || !record.reference || record.absent) return false;
                    record.spawn = true;
                    return true;
                },
                data(name, bytes) {
                    if (!live()) return false;
                    if (
                        !record.reference ||
                        !['stdout', 'stderr'].includes(name) ||
                        !Buffer.isBuffer(bytes) ||
                        record[name + 'Closed']
                    ) {
                        bad(new Error('Invalid verifier stream observation.'));
                        return false;
                    }
                    const key = name + 'Bytes',
                        limit = name === 'stdout' ? maximum : 1024 ** 2;
                    record[key] = Math.min(limit + 1, record[key] + bytes.length);
                    if (record[key] > limit) {
                        bad(new Error('Verifier output allocation exceeded; custody retained.'));
                        return false;
                    }
                    if (name === 'stdout' && !record.error && !attempt.primary) {
                        let offset = 0;
                        while (offset < bytes.length) {
                            if (
                                !record.chunks.length ||
                                record.chunkUsed === record.chunks.at(-1).length
                            ) {
                                record.chunks.push(
                                    Buffer.alloc(Math.min(65536, maximum - record.storedBytes)),
                                );
                                record.chunkUsed = 0;
                            }
                            const block = record.chunks.at(-1),
                                count = Math.min(
                                    bytes.length - offset,
                                    block.length - record.chunkUsed,
                                );
                            bytes.copy(block, record.chunkUsed, offset, offset + count);
                            offset += count;
                            record.chunkUsed += count;
                            record.storedBytes += count;
                        }
                    }
                    return true;
                },
                streamClosed(name) {
                    if (!live() || !record.reference || !['stdout', 'stderr'].includes(name))
                        return false;
                    record[name + 'Closed'] = true;
                    finish();
                    return true;
                },
                exited(code, signal) {
                    if (!live() || !record.reference || record.exit) return false;
                    record.exit = { code, signal };
                    if (!Number.isInteger(code) || code !== 0 || signal !== null)
                        bad(new Error('Verifier exit failed.'));
                    finish();
                    return true;
                },
                closed(code, signal) {
                    if (!live() || !record.reference || record.close) return false;
                    record.close = { code, signal };
                    finish();
                    return true;
                },
                failed(error) {
                    if (!live()) return false;
                    bad(error);
                    return true;
                },
            });
            try {
                work = setTimer(
                    () =>
                        bad(
                            new Error(
                                'Verifier work allocation expired; custody retained without signals.',
                            ),
                        ),
                    ATTESTATION_VERIFIER_LIMITS.timeout,
                );
                final = setTimer(
                    () =>
                        bad(
                            new Error(
                                'Verifier close allocation expired; custody retained without signals.',
                            ),
                        ),
                    ATTESTATION_VERIFIER_LIMITS.timeout + 5000,
                );
                await call(() => {
                    dispatchInvoked = true;
                    return dispatch(
                        Object.freeze({ file, args: Object.freeze([...args]), options }),
                        sink,
                    );
                });
            } catch (error) {
                if (!dispatchInvoked) record.absent = true;
                bad(error);
            } finally {
                record.dispatchSettled = true;
                finish();
            }
            return awaited;
        }
        try {
            timer = setTimer(
                () =>
                    fail(
                        new Error(
                            'Verifier total allocation expired; custody retained without signals.',
                        ),
                    ),
                180000,
            );
        } catch (error) {
            fail(error);
        }
        // The only verifier path here is the explicit source-owned model seam. Default policy stays blocked.
        Promise.resolve()
            .then(() => {
                checked();
                return verifyLocalAttestation(request, {
                    filesystem: wrapped,
                    execute,
                    uid,
                    platform,
                });
            })
            .then((result) => {
                value = result;
            }, fail)
            .finally(() => {
                attempt.done = true;
                release();
            });
        return Object.freeze({
            completion,
            retirement,
            snapshot,
            diagnostics: () => Object.freeze([...attempt.diagnostics]),
            cancel() {
                fail(new Error('Verifier attempt cancelled; custody retained without signals.'));
            },
        });
    }
    return Object.freeze({
        begin,
        snapshot: () =>
            active
                ? Object.freeze({ blocked: true, attempt: active.id, executionAllowed: false })
                : Object.freeze({ blocked: false, attempt: null, executionAllowed: false }),
    });
}

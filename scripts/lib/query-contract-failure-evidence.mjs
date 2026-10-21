import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PilotEvidence } from './pilot-evidence.mjs';
import { acquiredEvidenceIdentity } from './query-durable-evidence.mjs';

const exactKeys = (value, keys) => {
    assert(value && Object.getPrototypeOf(value) === Object.prototype);
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const copy = (value) => JSON.parse(JSON.stringify(value));

/** Dedicated query contract ledger only. The held-state exception is a private,
 * synchronous, single-command frame, never an option on the ordinary append path.
 * It retains failure evidence, not metadata admission or physical closure proof. */
export function createQueryContractEvidence(root, { check, failureCheck, admit, hold, io = fs }) {
    for (const fn of [check, failureCheck, admit, hold]) assert.equal(typeof fn, 'function');
    let issued = null,
        active = null,
        frame = null,
        failed = false,
        poisoned = false;
    const filename = path.join(root, 'pilot.jsonl');
    let acquired;
    const guard = () => {
        assert(!poisoned, 'Contract evidence writer unavailable');
        assert(!ledger.entry.attempted, 'Contract ledger already retired');
        if (frame?.failure) {
            assert(active === frame.token && !active.revoked && active.failed);
            failureCheck();
            active.check();
        } else {
            assert(!failed, 'Ordinary contract evidence blocked after unknown custody');
            check();
        }
        if (acquired) {
            assert.deepEqual(acquiredEvidenceIdentity(ledger.entry.fd, io), acquired);
            const named = io.lstatSync(filename, { bigint: true });
            assert(named.isFile() && !named.isSymbolicLink());
            assert.deepEqual(
                Object.fromEntries(
                    ['dev', 'ino', 'uid', 'nlink'].map((k) => [k, String(named[k])]),
                ),
                acquired,
            );
            assert.equal(Number(named.size), ledger.bytes, 'Contract ledger named byte count');
            assert.equal(
                Number(io.fstatSync(ledger.entry.fd, { bigint: true }).size),
                ledger.bytes,
            );
        }
    };
    const ledger = new PilotEvidence(root, { io, check: guard });
    acquired = acquiredEvidenceIdentity(ledger.entry.fd, io);
    const refuse = (error) => {
        poisoned = true;
        hold({ phase: 'contract-persistence-unknown' });
        throw error;
    };
    const append = (stage, data) => {
        try {
            guard();
            if (frame) {
                assert(active === frame.token && !active.revoked && !frame.appended);
                const bound = { ...data };
                delete bound.case;
                assert.deepEqual(bound, frame.data, 'Command evidence frame rebound');
                assert.equal(stage, frame.stage);
                assert(typeof data.case === 'string' && data.case.length <= 128);
                active.case ??= data.case;
                assert.equal(data.case, active.case, 'Command evidence case rebound');
            }
            admit(Buffer.byteLength(JSON.stringify({ sequence: ledger.rows, stage, data })) + 1);
            ledger.append(stage, data);
            guard();
            admit(0);
            if (frame) frame.appended = true;
        } catch (error) {
            refuse(error);
        }
    };
    const failureRow = (token, stage, data) => {
        assert(token.failed && !token.terminal);
        if (stage === 'security-output') {
            exactKeys(data, ['stream', 'offset', 'bytes', 'base64']);
            assert(data.stream === 'stdout' || data.stream === 'stderr');
            assert(!token.stderr || data.stream === 'stderr', 'Original stream order');
            token.stderr ||= data.stream === 'stderr';
            const stream = token.streams[data.stream];
            assert(Number.isSafeInteger(data.bytes) && data.bytes > 0 && data.bytes <= 24576);
            assert.equal(data.offset, stream.bytes);
            assert(typeof data.base64 === 'string' && data.base64.length <= 32768);
            const bytes = Buffer.from(data.base64, 'base64');
            assert.equal(bytes.toString('base64'), data.base64);
            assert.equal(bytes.length, data.bytes);
            assert(stream.bytes + bytes.length <= 65536);
            stream.bytes += bytes.length;
            stream.hash.update(bytes);
            return;
        }
        assert.equal(stage, 'security-command-closed', 'Failure evidence stages only');
        exactKeys(data, [
            'status',
            'signal',
            'error',
            'streams',
            ...(Object.hasOwn(data, 'diagnostic') ? ['diagnostic'] : []),
        ]);
        assert.equal(data.status, token.state.status);
        assert.equal(data.signal, token.state.signal);
        assert.equal(data.error !== null, token.state.errorPresent);
        assert(
            data.error === null || (typeof data.error === 'string' && data.error.length <= 1024),
        );
        exactKeys(data.streams, ['stdout', 'stderr']);
        for (const name of ['stdout', 'stderr']) {
            const declared = data.streams[name],
                retained = token.streams[name];
            exactKeys(declared, ['bytes', 'sha256', 'retainedBytes', 'truncated']);
            assert(Number.isSafeInteger(declared.bytes) && declared.bytes >= 0);
            assert.equal(declared.retainedBytes, retained.bytes);
            assert.equal(declared.retainedBytes, Math.min(declared.bytes, 65536));
            assert.equal(declared.truncated, declared.bytes > declared.retainedBytes);
            assert(/^[a-f0-9]{64}$/.test(declared.sha256));
            if (!declared.truncated)
                assert.equal(declared.sha256, retained.hash.copy().digest('hex'));
        }
        if (Object.hasOwn(data, 'diagnostic')) {
            exactKeys(data.diagnostic, [
                'schema',
                'kind',
                'clockComplete',
                'spawnStartedAtMs',
                'returnedObservedAtMs',
                'observedElapsedMs',
                'returnedPID',
                'errorCode',
                'errno',
                'syscall',
                'actualExitOrPipeCloseObserved',
            ]);
            assert(Buffer.byteLength(JSON.stringify(data.diagnostic)) <= 1024);
            assert.equal(data.diagnostic.schema, 1);
            assert.equal(data.diagnostic.kind, 'first-collector-security-query');
            assert.equal(data.diagnostic.actualExitOrPipeCloseObserved, false);
        }
        token.terminal = true;
    };
    return Object.freeze({
        append,
        close() {
            assert(
                !issued && !active && !frame && !failed && !poisoned,
                'Held ledger cannot be retired',
            );
            try {
                guard();
                const closure = ledger.close();
                if (!closure.complete) hold({ phase: 'contract-persistence-unknown' });
                return closure;
            } catch (error) {
                refuse(error);
            }
        },
        /** Created only after the owner's existing contract admission. No token escapes.
         * The returned invocation and its callbacks expire on every return/throw. */
        bindCommand({ record, onProcessState, check: commandCheck }) {
            assert.equal(typeof record, 'function');
            assert.equal(typeof onProcessState, 'function');
            assert.equal(typeof commandCheck, 'function');
            guard();
            assert(!issued && !active && !frame);
            const issuer = Object.freeze({});
            issued = issuer;
            let used = false;
            return (invoke) => {
                assert(!used, 'Command evidence capability already consumed');
                used = true;
                guard();
                assert(issued === issuer && !active && !frame && typeof invoke === 'function');
                const token = {
                    revoked: false,
                    failed: false,
                    input: false,
                    state: null,
                    case: null,
                    terminal: false,
                    stderr: false,
                    check: commandCheck,
                    streams: Object.fromEntries(
                        ['stdout', 'stderr'].map((name) => [
                            name,
                            { bytes: 0, hash: createHash('sha256') },
                        ]),
                    ),
                };
                active = token;
                const callbacks = Object.freeze({
                    record(stage, data) {
                        assert(active === token && !token.revoked && !frame && !token.terminal);
                        try {
                            if (!token.input) {
                                assert.equal(stage, 'security-input');
                                assert(!token.state);
                            } else {
                                assert(
                                    token.state,
                                    'Process state must precede completion records',
                                );
                                if (token.failed) failureRow(token, stage, data);
                                else
                                    assert(
                                        ['security-output', 'security-command-closed'].includes(
                                            stage,
                                        ),
                                    );
                            }
                            const value = copy(data);
                            frame = {
                                token,
                                stage,
                                data: value,
                                failure: token.failed,
                                appended: false,
                            };
                            record(stage, value);
                            assert(frame.appended, 'Command evidence append not acknowledged');
                            token.input = true;
                            if (stage === 'security-command-closed') token.terminal = true;
                        } catch (error) {
                            refuse(error);
                        } finally {
                            frame = null;
                        }
                    },
                    onProcessState(state) {
                        assert(active === token && !token.revoked && token.input && !token.state);
                        // Custody must latch before the exception can become available.
                        onProcessState(state);
                        exactKeys(state, [
                            'attempted',
                            'closed',
                            'status',
                            'signal',
                            'errorPresent',
                        ]);
                        assert.equal(state.attempted, true);
                        assert(state.status === null || Number.isInteger(state.status));
                        assert(
                            state.signal === null ||
                                (typeof state.signal === 'string' && state.signal.length <= 32),
                        );
                        assert.equal(typeof state.errorPresent, 'boolean');
                        assert.equal(
                            state.closed,
                            Number.isInteger(state.status) && !state.signal && !state.errorPresent,
                        );
                        token.state = Object.freeze(copy(state));
                        token.failed = !state.closed;
                        failed ||= token.failed;
                    },
                });
                try {
                    const result = invoke(callbacks);
                    assert(!result?.then, 'Command evidence is synchronous only');
                    assert(token.state && token.terminal, 'Command completion evidence missing');
                    assert(!token.failed, 'Unknown contract custody remains held');
                    return result;
                } catch (error) {
                    if (!poisoned && (!token.state || !token.terminal)) {
                        poisoned = true;
                        hold({ phase: 'contract-persistence-unknown' });
                    }
                    throw error;
                } finally {
                    token.revoked = true;
                    issued = null;
                    active = null;
                    frame = null;
                }
            };
        },
    });
}

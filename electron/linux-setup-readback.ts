import { randomBytes } from 'node:crypto';
import { checkedLinuxSetupReadiness } from './linux-setup-readiness.ts';
import type { LinuxSetupReadiness } from '../shared/types.ts';

/** A single owned inherited duplex, never a listening or connecting endpoint. */
export interface LinuxReadbackPort {
    on(event: string, listener: (...args: any[]) => void): unknown;
    write(bytes: Uint8Array, done: (error?: Error | null) => void): boolean;
    end(done: (error?: Error | null) => void): unknown;
}
export interface LinuxReadbackBinding {
    root: string;
    installationId: string;
    transactionId: string;
    manifestSHA256: string;
    version: string;
    profile: string;
    executable: string;
    uid: number;
}
export interface LinuxReadbackProcess {
    pid: number;
    uid: number;
    executable: string;
    startTicks: string;
}
export interface LinuxReadbackClock {
    now(): number;
    nonce(): Buffer;
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const own = (x: unknown, keys: string[]): x is Record<string, any> =>
    Boolean(
        x &&
        typeof x === 'object' &&
        !Array.isArray(x) &&
        Object.keys(x).length === keys.length &&
        Object.keys(x).every((k) => keys.includes(k)),
    );
const nonce = (x: unknown): x is string =>
    typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) && /[1-9a-f]/.test(x);
const tick = (x: unknown): x is string => typeof x === 'string' && /^[1-9][0-9]{0,19}$/.test(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const fresh = (then: number, now: number) =>
    positive(then) && positive(now) && now >= then && now - then < 2000;
function matches(r: LinuxSetupReadiness, b: LinuxReadbackBinding, pid: number) {
    return (
        r.root === b.root &&
        r.installationId === b.installationId &&
        r.transactionId === b.transactionId &&
        r.manifestSHA256 === b.manifestSHA256 &&
        r.version === b.version &&
        r.profile.path === b.profile &&
        r.process.executable === b.executable &&
        r.process.uid === b.uid &&
        r.process.pid === pid
    );
}
/** Byte cap is enforced before concatenation/JSON parsing. One frame is at most12KiB; total32KiB.
 * Closure requires both EOFs: writable finish+end callback, readable end, and error-free close.
 * Every uncertain outcome retains the port; no destroy, timeout retry or cleanup inference. */
function channel(port: LinuxReadbackPort, frames: number, onFailure: () => void) {
    let primarySet = false,
        primary: unknown;
    const remember = (value: unknown) => {
        if (!primarySet) {
            primarySet = true;
            primary = value;
        }
    };
    let failed = false,
        code = 'UNSTARTED',
        buffer = Buffer.alloc(0),
        bytes = 0,
        count = 0,
        writes = 0;
    let readEnd = false,
        finish = false,
        close = false,
        endAck = false,
        endSubmitted = false,
        closed = false;
    let receive = (value: Record<string, any>) => {},
        onClosed = () => {},
        onEOF = () => {};
    let resolveClose: (ok: boolean) => void = () => {};
    const closeTask = new Promise<boolean>((r) => {
        resolveClose = r;
    });
    const fail = (reason: string) => {
        if (failed) return;
        failed = true;
        code = reason;
        resolveClose(false);
        onFailure();
    };
    const check = () => {
        if (!failed && !closed && readEnd && finish && close && endAck && writes === 0) {
            closed = true;
            code = 'CHANNEL_CLOSED';
            resolveClose(true);
            onClosed();
        }
    };
    const callOn = port.on,
        callWrite = port.write,
        callEnd = port.end;
    const write = (value: object, ack: () => void) => {
        if (failed) return;
        let raw: Buffer;
        try {
            raw = Buffer.from(JSON.stringify(value) + '\n');
            if (raw.length > 12288) throw Error();
        } catch {
            fail('FRAME_BOUND');
            return;
        }
        writes++;
        let callback = false,
            returned = false,
            accepted = false,
            error: unknown;
        const complete = () => {
            if (!returned || !callback) return;
            writes--;
            if ((error !== undefined && error !== null) || !accepted) {
                if (error !== undefined && error !== null) remember(error);
                fail('WRITE_UNCERTAIN');
                return;
            }
            if (!failed) ack();
            check();
        };
        try {
            accepted =
                Reflect.apply(callWrite, port, [
                    raw,
                    (e: unknown) => {
                        if (callback) {
                            fail('WRITE_CALLBACK_REUSED');
                            return;
                        }
                        callback = true;
                        error = e;
                        complete();
                    },
                ]) === true;
            returned = true;
            if (!accepted) fail('WRITE_UNCERTAIN');
            complete();
        } catch (error) {
            remember(error);
            fail('WRITE_UNCERTAIN');
        }
    };
    const end = () => {
        if (failed || endSubmitted) return;
        endSubmitted = true;
        try {
            Reflect.apply(callEnd, port, [
                (error: unknown) => {
                    if (endAck) {
                        fail('END_CALLBACK_REUSED');
                        return;
                    }
                    if (error !== undefined && error !== null) {
                        remember(error);
                        fail('END_UNCERTAIN');
                        return;
                    }
                    endAck = true;
                    check();
                },
            ]);
        } catch (error) {
            remember(error);
            fail('END_UNCERTAIN');
        }
    };
    try {
        if (
            typeof callOn !== 'function' ||
            typeof callWrite !== 'function' ||
            typeof callEnd !== 'function'
        )
            throw Error();
        Reflect.apply(callOn, port, [
            'error',
            (error: unknown) => {
                remember(error);
                fail('CHANNEL_ERROR');
            },
        ]);
        Reflect.apply(callOn, port, [
            'data',
            (chunk: unknown) => {
                if (failed) return;
                if (
                    !Buffer.isBuffer(chunk) ||
                    readEnd ||
                    bytes + chunk.length > 32768 ||
                    buffer.length + chunk.length > 12288
                ) {
                    fail('FRAME_BOUND');
                    return;
                }
                bytes += chunk.length;
                buffer = Buffer.concat([buffer, chunk]);
                for (;;) {
                    const e = buffer.indexOf(10);
                    if (e < 0) break;
                    const raw = buffer.subarray(0, e);
                    buffer = Buffer.from(buffer.subarray(e + 1));
                    if (++count > frames || !raw.length) {
                        fail('FRAME_COUNT');
                        break;
                    }
                    try {
                        const value: unknown = JSON.parse(raw.toString('utf8'));
                        if (
                            !value ||
                            typeof value !== 'object' ||
                            Array.isArray(value) ||
                            !Buffer.from(JSON.stringify(value)).equals(raw)
                        )
                            throw Error();
                        receive(value as Record<string, any>);
                    } catch (error) {
                        remember(error);
                        fail('FRAME_INVALID');
                    }
                    if (failed) break;
                }
            },
        ]);
        Reflect.apply(callOn, port, [
            'end',
            () => {
                if (readEnd || buffer.length) {
                    fail('CHANNEL_EOF');
                    return;
                }
                readEnd = true;
                onEOF();
                check();
            },
        ]);
        Reflect.apply(callOn, port, [
            'finish',
            () => {
                if (finish || !endSubmitted) {
                    fail('CHANNEL_FINISH');
                    return;
                }
                finish = true;
                check();
            },
        ]);
        Reflect.apply(callOn, port, [
            'close',
            (hadError: unknown) => {
                if (close || (hadError !== undefined && hadError !== false)) {
                    fail('CHANNEL_CLOSE');
                    return;
                }
                close = true;
                if (!readEnd || !endSubmitted) fail('CHANNEL_CLOSE');
                check();
            },
        ]);
    } catch (error) {
        remember(error);
        fail('CHANNEL_ADMISSION');
    }
    return {
        write,
        end,
        fail,
        get failed() {
            return failed;
        },
        get closed() {
            return closed;
        },
        closeTask,
        failure: () => ({ primarySet, primary }),
        receive(fn: typeof receive) {
            receive = fn;
        },
        closedBy(fn: typeof onClosed) {
            onClosed = fn;
        },
        eof(fn: typeof onEOF) {
            onEOF = fn;
        },
        summary: () => ({
            failed,
            code,
            bytes,
            frames: count,
            pendingWrites: writes,
            readEnd,
            writeFinished: finish,
            closeSeen: close,
            endAck,
            closed,
            retained: !closed,
        }),
    };
}
/** Freshness/identity authenticated to the specifically owned pipe, not OS peer credentials,
 * immutable loaded bytes, profile/window independence or whole-group retirement. */
export function createLinuxInstallerReadback(
    port: LinuxReadbackPort,
    expected: LinuxReadbackBinding,
    clock: LinuxReadbackClock = { now: Date.now, nonce: () => randomBytes(32) },
    onFailure: () => void = () => {},
) {
    const binding = clone(expected),
        now = clock.now.bind(clock),
        random = clock.nonce.bind(clock);
    let process: LinuxReadbackProcess | null = null,
        offerPid: number | null = null,
        challenge: string | null = null,
        sentAt = 0,
        ack = false,
        confirmed = false,
        replySeen = false;
    let record: LinuxSetupReadiness | null = null,
        resolve: (ok: boolean) => void = () => {};
    const result = new Promise<boolean>((r) => {
        resolve = r;
    });
    const wire = channel(port, 2, () => {
        resolve(false);
        onFailure();
    });
    const check = () => {
        if (wire.failed) return;
        if (record && ack) wire.end();
        if (record && ack && wire.closed) {
            if (!fresh(record.observedAtMs, now())) {
                wire.fail('REPLY_STALE');
                return;
            }
            confirmed = true;
            resolve(true);
        }
    };
    const send = () => {
        if (wire.failed || !process || offerPid === null || challenge) return;
        if (offerPid !== process.pid) {
            wire.fail('OFFER_PROCESS');
            return;
        }
        try {
            const bytes = random();
            if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw Error();
            challenge = bytes.toString('hex');
            sentAt = now();
            if (!nonce(challenge) || !positive(sentAt)) throw Error();
            wire.write(
                {
                    v: 1,
                    kind: 'challenge',
                    nonce: challenge,
                    sentAt,
                    binding,
                    pid: process.pid,
                    startTicks: process.startTicks,
                },
                () => {
                    ack = true;
                    check();
                },
            );
        } catch {
            wire.fail('CHALLENGE_UNCERTAIN');
        }
    };
    wire.receive((value) => {
        if (
            own(value, ['v', 'kind', 'pid']) &&
            value.v === 1 &&
            value.kind === 'offer' &&
            positive(value.pid) &&
            offerPid === null &&
            !challenge
        ) {
            offerPid = value.pid;
            send();
            return;
        }
        if (
            !own(value, ['v', 'kind', 'nonce', 'readiness']) ||
            value.v !== 1 ||
            value.kind !== 'reply' ||
            !challenge ||
            value.nonce !== challenge ||
            !process ||
            replySeen
        ) {
            wire.fail('REPLY_INVALID');
            return;
        }
        replySeen = true;
        try {
            const candidate = checkedLinuxSetupReadiness(value.readiness);
            if (
                !matches(candidate, binding, process.pid) ||
                candidate.observedAtMs < sentAt ||
                !fresh(candidate.observedAtMs, now())
            )
                throw Error();
            record = candidate;
            check();
        } catch {
            wire.fail('REPLY_INVALID');
        }
    });
    wire.eof(() => {
        if (!record) wire.fail('EOF_BEFORE_REPLY');
    });
    wire.closedBy(check);
    return Object.freeze({
        admit(input: LinuxReadbackProcess) {
            if (process || wire.failed) {
                wire.fail('PROCESS_REUSED');
                return;
            }
            const p = clone(input);
            if (
                !own(p, ['pid', 'uid', 'executable', 'startTicks']) ||
                !positive(p.pid) ||
                p.uid !== binding.uid ||
                p.executable !== binding.executable ||
                !tick(p.startTicks)
            ) {
                wire.fail('PROCESS_INVALID');
                return;
            }
            process = p;
            send();
        },
        wait: () => result,
        abort: () => wire.fail('OWNER_ABORTED'),
        joinClosure: async () => {
            if (!(await wire.closeTask)) throw Error('LINUX_READBACK_CUSTODY_RETAINED');
        },
        readiness: () =>
            confirmed && !wire.failed && record && fresh(record.observedAtMs, now())
                ? clone(record)
                : null,
        summary: () => ({
            ...wire.summary(),
            channelBoundFreshReadback: confirmed && !wire.failed,
            nativeQualified: false,
            successorVerified: false,
            wholeGroupRetirement: false,
            finalizationAuthority: false,
        }),
    });
}
export function createLinuxMainReadback(port: LinuxReadbackPort, now: () => number = Date.now) {
    let offered: LinuxSetupReadiness | null = null,
        refresh: (() => Promise<LinuxSetupReadiness | null>) | null = null,
        offerAck = false,
        challengeSeen = false,
        replySent = false,
        replyAck = false;
    let challenge: Record<string, any> | null = null,
        response: LinuxSetupReadiness | null = null;
    const wire = channel(port, 1, () => {});
    const send = () => {
        if (wire.failed || !offerAck || !challenge || !response || replySent) return;
        replySent = true;
        wire.write({ v: 1, kind: 'reply', nonce: challenge.nonce, readiness: response }, () => {
            replyAck = true;
            wire.end();
        });
    };
    wire.receive((value) => {
        if (
            challengeSeen ||
            !offered ||
            !refresh ||
            !own(value, ['v', 'kind', 'nonce', 'sentAt', 'binding', 'pid', 'startTicks']) ||
            value.v !== 1 ||
            value.kind !== 'challenge' ||
            !nonce(value.nonce) ||
            !tick(value.startTicks) ||
            !own(value.binding, [
                'root',
                'installationId',
                'transactionId',
                'manifestSHA256',
                'version',
                'profile',
                'executable',
                'uid',
            ]) ||
            !matches(offered, value.binding as LinuxReadbackBinding, value.pid) ||
            !fresh(value.sentAt, now())
        ) {
            wire.fail('CHALLENGE_INVALID');
            return;
        }
        challengeSeen = true;
        challenge = clone(value);
        const captured = refresh;
        void Promise.resolve()
            .then(captured)
            .then(
                (result) => {
                    if (wire.failed) return;
                    try {
                        const r = checkedLinuxSetupReadiness(result);
                        if (
                            !matches(r, value.binding as LinuxReadbackBinding, value.pid) ||
                            r.observedAtMs < value.sentAt ||
                            !fresh(r.observedAtMs, now())
                        )
                            throw Error();
                        response = r;
                        send();
                    } catch {
                        wire.fail('READINESS_UNAVAILABLE');
                    }
                },
                () => wire.fail('READINESS_UNAVAILABLE'),
            );
    });
    wire.eof(() => {
        if (!replySent) wire.fail('EOF_BEFORE_REPLY');
    });
    return Object.freeze({
        offer(value: LinuxSetupReadiness | null, read: () => Promise<LinuxSetupReadiness | null>) {
            if (!value || offered || wire.failed) return;
            try {
                const r = checkedLinuxSetupReadiness(value);
                if (!fresh(r.observedAtMs, now())) throw Error();
                offered = r;
                refresh = read;
                wire.write({ v: 1, kind: 'offer', pid: r.process.pid }, () => {
                    offerAck = true;
                    send();
                });
            } catch {
                wire.fail('OFFER_INVALID');
            }
        },
        joinClosure: async () => {
            if (!(await wire.closeTask)) throw Error('LINUX_READBACK_CUSTODY_RETAINED');
        },
        summary: () => ({
            ...wire.summary(),
            replyAcknowledged: replyAck,
            finalizationAuthority: false,
        }),
    });
}

const quitSelections = new WeakMap<object, LinuxReadbackBinding>();
const intrinsicPromiseThen = Promise.prototype.then;
const bindingKeys = [
    'root',
    'installationId',
    'transactionId',
    'manifestSHA256',
    'version',
    'profile',
    'executable',
    'uid',
];
function quitBinding(input: LinuxReadbackBinding): LinuxReadbackBinding {
    if (!input || typeof input !== 'object' || Reflect.ownKeys(input).length !== bindingKeys.length)
        throw Error('LINUX_QUIT_BINDING');
    const value: Record<string, any> = {};
    for (const key of bindingKeys) {
        const item = Object.getOwnPropertyDescriptor(input, key);
        if (!item || !Object.hasOwn(item, 'value') || item.get || item.set)
            throw Error('LINUX_QUIT_BINDING');
        value[key] = item.value;
    }
    if (
        !positive(value.uid) ||
        bindingKeys
            .filter((key) => key !== 'uid')
            .some(
                (key) =>
                    typeof value[key] !== 'string' ||
                    !value[key].length ||
                    value[key].length > 4096,
            ) ||
        !/^[a-f0-9]{64}$/.test(value.manifestSHA256) ||
        !value.root.startsWith('/') ||
        value.executable !== value.root + '/app/diagnostic-hub' ||
        !value.profile.startsWith('/')
    )
        throw Error('LINUX_QUIT_BINDING');
    return value as LinuxReadbackBinding;
}
/** Selects a one-use effect, never installed/native/release evidence. The real pipe is authority. */
export function createLinuxOwnedQuitSelection(binding: LinuxReadbackBinding): object {
    const selected = Object.freeze({});
    quitSelections.set(selected, quitBinding(binding));
    return selected;
}
export function consumeLinuxOwnedQuitSelection(
    selection: object | undefined,
    binding: LinuxReadbackBinding,
) {
    if (selection === undefined) return false;
    const actual = quitSelections.get(selection);
    quitSelections.delete(selection);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(quitBinding(binding)))
        throw Error('LINUX_QUIT_SELECTION');
    return true;
}

/** Independent inherited fd4. Startup fd3 remains the original one-shot protocol. */
export function createLinuxInstallerQuit(
    port: LinuxReadbackPort,
    expected: LinuxReadbackBinding,
    clock: LinuxReadbackClock = { now: Date.now, nonce: () => randomBytes(32) },
    onFailure: () => void = () => {},
) {
    const binding = quitBinding(expected),
        now = clock.now.bind(clock);
    let process: LinuxReadbackProcess | null = null,
        token: string | null = null,
        sentAt = 0,
        used = false,
        committed = false,
        accepted = false,
        idleEOF = false,
        record: LinuxSetupReadiness | null = null,
        ready: (value: LinuxSetupReadiness | null) => void = () => {},
        finished: (value: boolean) => void = () => {};
    const readyTask = new Promise<LinuxSetupReadiness | null>((resolve) => {
            ready = resolve;
        }),
        finishTask = new Promise<boolean>((resolve) => {
            finished = resolve;
        });
    const wire = channel(port, 2, () => {
        ready(null);
        finished(false);
        onFailure();
    });
    wire.receive((value) => {
        if (
            own(value, ['v', 'kind', 'nonce', 'readiness']) &&
            value.v === 1 &&
            value.kind === 'quit-ready' &&
            token &&
            value.nonce === token &&
            process &&
            !record &&
            !committed
        ) {
            try {
                const r = checkedLinuxSetupReadiness(value.readiness);
                if (
                    !matches(r, binding, process.pid) ||
                    r.observedAtMs < sentAt ||
                    !fresh(r.observedAtMs, now())
                )
                    throw Error();
                record = r;
                ready(clone(r));
            } catch {
                wire.fail('QUIT_READINESS');
            }
            return;
        }
        if (
            own(value, ['v', 'kind', 'nonce']) &&
            value.v === 1 &&
            value.kind === 'quit-accepted' &&
            token &&
            value.nonce === token &&
            record &&
            committed &&
            !accepted &&
            fresh(record.observedAtMs, now())
        ) {
            accepted = true;
            wire.end();
            return;
        }
        wire.fail('QUIT_REPLY');
    });
    wire.eof(() => {
        if (!used) {
            idleEOF = true;
            wire.end();
        } else if (!accepted) wire.fail('QUIT_EOF');
    });
    wire.closedBy(() => {
        if (accepted && record && fresh(record.observedAtMs, now())) finished(true);
        else if (!idleEOF) wire.fail('QUIT_CLOSE');
    });
    return Object.freeze({
        prepare(input: LinuxReadbackProcess) {
            if (
                used ||
                wire.failed ||
                wire.closed ||
                !own(input, ['pid', 'uid', 'executable', 'startTicks']) ||
                !positive(input.pid) ||
                input.uid !== binding.uid ||
                input.executable !== binding.executable ||
                !tick(input.startTicks)
            ) {
                wire.fail('QUIT_PROCESS');
                return readyTask;
            }
            used = true;
            process = clone(input);
            try {
                const bytes = clock.nonce();
                if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw Error();
                token = bytes.toString('hex');
                sentAt = now();
                if (!nonce(token) || !positive(sentAt)) throw Error();
                wire.write(
                    {
                        v: 1,
                        kind: 'prepare-quit',
                        nonce: token,
                        sentAt,
                        binding,
                        pid: process.pid,
                        startTicks: process.startTicks,
                    },
                    () => {},
                );
            } catch {
                wire.fail('QUIT_CHALLENGE');
            }
            return readyTask;
        },
        commit() {
            if (
                !record ||
                !token ||
                committed ||
                wire.failed ||
                !fresh(record.observedAtMs, now())
            ) {
                wire.fail('QUIT_COMMIT');
                return finishTask;
            }
            committed = true;
            wire.write({ v: 1, kind: 'quit', nonce: token }, () => {});
            return finishTask;
        },
        async joinClosure() {
            if (!(await wire.closeTask)) throw Error('LINUX_QUIT_CUSTODY_RETAINED');
        },
        abort: () => wire.fail('QUIT_OWNER_ABORTED'),
        summary: () => ({
            ...wire.summary(),
            prepared: record !== null,
            accepted,
            idleEOF,
            primarySet: wire.failure().primarySet,
            normalCloseObserved: false as const,
            releaseAcceptance: false as const,
        }),
    });
}

export function createLinuxMainQuit(
    port: LinuxReadbackPort,
    requestQuit: () => void,
    now: () => number = Date.now,
    onFailure: () => void = () => {},
) {
    let offered: LinuxSetupReadiness | null = null,
        refresh: (() => Promise<LinuxSetupReadiness | null>) | null = null,
        challenge: Record<string, any> | null = null,
        prepared: LinuxSetupReadiness | null = null,
        committed = false,
        acceptedSent = false,
        acceptedAck = false,
        submitted = false,
        returned = false,
        stopping = false,
        primarySet = false,
        primary: unknown,
        lastReturn: unknown,
        returnTask: Promise<unknown> | null = null,
        returnOutcome: { settled: boolean; fulfilled?: boolean; value?: unknown } = {
            settled: false,
        },
        returnJoinErrorSet = false,
        returnJoinError: unknown;
    const fail = (code: string, value?: unknown, actual = false) => {
        if (actual && !primarySet) {
            primarySet = true;
            primary = value;
        }
        wire.fail(code);
    };
    const wire = channel(port, 2, onFailure);
    wire.receive((value) => {
        if (
            own(value, ['v', 'kind', 'nonce', 'sentAt', 'binding', 'pid', 'startTicks']) &&
            value.v === 1 &&
            value.kind === 'prepare-quit' &&
            !challenge &&
            !stopping &&
            offered &&
            refresh &&
            nonce(value.nonce) &&
            tick(value.startTicks) &&
            positive(value.pid) &&
            fresh(value.sentAt, now())
        ) {
            try {
                if (!matches(offered, quitBinding(value.binding), value.pid)) throw Error();
            } catch (error) {
                fail('QUIT_BINDING', error, true);
                return;
            }
            challenge = clone(value);
            void Promise.resolve()
                .then(refresh)
                .then(
                    (result) => {
                        if (wire.failed || stopping) return;
                        try {
                            const r = checkedLinuxSetupReadiness(result);
                            if (
                                !matches(r, value.binding, value.pid) ||
                                r.observedAtMs < value.sentAt ||
                                !fresh(r.observedAtMs, now())
                            )
                                throw Error();
                            prepared = r;
                            wire.write(
                                { v: 1, kind: 'quit-ready', nonce: value.nonce, readiness: r },
                                () => {},
                            );
                        } catch (error) {
                            fail('QUIT_READINESS', error, true);
                        }
                    },
                    (error) => fail('QUIT_READINESS', error, true),
                );
            return;
        }
        if (
            own(value, ['v', 'kind', 'nonce']) &&
            value.v === 1 &&
            value.kind === 'quit' &&
            challenge &&
            value.nonce === challenge.nonce &&
            prepared &&
            refresh &&
            !committed &&
            !stopping &&
            fresh(prepared.observedAtMs, now())
        ) {
            committed = true;
            void Promise.resolve()
                .then(refresh)
                .then(
                    (result) => {
                        if (wire.failed || stopping) return;
                        try {
                            const r = checkedLinuxSetupReadiness(result);
                            if (
                                !matches(r, challenge!.binding, challenge!.pid) ||
                                !fresh(r.observedAtMs, now()) ||
                                r.process.creationTimeMs !== prepared!.process.creationTimeMs ||
                                JSON.stringify(r.window) !== JSON.stringify(prepared!.window)
                            )
                                throw Error();
                            prepared = r;
                            acceptedSent = true;
                            wire.write({ v: 1, kind: 'quit-accepted', nonce: value.nonce }, () => {
                                acceptedAck = true;
                                wire.end();
                            });
                        } catch (error) {
                            fail('QUIT_READINESS', error, true);
                        }
                    },
                    (error) => fail('QUIT_READINESS', error, true),
                );
            return;
        }
        fail('QUIT_REQUEST');
    });
    wire.eof(() => {
        if (!challenge && !committed) {
            stopping = true;
            wire.end();
        } else if (!acceptedSent) fail('QUIT_EOF');
    });
    wire.closedBy(() => {
        if (stopping && !committed) return;
        if (!acceptedAck || !prepared || !fresh(prepared.observedAtMs, now()) || submitted) {
            fail('QUIT_CLOSE');
            return;
        }
        submitted = true;
        try {
            lastReturn = requestQuit();
            if (lastReturn !== undefined) {
                // Never read a returned object's then getter. An actual Promise is retained
                // together with its late outcome; any intrinsic join failure remains owned.
                try {
                    returnTask = Reflect.apply(intrinsicPromiseThen, lastReturn, [
                        (value: unknown) => {
                            returnOutcome = { settled: true, fulfilled: true, value };
                        },
                        (value: unknown) => {
                            returnOutcome = { settled: true, fulfilled: false, value };
                        },
                    ]);
                } catch (error) {
                    returnJoinErrorSet = true;
                    returnJoinError = error;
                }
                throw Error('LINUX_QUIT_ASYNC_RETURN');
            }
            returned = true;
        } catch (error) {
            fail('QUIT_CALLBACK', error, true);
        }
    });
    return Object.freeze({
        offer(value: LinuxSetupReadiness | null, read: () => Promise<LinuxSetupReadiness | null>) {
            if (!value || wire.failed || stopping || challenge) return;
            try {
                offered = checkedLinuxSetupReadiness(value);
                refresh = read;
            } catch (error) {
                fail('QUIT_OFFER', error, true);
            }
        },
        async joinClosure() {
            if (!challenge && !wire.failed) {
                stopping = true;
                wire.end();
            }
            if (!(await wire.closeTask) || wire.failed) throw Error('LINUX_QUIT_CUSTODY_RETAINED');
        },
        summary: () => ({
            ...wire.summary(),
            requested: submitted,
            requestReturned: returned,
            primarySet: primarySet || wire.failure().primarySet,
            callbackReturnPending: returnTask !== null && !returnOutcome.settled,
            releaseAcceptance: false as const,
        }),
        failure: () => ({
            primarySet,
            primary,
            lastReturn,
            returnTask,
            returnOutcome: { ...returnOutcome },
            returnJoinErrorSet,
            returnJoinError,
            transport: wire.failure(),
        }),
    });
}

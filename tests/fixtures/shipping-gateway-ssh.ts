import assert from 'node:assert/strict';
import { shippingGatewayProbePlan } from './shipping-gateway-probes.ts';

export const SHIPPING_SSH_BOUNDS = Object.freeze({
    lifetimeMs: 60000,
    closeMs: 5000,
    clients: 4,
    sessions: 64,
    activeChannels: 8,
    execs: 64,
    commandBytes: 16384,
    outputBytes: 65536,
    listeners: 2048,
});
export interface ShippingSshPorts {
    ssh(options: any, client: (value: any, info: any) => void): any;
    tcp(socket: (value: any) => void): any;
    now(): number;
    setTimer(callback: () => void, milliseconds: number): unknown;
    clearTimer(handle: any): void;
}
const retained = new Set<object>();
const issued = new WeakSet<object>();
export function assertShippingGatewaySshFixture(value: unknown) {
    assert.ok(value && typeof value === 'object' && issued.has(value), 'Unissued SSH fixture.');
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

/** Mandatory explicit ports, inert on construction. Owns a separate TCP listener and injects
 * its already-owned sockets via SSH2's public injectSocket. Never constructs a Gateway,
 * executes an OS command, destroys a socket or uses private SSH2 fields. */
export function createShippingGatewaySshFixture(
    raw: { privateKey: Buffer | string; fingerprint: string; username: string; password: string },
    supplied: ShippingSshPorts,
) {
    assert.ok(Buffer.isBuffer(raw.privateKey) || typeof raw.privateKey === 'string');
    const privateKey = Buffer.from(raw.privateKey);
    assert.ok(privateKey.length > 0 && privateKey.length <= 16384);
    assert.match(raw.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.match(raw.username, /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/);
    assert.ok(
        typeof raw.password === 'string' &&
            raw.password.length >= 16 &&
            raw.password.length <= 128 &&
            !/[\x00-\x1f\x7f]/.test(raw.password),
    );
    const selected = {
        fingerprint: raw.fingerprint,
        username: raw.username,
        password: raw.password,
    };
    const ports = Object.fromEntries(
        ['ssh', 'tcp', 'now', 'setTimer', 'clearTimer'].map((key) => {
            const fn = supplied[key as keyof ShippingSshPorts];
            assert.equal(typeof fn, 'function');
            return [key, fn.bind(supplied)];
        }),
    ) as unknown as ShippingSshPorts;
    const plan = shippingGatewayProbePlan(),
        ready = deferred<any>(),
        closed = deferred<any>(),
        failure = deferred<never>();
    const sockets = new Set<any>(),
        clients = new Set<any>(),
        sessions = new Set<any>(),
        channels = new Set<any>(),
        listeners = new Set<any>(),
        pending = new Set<object>(),
        unknown = new Set<object>(),
        timers = new Set<any>(),
        seen = new Map<string, number>();
    const counts = {
        sockets: 0,
        clients: 0,
        passwordAccepted: 0,
        passwordAttempts: 0,
        execs: 0,
        sessions: 0,
        discoveryRefusals: 0,
        refusedRequests: 0,
        inputBytes: 0,
        outputBytes: 0,
    };
    let used = false,
        closing = false,
        retired = false,
        failed = false,
        code = 'UNSTARTED',
        tcp: any,
        ssh: any,
        port: number | null = null,
        started: number | null = null,
        listenerCloseSubmitted = false,
        listenerCloseAck = false,
        listenerCloseEvent = false,
        querySubmitted = false,
        queryAck = false,
        progressing = false,
        again = false,
        closeStarted: number | null = null;
    const snapshot = () =>
        Object.freeze({
            started: used,
            closing,
            retired,
            failed,
            code,
            sockets: sockets.size,
            clients: clients.size,
            sessions: sessions.size,
            channels: channels.size,
            listeners: listeners.size,
            unknownReturnedValuesRetained: [...unknown].filter(
                (op: any) =>
                    op.value !== undefined || op.late !== undefined || op.returnValue !== undefined,
            ).length,
            pendingOperations: pending.size,
            unknownOperations: unknown.size,
            timers: timers.size,
            listenerCloseAck,
            listenerCloseEvent,
            zeroTCPConnectionsObserved: queryAck,
            counts: { ...counts },
            planSHA256: plan.identity,
            ssh2InternalRetirement: null,
            wholeGroupRetirement: null,
            nativeQualified: false,
            releaseAcceptance: false,
        });
    const owner = Object.freeze({
        ready: ready.promise,
        closed: closed.promise,
        failure: failure.promise,
        snapshot,
        expectedProbes: plan.expectedProbes,
        sessionInput(attemptId: string) {
            assert.ok(port !== null && !closing && !failed);
            assert.match(attemptId, /^[a-f0-9]{32}$/);
            return {
                attemptId,
                target: { host: '127.0.0.1', port, ...selected },
                expectedProbes: plan.expectedProbes.map((row) => ({ ...row })),
            };
        },
        start() {
            assert.equal(used || closing, false, 'Fixture is one-use.');
            used = true;
            retained.add(owner);
            try {
                started = ports.now();
                assert.ok(Number.isFinite(started) && started >= 0);
                timer(SHIPPING_SSH_BOUNDS.lifetimeMs, () => {
                    fail('FIXTURE_DEADLINE');
                    requestClose();
                });
                ssh = acquire(() =>
                    ports.ssh(
                        {
                            hostKeys: [Buffer.from(privateKey)],
                            readyTimeout: 10000,
                            ident: 'shipping-gateway-fixture',
                        },
                        onClient,
                    ),
                );
                on(ssh, 'error', () => fail('SSH_SERVER_ERROR'));
                tcp = acquire(() => ports.tcp(onSocket));
                on(tcp, 'error', () => fail('TCP_LISTENER_ERROR'));
                on(tcp, 'close', () => {
                    if (listenerCloseEvent) fail('DUPLICATE_LISTENER_CLOSE');
                    listenerCloseEvent = true;
                    if (!closing) fail('UNEXPECTED_LISTENER_CLOSE');
                });
                sync(
                    () =>
                        tcp.listen(
                            0,
                            '127.0.0.1',
                            guarded(() => {
                                const address = tcp.address();
                                assert.ok(
                                    address &&
                                        address.address === '127.0.0.1' &&
                                        address.family === 'IPv4' &&
                                        Number.isInteger(address.port) &&
                                        address.port >= 1024 &&
                                        address.port <= 65535,
                                );
                                assert.equal(port, null);
                                port = address.port;
                                if (!failed && !closing) {
                                    code = 'LISTENING';
                                    ready.resolve({ host: '127.0.0.1', port, ...selected });
                                }
                            }),
                        ),
                    tcp,
                );
            } catch {
                fail('FIXTURE_START_UNACKNOWLEDGED');
            }
            progress();
            return ready.promise;
        },
        close() {
            retained.add(owner);
            requestClose();
            return closed.promise;
        },
        verifyComplete() {
            assert.equal(retired && !failed, true, 'Fixture is not cleanly retired.');
            assert.equal(counts.sockets, 2);
            assert.equal(counts.clients, 2);
            assert.equal(counts.passwordAccepted, 1);
            assert.equal(counts.passwordAttempts, 1);
            assert.equal(counts.execs, plan.commands.length);
            assert.equal(counts.sessions, plan.commands.length);
            assert.equal(counts.refusedRequests, 0);
            for (const row of plan.commands)
                assert.equal(seen.get(row.id), 1, 'Missing or replayed fixture command.');
            return Object.freeze({
                kind: 'shipping-gateway-owned-ssh-fixture/v1',
                counts: { ...counts },
                planSHA256: plan.identity,
                knownFixtureResourcesRetired: true,
                ssh2InternalRetirement: null,
                wholeGroupRetirement: null,
                nativeQualified: false,
                releaseAcceptance: false,
            });
        },
    });
    function fail(reason: string) {
        if (retired) return;
        if (!failed) code = reason;
        failed = true;
        const error = Object.assign(
            Error('Owned SSH fixture failed; uncertain custody retained.'),
            { owner },
        );
        ready.reject(error);
        failure.reject(error);
    }
    function withinLifetime() {
        const now = ports.now();
        if (
            started === null ||
            !Number.isFinite(now) ||
            now < started ||
            now - started >= SHIPPING_SSH_BOUNDS.lifetimeMs
        ) {
            fail('FIXTURE_DEADLINE');
            throw Error('Fixture lifetime is not admitted.');
        }
    }
    function acquire(work: () => any) {
        const lease: any = {};
        pending.add(lease);
        try {
            const value = work();
            lease.value = value; // Retain before validation, including unsupported asynchronous handles.
            if (value && typeof value.then === 'function')
                void Promise.resolve(value).then(
                    (late) => {
                        lease.late = late;
                    },
                    () => {},
                );
            assert.ok(value && typeof value.then !== 'function');
            pending.delete(lease);
            return value;
        } catch {
            unknown.add(lease);
            throw Error('Unacknowledged fixture acquisition.');
        }
    }
    function sync(work: () => any, expected: any) {
        const lease: any = {};
        pending.add(lease);
        try {
            const value = work();
            lease.value = value;
            if (value && typeof value.then === 'function')
                void Promise.resolve(value).then(
                    (late) => {
                        lease.late = late;
                    },
                    () => {},
                );
            assert.equal(value, expected);
            pending.delete(lease);
            return value;
        } catch {
            unknown.add(lease);
            throw Error('Unacknowledged fixture operation.');
        }
    }
    function guarded(work: (...args: any[]) => void) {
        return (...args: any[]) => {
            if (retired) return;
            try {
                work(...args);
            } catch {
                fail('FIXTURE_CALLBACK_FAILED');
            } finally {
                progress();
            }
        };
    }
    function on(target: any, event: string, work: (...args: any[]) => void) {
        assert.ok(listeners.size < SHIPPING_SSH_BOUNDS.listeners);
        const row = { target, event, fn: guarded(work) };
        listeners.add(row);
        sync(() => target.on(event, row.fn), target);
    }
    function timer(ms: number, callback: () => void) {
        const row: any = { handle: null };
        timers.add(row);
        row.handle = acquire(() => ports.setTimer(guarded(callback), ms));
    }
    function endClient(row: any) {
        if (row.endSubmitted || row.closed) return;
        row.endSubmitted = true;
        if (row.socket) row.socket.endSubmitted = true;
        sync(() => row.value.end(), row.value);
    }
    function requestClose() {
        if (retired || closing) return;
        closing = true;
        if (!used) {
            used = true;
            code = 'CLOSED_WITHOUT_START';
        }
        try {
            closeStarted = ports.now();
            assert.ok(Number.isFinite(closeStarted));
            if (started !== null) {
                try {
                    withinLifetime();
                } catch {}
            } // Deadline failure cannot suppress owned graceful cleanup.
            if (tcp) {
                timer(SHIPPING_SSH_BOUNDS.closeMs, () => fail('FIXTURE_CLOSE_DEADLINE'));
                listenerCloseSubmitted = true;
                sync(
                    () =>
                        tcp.close(
                            guarded((error: unknown) => {
                                assert.ok(error == null && !listenerCloseAck);
                                listenerCloseAck = true;
                            }),
                        ),
                    tcp,
                );
            }
            for (const row of clients) endClient(row);
            for (const row of sockets)
                if (!row.client && !row.endSubmitted && !row.closed) {
                    row.endSubmitted = true;
                    sync(() => row.value.end(), row.value);
                }
        } catch {
            fail('FIXTURE_CLOSE_UNACKNOWLEDGED');
        }
        progress();
    }
    function onSocket(value: any) {
        const row: any = {
            value,
            closed: false,
            client: null,
            endSubmitted: false,
            injected: false,
        };
        sockets.add(row);
        counts.sockets++;
        try {
            on(value, 'error', () => fail('FIXTURE_SOCKET_ERROR'));
            on(value, 'close', () => {
                assert.equal(row.closed, false);
                row.closed = true;
                sockets.delete(row);
            });
            withinLifetime();
            assert.equal(closing || failed, false);
            assert.ok(counts.sockets <= SHIPPING_SSH_BOUNDS.clients);
            assert.equal(value.remoteAddress, '127.0.0.1');
            assert.equal(value.localAddress, '127.0.0.1');
            assert.equal(value.remoteFamily, 'IPv4');
            assert.equal(value.localPort, port);
            assert.ok(
                Number.isInteger(value.remotePort) &&
                    value.remotePort >= 1024 &&
                    value.remotePort <= 65535,
            );
            row.remotePort = value.remotePort;
            row.injected = true;
            sync(() => ssh.injectSocket(value), undefined);
        } catch {
            fail('FIXTURE_SOCKET_ADMISSION');
        }
        progress();
    }
    function onClient(value: any, info: any) {
        const row: any = {
            value,
            ordinal: ++counts.clients,
            closed: false,
            accepted: false,
            ready: false,
            endSubmitted: false,
            socket: null,
        };
        clients.add(row);
        try {
            on(value, 'error', (error: any) => {
                if (
                    row.ordinal === 1 &&
                    !row.accepted &&
                    error?.code === 3 &&
                    counts.discoveryRefusals === 0
                )
                    counts.discoveryRefusals++;
                else fail('FIXTURE_SSH_CLIENT_ERROR');
            });
            on(value, 'close', () => {
                assert.equal(row.closed, false);
                row.closed = true;
                clients.delete(row);
            });
            const matches = [...sockets].filter(
                (s) =>
                    s.injected &&
                    !s.client &&
                    s.remotePort === info?.port &&
                    info?.ip === '127.0.0.1' &&
                    info?.family === 'IPv4',
            );
            assert.equal(matches.length, 1);
            row.socket = matches[0];
            row.socket.client = row;
            assert.ok(!closing && !failed && counts.clients <= SHIPPING_SSH_BOUNDS.clients);
            on(value, 'authentication', (auth: any) => {
                withinLifetime();
                if (closing || failed) {
                    sync(() => auth.reject(['password']), undefined);
                    return;
                }
                assert.equal(auth.username, selected.username);
                if (auth.method === 'none') {
                    sync(() => auth.reject(['password']), undefined);
                    return;
                }
                counts.passwordAttempts++;
                if (
                    auth.method !== 'password' ||
                    auth.password !== selected.password ||
                    row.accepted
                ) {
                    fail('FIXTURE_AUTH_REFUSED');
                    sync(() => auth.reject(['password']), undefined);
                    return;
                }
                row.accepted = true;
                sync(() => auth.accept(), undefined);
            });
            on(value, 'ready', () => {
                assert.ok(row.accepted && !row.ready);
                row.ready = true;
                counts.passwordAccepted++;
            });
            on(value, 'session', (accept: any, reject: any) => {
                withinLifetime();
                if (
                    closing ||
                    failed ||
                    !row.ready ||
                    counts.sessions >= SHIPPING_SSH_BOUNDS.sessions
                ) {
                    counts.refusedRequests++;
                    fail('FIXTURE_SESSION_REFUSED');
                    sync(() => reject(), undefined);
                    return;
                }
                const session = acquire(() => accept());
                const entry: any = { value: session, client: row, channel: null };
                sessions.add(entry);
                counts.sessions++;
                on(session, 'error', () => fail('FIXTURE_SESSION_ERROR'));
                on(session, 'exec', (exec: any, _reject: any, request: any) =>
                    acceptExec(entry, exec, request),
                );
                for (const event of [
                    'pty',
                    'shell',
                    'sftp',
                    'subsystem',
                    'env',
                    'x11',
                    'signal',
                    'window-change',
                    'auth-agent',
                ])
                    on(session, event, (_accept: any, refuse: any) => {
                        counts.refusedRequests++;
                        fail('FIXTURE_REQUEST_REFUSED');
                        if (typeof refuse === 'function') sync(() => refuse(), undefined);
                    });
            });
            for (const event of ['tcpip', 'openssh.streamlocal', 'request'])
                on(value, event, (_accept: any, reject: any) => {
                    counts.refusedRequests++;
                    fail('FIXTURE_FORWARD_REFUSED');
                    if (typeof reject === 'function') sync(() => reject(), undefined);
                });
        } catch {
            fail('FIXTURE_CLIENT_ADMISSION');
        }
        progress();
    }
    function callbackOperation(
        row: any,
        invoke: (callback: (error?: unknown) => void) => any,
        end: boolean,
        ack: () => void,
    ) {
        const op: any = { callback: false, returned: false, row };
        pending.add(op);
        const complete = () => {
            if (op.callback && op.returned) pending.delete(op);
        };
        try {
            const value = invoke(
                guarded((error?: unknown) => {
                    if (op.callback) {
                        unknown.add(op);
                        throw Error('Duplicate fixture callback.');
                    }
                    op.callback = true;
                    if (error != null) {
                        row.writeFailed = true;
                        fail('FIXTURE_WRITE_ERROR');
                    } else ack();
                    complete();
                }),
            );
            op.returnValue = value;
            if (value && typeof value.then === 'function')
                void Promise.resolve(value).then(
                    (late) => {
                        op.late = late;
                    },
                    () => {},
                );
            assert.ok(end ? value === (row.endTarget ?? row.value) : typeof value === 'boolean');
            op.returned = true;
            complete();
        } catch {
            unknown.add(op);
            row.writeFailed = true;
            fail('FIXTURE_WRITE_UNACKNOWLEDGED');
        }
    }
    function acceptExec(session: any, accept: any, request: any) {
        withinLifetime();
        const value = acquire(() => accept());
        const row: any = {
            value,
            session,
            ops: 0,
            writes: 0,
            sending: true,
            writeFailed: false,
            eof: false,
            finish: false,
            close: false,
            stderrFinish: false,
            stderrClose: false,
            stderrEndSubmitted: false,
            stderrEndAck: false,
            mainEndSubmitted: false,
            mainEndAck: false,
        };
        channels.add(row);
        session.channel = row;
        counts.execs++;
        on(value, 'error', () => {
            row.writeFailed = true;
            fail('FIXTURE_CHANNEL_ERROR');
        });
        on(value.stderr, 'error', () => {
            row.writeFailed = true;
            fail('FIXTURE_STDERR_ERROR');
        });
        on(value, 'data', (bytes: Buffer) => {
            assert.ok(Buffer.isBuffer(bytes));
            counts.inputBytes += bytes.length;
            if (bytes.length) fail('FIXTURE_INPUT_REFUSED');
            assert.ok(counts.inputBytes <= 4096);
        });
        on(value, 'end', () => {
            assert.equal(row.eof, false);
            row.eof = true;
        });
        on(value, 'finish', () => {
            assert.equal(row.finish, false);
            row.finish = true;
        });
        on(value, 'close', () => {
            assert.equal(row.close, false);
            row.close = true;
        });
        on(value.stderr, 'finish', () => {
            assert.equal(row.stderrFinish, false);
            row.stderrFinish = true;
        });
        on(value.stderr, 'close', () => {
            assert.equal(row.stderrClose, false);
            row.stderrClose = true;
        });
        assert.ok(
            counts.execs <= SHIPPING_SSH_BOUNDS.execs &&
                channels.size <= SHIPPING_SSH_BOUNDS.activeChannels,
        );
        assert.ok(
            typeof request?.command === 'string' &&
                Buffer.byteLength(request.command) <= SHIPPING_SSH_BOUNDS.commandBytes,
        );
        const answer = plan.reply(request.command);
        if (!answer || (seen.get(answer.id) ?? 0) > 0 || closing || failed) {
            counts.refusedRequests++;
            fail('FIXTURE_EXEC_REFUSED');
        }
        const reply =
            answer && !failed
                ? answer
                : { stdout: '', stderr: 'Fixture refused exec.\n', exitCode: 126 };
        if (answer && !failed) seen.set(answer.id, (seen.get(answer.id) ?? 0) + 1);
        row.exitCode = reply.exitCode;
        counts.outputBytes += Buffer.byteLength(reply.stdout + reply.stderr);
        assert.ok(counts.outputBytes <= SHIPPING_SSH_BOUNDS.outputBytes);
        sync(() => value.resume(), value); // SSH2 close depends on readable EOF; never leave stdin undrained.
        for (const [target, text] of [
            [value, reply.stdout],
            [value.stderr, reply.stderr],
        ] as const) {
            if (!text) {
                row.writes++;
                continue;
            }
            callbackOperation(
                row,
                (callback) => target.write(Buffer.from(text), callback),
                false,
                () => {
                    row.writes++;
                },
            );
        }
        row.sending = false;
    }
    function progress() {
        if (progressing) {
            again = true;
            return;
        }
        progressing = true;
        try {
            do {
                again = false;
                for (const row of channels) {
                    if (
                        !row.sending &&
                        !row.writeFailed &&
                        row.writes === 2 &&
                        !row.stderrEndSubmitted
                    ) {
                        row.stderrEndSubmitted = true;
                        sync(() => row.value.exit(row.exitCode), undefined);
                        row.endTarget = row.value.stderr;
                        callbackOperation(
                            row,
                            (callback) => row.value.stderr.end(callback),
                            true,
                            () => {
                                row.stderrEndAck = true;
                            },
                        );
                    }
                    if (
                        row.stderrEndAck &&
                        row.stderrFinish &&
                        !row.writeFailed &&
                        !row.mainEndSubmitted
                    ) {
                        row.mainEndSubmitted = true;
                        row.endTarget = row.value;
                        callbackOperation(
                            row,
                            (callback) => row.value.end(callback),
                            true,
                            () => {
                                row.mainEndAck = true;
                            },
                        );
                    }
                    if (
                        row.close &&
                        row.eof &&
                        row.stderrClose &&
                        ![...pending].some((p: any) => p.row === row)
                    ) {
                        if (
                            !row.finish ||
                            !row.stderrFinish ||
                            !row.mainEndAck ||
                            !row.stderrEndAck
                        )
                            fail('FIXTURE_CHANNEL_NOT_NORMAL');
                        channels.delete(row);
                        sessions.delete(row.session);
                    }
                }
                for (const row of sessions)
                    if (!row.channel && row.client.closed && row.client.socket?.closed)
                        sessions.delete(row);
                if (
                    closing &&
                    !pending.size &&
                    !unknown.size &&
                    !sockets.size &&
                    !clients.size &&
                    !sessions.size &&
                    !channels.size
                ) {
                    if (!tcp) {
                        if (!ssh) retire();
                    } else if (
                        listenerCloseSubmitted &&
                        listenerCloseAck &&
                        listenerCloseEvent &&
                        !querySubmitted
                    ) {
                        querySubmitted = true;
                        sync(
                            () =>
                                tcp.getConnections(
                                    guarded((error: unknown, count: number) => {
                                        assert.ok(error == null && count === 0 && !queryAck);
                                        queryAck = true;
                                    }),
                                ),
                            tcp,
                        );
                    } else if (queryAck) retire();
                }
            } while (again && !retired);
        } catch {
            fail('FIXTURE_RETIREMENT_UNACKNOWLEDGED');
        } finally {
            progressing = false;
        }
    }
    function retire() {
        if (started !== null) {
            try {
                withinLifetime();
            } catch {}
        }
        const now = ports.now();
        if (
            closeStarted === null ||
            !Number.isFinite(now) ||
            now < closeStarted ||
            now - closeStarted >= SHIPPING_SSH_BOUNDS.closeMs
        )
            fail('FIXTURE_CLOSE_DEADLINE');
        for (const row of timers) {
            sync(() => ports.clearTimer(row.handle), undefined);
            timers.delete(row);
        }
        for (const row of listeners) {
            sync(() => row.target.off(row.event, row.fn), row.target);
            listeners.delete(row);
        }
        assert.equal(pending.size + unknown.size, 0);
        retired = true;
        retained.delete(owner);
        if (!failed && code !== 'CLOSED_WITHOUT_START') code = 'KNOWN_RESOURCES_CLOSED';
        closed.resolve(snapshot());
    }
    issued.add(owner);
    return owner;
}

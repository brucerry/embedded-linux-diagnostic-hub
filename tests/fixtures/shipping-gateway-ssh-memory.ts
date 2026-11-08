import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createShippingGatewaySshFixture, SHIPPING_SSH_BOUNDS } from './shipping-gateway-ssh.ts';

export function shippingSshMemory() {
    const controls: any = {},
        calls: string[] = [],
        sockets = new Set<any>(),
        allClients: any[] = [],
        allChannels: any[] = [],
        timers: any[] = [],
        heldWrites: Function[] = [];
    let tcpCallback: Function = () => {},
        clientCallback: Function = () => {},
        closing = false,
        closeCallback: Function = () => {},
        listenerDone = false,
        time = 0,
        sourcePort = 20000;
    const tcp: any = new EventEmitter(),
        ssh: any = new EventEmitter();
    const pumpTCP = () => {
        if (closing && !sockets.size && !listenerDone && !controls.holdListener) {
            listenerDone = true;
            if (!controls.holdListenerEvent) tcp.emit('close');
            if (!controls.holdListenerAck) closeCallback();
        }
    };
    tcp.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 58732 });
    tcp.listen = (port: number, host: string, callback: Function) => {
        calls.push('listen');
        assert.equal(port, 0);
        assert.equal(host, '127.0.0.1');
        queueMicrotask(() => callback());
        return tcp;
    };
    tcp.close = (callback: Function) => {
        calls.push('listener-close');
        closing = true;
        closeCallback = callback;
        pumpTCP();
        return tcp;
    };
    tcp.releaseCloseAck = () => closeCallback();
    tcp.getConnections = (callback: Function) => {
        calls.push('get-connections');
        queueMicrotask(() => callback(null, controls.wrongCount ? 1 : sockets.size));
        return tcp;
    };
    ssh.injectSocket = (socket: any) => {
        calls.push('inject');
        const client: any = new EventEmitter();
        client.socket = socket;
        socket.client = client;
        client.end = () => {
            calls.push('client-end');
            socket.end();
            return client;
        };
        allClients.push(client);
        clientCallback(client, {
            ip: socket.remoteAddress,
            family: socket.remoteFamily,
            port: socket.remotePort,
        });
    };
    const ports = {
        ssh(options: any, callback: Function) {
            calls.push('ssh-factory');
            assert.equal(options.hostKeys.length, 1);
            clientCallback = callback;
            return controls.unknownSSH ? Promise.resolve(ssh) : ssh;
        },
        tcp(callback: Function) {
            calls.push('tcp-factory');
            tcpCallback = callback;
            return tcp;
        },
        now: () => time,
        setTimer(callback: Function, ms: number) {
            const row = { callback, ms, cleared: false };
            timers.push(row);
            if (controls.badTimer) throw Error('inert allocation uncertainty');
            return row;
        },
        clearTimer(row: any) {
            if (controls.badClear) throw Error('inert clear uncertainty');
            row.cleared = true;
        },
    };
    const credentials = {
        privateKey: Buffer.from('inert-test-key-never-parsed'),
        fingerprint: 'SHA256:' + 'A'.repeat(43),
        username: 'engineer',
        password: 'synthetic-fixture-password',
    };
    const fixture = createShippingGatewaySshFixture(credentials, ports);
    const connect = () => {
        const socket: any = new EventEmitter();
        Object.assign(socket, {
            remoteAddress: controls.wrongPeer ? '127.0.0.2' : '127.0.0.1',
            localAddress: '127.0.0.1',
            remoteFamily: 'IPv4',
            localPort: 58732,
            remotePort: ++sourcePort,
        });
        socket.closeNow = () => {
            if (!sockets.has(socket)) return;
            sockets.delete(socket);
            socket.emit('close');
            if (socket.client) socket.client.emit('close');
            pumpTCP();
        };
        socket.end = () => {
            calls.push('socket-end');
            if (!controls.holdSocket) queueMicrotask(() => socket.closeNow());
            return socket;
        };
        sockets.add(socket);
        tcpCallback(socket);
        return socket.client;
    };
    const discover = () => {
        const client = connect();
        client.emit('error', { code: 3 });
        client.end();
        return client;
    };
    const authenticate = (password = credentials.password) => {
        const client = connect();
        const none = {
            method: 'none',
            username: credentials.username,
            reject(methods: string[]) {
                assert.deepEqual(methods, ['password']);
            },
        };
        client.emit('authentication', none);
        client.emit('authentication', {
            method: 'password',
            username: credentials.username,
            password,
            accept() {
                client.emit('ready');
            },
            reject() {},
        });
        return client;
    };
    const exec = (client: any, command: string) => {
        const session: any = new EventEmitter(),
            channel: any = new EventEmitter(),
            stderr: any = new EventEmitter();
        channel.stderr = stderr;
        channel.out = [];
        channel.err = [];
        channel.resumed = false;
        channel.closed = false;
        channel.resume = () => {
            channel.resumed = true;
            return channel;
        };
        const write = (out: Buffer[], bytes: Buffer, callback: Function) => {
            out.push(Buffer.from(bytes));
            const done = () => callback(controls.writeError ? Error('inert write') : undefined);
            if (controls.holdWrite) heldWrites.push(done);
            else queueMicrotask(done);
            return !controls.backpressure;
        };
        channel.write = (bytes: Buffer, callback: Function) => write(channel.out, bytes, callback);
        stderr.write = (bytes: Buffer, callback: Function) => write(channel.err, bytes, callback);
        stderr.end = (callback: Function) => {
            calls.push('stderr-end');
            stderr.emit('finish');
            callback();
            if (!controls.holdStderrClose) stderr.emit('close');
            return stderr;
        };
        channel.exit = (code: number) => {
            channel.code = code;
        };
        channel.end = (callback: Function) => {
            calls.push('channel-end');
            channel.emit('finish');
            if (!controls.holdEOF && channel.resumed) channel.emit('end');
            channel.closed = true;
            channel.emit('close');
            if (!controls.holdEndAck) callback();
            else channel.endCallback = callback;
            return channel;
        };
        allChannels.push(channel);
        client.emit(
            'session',
            () => session,
            () => {},
        );
        session.emit(
            'exec',
            () => channel,
            () => {},
            { command },
        );
        return channel;
    };
    const pulse = async () => {
        for (let i = 0; i < 100; i++) await Promise.resolve();
    };
    return {
        fixture,
        credentials,
        controls,
        calls,
        tcp,
        ssh,
        ports,
        connect,
        discover,
        authenticate,
        exec,
        pulse,
        timers,
        allClients,
        allChannels,
        heldWrites,
        setTime(value: number) {
            time = value;
        },
        expire() {
            time = SHIPPING_SSH_BOUNDS.lifetimeMs;
            timers.find((row) => row.ms === SHIPPING_SSH_BOUNDS.lifetimeMs).callback();
        },
    };
}

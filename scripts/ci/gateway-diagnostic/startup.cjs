'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');

const host = '127.0.0.1';
const origin = 'http://127.0.0.1';
const token = 'inert-gateway-loopback-diagnostic-only';
const started = performance.now();
const guard = setTimeout(() => process.exit(1), 15000);
function deadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('deadline')), ms);
    })]).finally(() => clearTimeout(timer));
}

function verifyModules() {
    for (const [from, dependency, entry] of [
        ['dist-gateway/main.cjs', 'ssh2', 'ssh2/lib/index.js'],
        ['node_modules/ssh2/package.json', 'asn1', 'asn1/lib/index.js'],
        ['node_modules/ssh2/package.json', 'bcrypt-pbkdf', 'bcrypt-pbkdf/index.js'],
        ['node_modules/asn1/package.json', 'safer-buffer', 'safer-buffer/safer.js'],
        ['node_modules/bcrypt-pbkdf/package.json', 'tweetnacl', 'tweetnacl/nacl-fast.js'],
    ]) {
        const requireLocal = createRequire('/staged/' + from);
        assert.equal(requireLocal.resolve(dependency), '/staged/node_modules/' + entry);
    }
    for (const packageName of ['cpu-features', 'nan', 'buildcheck']) {
        try {
            createRequire('/staged/node_modules/ssh2/package.json').resolve(packageName);
        } catch (error) {
            assert.equal(error.code, 'MODULE_NOT_FOUND');
            continue;
        }
        throw Error('unexpected optional input');
    }
}

function ownedListener(pid, port) {
    assert.equal(fs.readlinkSync(`/proc/${pid}/exe`), '/staged/bin/node');
    const sockets = new Set(fs.readdirSync(`/proc/${pid}/fd`).map(fd => {
        try { return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1]; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }).filter(Boolean));
    const bound = [];
    for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
        for (const line of fs.readFileSync('/proc/net/' + table, 'ascii').trim().split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (sockets.has(fields[9])) bound.push([table, fields[1], fields[3]]);
        }
    }
    assert.deepEqual(bound, [['tcp', '0100007F:' + port.toString(16).toUpperCase().padStart(4, '0'), '0A']]);
}

async function run() {
    assert.equal(process.pid, 1);
    assert.ok(process.getuid() > 0);
    assert.equal(process.version, 'v24.22.2');
    verifyModules();
    const reserve = net.createServer();
    reserve.listen(0, host);
    await deadline(once(reserve, 'listening'), 1000);
    const port = reserve.address().port;
    assert.ok(port > 1024);
    reserve.close();
    await deadline(once(reserve, 'close'), 1000);
    const target = JSON.stringify([{host, port: 1, fingerprint: 'SHA256:' + 'A'.repeat(43)}]);
    fs.writeFileSync('/scratch/test.env',
        `HUB_GATEWAY_HOST=${host}\nHUB_GATEWAY_PORT=${port}\nHUB_GATEWAY_TOKEN=${token}\nHUB_ALLOWED_ORIGINS=${origin}\nHUB_TARGETS_JSON='${target}'\n`,
        {flag: 'wx', mode: 0o600});
    const child = spawn('/staged/bin/node', ['--env-file=/scratch/test.env', 'dist-gateway/main.cjs'],
        {cwd: '/staged', env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    const close = once(child, 'close');
    close.catch(() => {});
    let ready;
    const listening = new Promise(resolve => { ready = resolve; });
    child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > 8192) process.exit(1);
        if (stdout.includes('\n')) ready();
    });
    child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stderr) > 8192) process.exit(1);
    });
    await deadline(Promise.race([listening, close.then(() => { throw Error('early close'); })]), 5000);
    assert.equal(stdout, `Diagnostic Hub gateway listening on ${host}:${port}. Place behind HTTPS for website use.\n`);
    ownedListener(child.pid, port);
    const agent = new http.Agent({keepAlive: true, maxSockets: 1, timeout: 5000});
    let socket, peerEnd;
    try {
        await deadline(new Promise((resolve, reject) => {
            const req = http.get({host, port, path: '/api/health', agent,
                headers: {origin, authorization: 'Bearer ' + token}}, res => {
                socket = res.socket;
                peerEnd = once(socket, 'end');
                peerEnd.catch(() => {});
                let body = '';
                res.on('data', chunk => {
                    body += chunk.toString('utf8');
                    if (Buffer.byteLength(body) > 4096) reject(Error('body limit'));
                });
                res.on('error', reject);
                res.on('end', () => {
                    try {
                        assert.equal(res.statusCode, 200);
                        assert.equal(res.headers['access-control-allow-origin'], origin);
                        assert.deepEqual(JSON.parse(body),
                            {version: '0.6.0', activeSessions: 0, connectionCancellation: true});
                        assert.ok(socket && !socket.destroyed);
                        resolve();
                    } catch (error) { reject(error); }
                });
            });
            req.on('error', reject);
        }), 2000);
        assert.ok(child.kill('SIGTERM'));
        await deadline(peerEnd, 2000);
        assert.deepEqual(await deadline(close, 4000), [0, null]);
        assert.equal(stderr, '');
        assert.equal(stdout.split('\n').length, 2);
        assert.throws(() => process.kill(-child.pid, 0), {code: 'ESRCH'});
        assert.ok(!fs.existsSync(`/proc/${child.pid}`));
        assert.ok(performance.now() - started < 15000);
        console.log('gateway-startup-and-teardown-pass');
    } finally {
        agent.destroy();
    }
}

run().then(() => clearTimeout(guard), () => process.exit(1));

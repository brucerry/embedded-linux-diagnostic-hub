import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createOwnedWebFiles } from './owned-web-files.mjs';
import { readCurrentGatewayBuildFile } from './current-gateway-build.mjs';
import { runSameJobGatewayHealthSmoke } from './gateway-same-job-health-smoke.mjs';
import {
    startGatewayRuntimeInputBridge,
    GATEWAY_RUNTIME_CHILD_FILES,
} from './gateway-runtime-input-bridge.mjs';

const retained = new Set();
const conflictKeys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'PYTHONPATH',
    'PYTHONHOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'SSLKEYLOGFILE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'OPENSSL_CONF',
    'OPENSSL_MODULES',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'npm_config_noproxy',
    'npm_config_cafile',
    'npm_config_ca',
    'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTPS_PROXY',
    'NPM_CONFIG_NOPROXY',
    'NPM_CONFIG_CAFILE',
    'NPM_CONFIG_CA',
];
const bindings = Object.freeze({
    filesystem: fs,
    launch: spawn,
    request: (...args) => http.request(...args),
    randomBytes,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (handle) => clearTimeout(handle),
    now: () => performance.now(),
    identity: () => ({
        platform: process.platform,
        arch: process.arch,
        uid: process.getuid?.(),
        executablePath: process.execPath,
        node: process.version,
    }),
    inherited: (key) => process.env[key],
    requireFrom: createRequire,
});
function absolute(value) {
    assert.ok(
        typeof value === 'string' &&
            value.startsWith('/') &&
            value !== '/' &&
            value.length <= 4096 &&
            !/[\\\x00-\x20\x7f]/.test(value),
    );
    assert.equal(path.posix.normalize(value), value);
}

/** Physical adapter, inert until called. Defaults are only trusted Node builtins; tests supply
 * explicit fake bindings. No permission changes, adoption, cleanup, retries or alternate route.
 * The caller selects committed script hashes/current producer inputs independently. This adapter
 * is not a CI authenticator and supplies no release, loaded-code or whole-group retirement proof.
 */
export function createGatewaySmokePhysicalAdapter(raw, native = bindings) {
    assert.deepEqual(
        Object.keys(raw).sort(),
        [
            'sourceRoot',
            'temporaryRoot',
            'uid',
            'nodePath',
            'pythonPath',
            'pythonSHA256',
            'sourceFiles',
        ].sort(),
    );
    for (const key of ['sourceRoot', 'temporaryRoot', 'nodePath', 'pythonPath']) absolute(raw[key]);
    assert.ok(Number.isSafeInteger(raw.uid) && raw.uid > 0);
    assert.deepEqual(Object.keys(raw.sourceFiles).sort(), [...GATEWAY_RUNTIME_CHILD_FILES].sort());
    for (const digest of [raw.pythonSHA256, ...Object.values(raw.sourceFiles)])
        assert.match(digest, /^[a-f0-9]{64}$/);
    const selected = structuredClone(raw);
    for (const key of [
        'identity',
        'inherited',
        'launch',
        'request',
        'randomBytes',
        'setTimer',
        'clearTimer',
        'now',
        'requireFrom',
    ])
        assert.equal(typeof native[key], 'function');
    for (const key of ['realpath', 'lstat', 'open', 'opendir', 'mkdir'])
        assert.equal(typeof native.filesystem?.[key], 'function');
    const identity = native.identity();
    assert.equal(identity.platform, 'linux');
    assert.equal(identity.arch, 'x64');
    assert.equal(identity.uid, selected.uid);
    assert.equal(identity.executablePath, selected.nodePath);
    assert.equal(identity.node, 'v24.22.2');
    for (const key of conflictKeys) {
        const value = native.inherited(key);
        assert.ok(
            value === undefined || value === '',
            'Inherited startup, proxy or trust conflict.',
        );
    }
    const handles = new Set(),
        unknown = new Set(),
        bridges = new Set(),
        children = [];
    let pending = 0,
        failed = false,
        first,
        used = false,
        installRoot,
        inputSubmitted = false,
        healthSubmitted = false,
        gatewayToken,
        healthRequests = 0;
    function bad(cause) {
        if (!failed) {
            failed = true;
            first = cause;
        }
        return Error('Gateway smoke physical operation failed; custody retained.', { cause });
    }
    function hold(value) {
        unknown.add(value);
        try {
            if (typeof value?.then === 'function') Promise.resolve(value).catch(() => {});
        } catch {}
    }
    // Do not async-normalize unsupported native returns; the original operation stays unknown.
    function forward(
        receiver,
        method,
        args,
        transform = (value) => value,
        optionalMissing = false,
    ) {
        pending++;
        let value;
        try {
            value = Reflect.apply(receiver[method], receiver, args);
        } catch (cause) {
            pending--;
            return Promise.reject(bad(cause));
        }
        try {
            if (!value || typeof value.then !== 'function') {
                hold(value);
                pending--;
                return Promise.reject(bad(Error('Unsupported synchronous filesystem return.')));
            }
        } catch (cause) {
            pending--;
            return Promise.reject(bad(cause));
        }
        return Promise.resolve(value)
            .then(transform, (cause) => {
                if (optionalMissing && cause?.code === 'ENOENT') return null;
                throw bad(cause);
            })
            .finally(() => {
                pending--;
            });
    }
    function wrapHandle(handle) {
        if (!handle || typeof handle.close !== 'function') {
            hold(handle);
            throw bad(Error('Unsupported native handle acquisition.'));
        }
        handles.add(handle);
        let closing;
        const result = {};
        for (const key of ['stat', 'sync', 'read', 'write'])
            if (typeof handle[key] === 'function')
                result[key] = (...args) => forward(handle, key, args);
        result.close = () => {
            if (!closing)
                closing = forward(handle, 'close', []).then((value) => {
                    assert.equal(value, undefined);
                    handles.delete(handle);
                });
            return closing;
        };
        return result;
    }
    function metadata(stat, directory = true) {
        assert.ok(
            stat && !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()),
        );
        assert.ok((stat.uid === 0 || stat.uid === selected.uid) && !(stat.mode & 0o7022));
        for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size'])
            assert.ok(Number.isSafeInteger(stat[key]) && stat[key] >= 0);
        assert.ok(stat.ino > 0);
        if (!directory) assert.equal(stat.nlink, 1);
        return stat;
    }
    async function parents(file, includeLeaf = false) {
        const endpoint = includeLeaf ? file : path.posix.dirname(file);
        const parts = endpoint.split('/').filter(Boolean);
        let current = '/';
        for (let i = -1; i < parts.length; i++) {
            if (i >= 0) current = path.posix.join(current, parts[i]);
            metadata(await forward(native.filesystem, 'lstat', [current]));
            assert.equal(await forward(native.filesystem, 'realpath', [current]), current);
        }
    }
    async function directoryPresent(directory) {
        let current = '/';
        const parts = directory.split('/').filter(Boolean);
        for (let i = -1; i < parts.length; i++) {
            if (i >= 0) current = path.posix.join(current, parts[i]);
            const stat = await forward(native.filesystem, 'lstat', [current], undefined, true);
            if (!stat) return false;
            metadata(stat);
            assert.equal(await forward(native.filesystem, 'realpath', [current]), current);
        }
        return true;
    }
    const files = createOwnedWebFiles({
        realpath: async (file) => {
            await parents(file);
            const stat = await forward(native.filesystem, 'lstat', [file]);
            metadata(stat, stat.isDirectory());
            return forward(native.filesystem, 'realpath', [file]);
        },
        lstat: async (file) => {
            await parents(file);
            return forward(native.filesystem, 'lstat', [file]);
        },
        open: async (file, flags) => {
            await parents(file);
            return forward(
                native.filesystem,
                'open',
                [file, flags, ...(flags & constants.O_CREAT ? [0o600] : [])],
                wrapHandle,
            );
        },
        opendir: async (file) => {
            await parents(file, true);
            return forward(native.filesystem, 'opendir', [file], wrapHandle);
        },
        mkdir: async (file) => {
            await parents(file);
            return forward(native.filesystem, 'mkdir', [file, { mode: 0o700, recursive: false }]);
        },
    });
    // Preserve the owned-file facade's exact nofollow/nonblock native flags.
    const filesystem = Object.freeze({
        ...files.filesystem,
        open(file, flags) {
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            return files.filesystem.open(file, 'r');
        },
    });
    const readFile = async (file, maximum) => {
        absolute(file);
        await parents(file);
        metadata(await files.filesystem.lstat(file), false);
        return readCurrentGatewayBuildFile(file, maximum, selected.uid, files.filesystem);
    };
    function watch(child) {
        const row = {
            child,
            exit: false,
            close: false,
            stdin: child.stdin === null,
            stdout: false,
            stderr: false,
            stdoutEnd: false,
            stderrEnd: false,
        };
        children.push(row); // Before listener acquisition can fail or reenter.
        const on = (emitter, event, callback) => {
            const value = emitter.once(event, callback);
            if (value !== emitter) {
                hold(value);
                throw Error('Unsupported listener registration.');
            }
        };
        on(child, 'exit', () => {
            row.exit = true;
        });
        on(child, 'close', () => {
            row.close = true;
        });
        on(child, 'error', (cause) => {
            bad(cause);
        });
        for (const key of ['stdin', 'stdout', 'stderr'])
            if (child[key]) {
                if (key !== 'stdin')
                    on(child[key], 'end', () => {
                        if (row[key]) bad(Error('Gateway smoke EOF after pipe closure.'));
                        row[key + 'End'] = true;
                    });
                on(child[key], 'close', () => {
                    if (key !== 'stdin' && !row[key + 'End'])
                        bad(Error('Gateway smoke pipe closed before EOF.'));
                    row[key] = true;
                });
                on(child[key], 'error', (cause) => {
                    bad(cause);
                });
            }
        return child;
    }
    function launch(file, args, options) {
        let child;
        try {
            child = native.launch(file, args, options);
            if (!child || typeof child.then === 'function') {
                hold(child);
                throw Error('Unsupported native child acquisition.');
            }
            return watch(child);
        } catch (cause) {
            throw bad(cause);
        }
    }
    const owner = Object.freeze({
        snapshot: () => ({
            pendingCalls: pending,
            nativeHandles: handles.size,
            unknownReturns: unknown.size,
            failed,
            files: files.owner.snapshot(),
            bridges: [...bridges].map((bridge) => bridge.snapshot()),
            children: children.map(
                ({ exit, close, stdin, stdout, stderr, stdoutEnd, stderrEnd }) => ({
                    exit,
                    close,
                    stdin,
                    stdout,
                    stderr,
                    stdoutEnd,
                    stderrEnd,
                }),
            ),
            wholeGroupRetirement: null,
            releaseAcceptance: false,
        }),
        get files() {
            return files.owner;
        },
        diagnostics: () => ({ first, unknown: [...unknown] }), // Private; never serialize into CI output.
    });
    retained.add(owner);
    function assertSettled() {
        assert.equal(pending + handles.size + unknown.size + bridges.size, 0);
        assert.ok(
            children.every(
                (row) =>
                    row.exit &&
                    row.close &&
                    row.stdin &&
                    row.stdout &&
                    row.stderr &&
                    row.stdoutEnd &&
                    row.stderrEnd,
            ),
        );
        files.owner.assertSettled();
        if (failed) throw Object.assign(bad(first), { owner });
        retained.delete(owner);
    }
    const ports = Object.freeze({
        filesystem,
        custody: owner,
        writeExclusive: (file, bytes) => files.filesystem.writeFile(file, bytes, { flag: 'wx' }),
        async installRuntimeInputs(request) {
            assert.ok(!inputSubmitted);
            inputSubmitted = true;
            installRoot = request.installRoot;
            absolute(installRoot);
            assert.ok(
                installRoot.startsWith(selected.temporaryRoot + '/') &&
                    !installRoot.startsWith(selected.sourceRoot + '/'),
            );
            await parents(selected.pythonPath);
            // The fixed system alias is resolved only as data; the selected executable itself
            // must be canonical, safe, executable and hash-matched by the bridge.
            await parents('/usr/bin/python3');
            const alias = await forward(native.filesystem, 'lstat', ['/usr/bin/python3']);
            assert.equal(alias.uid, 0);
            assert.equal(
                await forward(native.filesystem, 'realpath', ['/usr/bin/python3']),
                selected.pythonPath,
            );
            const python = metadata(await files.filesystem.lstat(selected.pythonPath), false);
            assert.ok(python.mode & 0o111);
            const bridge = startGatewayRuntimeInputBridge(
                {
                    sourceRoot: selected.sourceRoot,
                    pythonPath: selected.pythonPath,
                    pythonSHA256: selected.pythonSHA256,
                    uid: selected.uid,
                    sourceFiles: selected.sourceFiles,
                },
                request,
                {
                    readFile,
                    fileSnapshot: files.owner.snapshot,
                    setTimer: native.setTimer,
                    clearTimer: native.clearTimer,
                    now: native.now,
                    launch(file, args, options) {
                        assert.equal(file, selected.pythonPath);
                        assert.deepEqual(args, [
                            '-I',
                            '-B',
                            '-S',
                            selected.sourceRoot + '/scripts/ci/prepare-gateway-runtime-child.py',
                        ]);
                        assert.equal(options.cwd, selected.sourceRoot);
                        assert.equal(options.shell, false);
                        assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
                        assert.deepEqual(options.env, {
                            PATH: '/usr/bin:/bin',
                            LANG: 'C.UTF-8',
                            LC_ALL: 'C.UTF-8',
                            TZ: 'UTC',
                        });
                        return launch(file, args, options);
                    },
                },
            );
            bridges.add(bridge);
            const originals = await bridge.result;
            await bridge.closed;
            bridges.delete(bridge);
            return originals;
        },
        async resolveModule(parent, specifier) {
            assert.ok(
                installRoot &&
                    [
                        [installRoot + '/package.json', 'ssh2'],
                        [
                            installRoot + '/node_modules/ssh2/lib/protocol/constants.js',
                            'cpu-features',
                        ],
                        [
                            installRoot + '/node_modules/ssh2/lib/protocol/crypto.js',
                            './crypto/build/Release/sshcrypto.node',
                        ],
                    ].some(([p, s]) => p === parent && s === specifier),
            );
            await parents(parent);
            const resolver = native.requireFrom(parent);
            if (!resolver || typeof resolver.then === 'function') {
                hold(resolver);
                throw bad(Error('Unsupported module resolver.'));
            }
            assert.equal(typeof resolver.resolve, 'function');
            assert.equal(typeof resolver.resolve.paths, 'function');
            const lookup = resolver.resolve.paths(specifier);
            if (lookup !== null && (!Array.isArray(lookup) || lookup.length > 64)) {
                hold(lookup);
                throw bad(Error('Unsupported module lookup paths.'));
            }
            for (const directory of lookup ?? []) {
                absolute(directory);
                // Refuse existing lookup namespaces outside this installation, without reading members.
                if (await directoryPresent(directory))
                    assert.ok(
                        directory.startsWith(installRoot + '/'),
                        'External module lookup directory exists.',
                    );
            }
            const resolved = resolver.resolve(specifier); // Resolution only; never imports SSH2.
            if (typeof resolved !== 'string') {
                hold(resolved);
                throw bad(Error('Unsupported module resolution.'));
            }
            return resolved;
        },
        randomBytes: (length) => native.randomBytes(length),
        setTimer: (callback, delay) => native.setTimer(callback, delay),
        clearTimer: (timer) => native.clearTimer(timer),
        now: () => native.now(),
        launch(file, args, options) {
            assert.ok(!healthSubmitted && installRoot && bridges.size === 0);
            healthSubmitted = true;
            assert.equal(file, selected.nodePath);
            assert.deepEqual(args, [installRoot + '/dist-gateway/main.cjs']);
            assert.equal(options.cwd, installRoot);
            assert.equal(options.shell, false);
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
            assert.deepEqual(
                Object.keys(options.env).sort(),
                [
                    'PATH',
                    'LANG',
                    'LC_ALL',
                    'TZ',
                    'NODE_ENV',
                    'HUB_GATEWAY_HOST',
                    'HUB_GATEWAY_PORT',
                    'HUB_GATEWAY_TOKEN',
                    'HUB_ALLOWED_ORIGINS',
                    'HUB_TARGETS_JSON',
                ].sort(),
            );
            assert.equal(
                options.env.PATH,
                path.posix.dirname(selected.nodePath) + ':/usr/bin:/bin',
            );
            assert.equal(options.env.LANG, 'C.UTF-8');
            assert.equal(options.env.LC_ALL, 'C.UTF-8');
            assert.equal(options.env.TZ, 'UTC');
            assert.equal(options.env.NODE_ENV, 'production');
            assert.equal(options.env.HUB_GATEWAY_HOST, '127.0.0.1');
            assert.equal(options.env.HUB_GATEWAY_PORT, '58731');
            assert.match(options.env.HUB_GATEWAY_TOKEN, /^[a-f0-9]{64}$/);
            assert.equal(options.env.HUB_ALLOWED_ORIGINS, 'http://127.0.0.1');
            assert.equal(
                options.env.HUB_TARGETS_JSON,
                JSON.stringify([
                    { host: '127.0.0.1', port: 58732, fingerprint: 'SHA256:' + 'A'.repeat(43) },
                ]),
            );
            gatewayToken = options.env.HUB_GATEWAY_TOKEN;
            return launch(file, args, options);
        },
        request(options, callback) {
            assert.ok(healthSubmitted && healthRequests < 3);
            assert.deepEqual(
                Object.keys(options).sort(),
                [
                    'protocol',
                    'hostname',
                    'port',
                    'family',
                    'method',
                    'path',
                    'agent',
                    'maxHeaderSize',
                    'headers',
                ].sort(),
            );
            assert.equal(options.protocol, 'http:');
            assert.equal(options.hostname, '127.0.0.1');
            assert.equal(options.port, 58731);
            assert.equal(options.family, 4);
            assert.equal(options.method, 'GET');
            assert.equal(options.path, '/api/health');
            assert.equal(options.agent, false);
            assert.equal(options.maxHeaderSize, 8192);
            assert.deepEqual(options.headers, {
                Origin: healthRequests === 2 ? 'http://127.0.0.2' : 'http://127.0.0.1',
                Connection: 'close',
                ...(healthRequests === 1 ? {} : { Authorization: 'Bearer ' + gatewayToken }),
            });
            healthRequests++; // Before request acquisition; no resubmission after uncertainty.
            return native.request(options, callback);
        },
        assertSettled,
    });
    return Object.freeze({
        owner,
        ports,
        async run(input) {
            assert.ok(!used);
            used = true;
            assert.equal(input.sourceRoot, selected.sourceRoot);
            assert.equal(input.temporaryRoot, selected.temporaryRoot);
            assert.equal(input.uid, selected.uid);
            assert.equal(input.builder.runtime.executablePath, selected.nodePath);
            try {
                return await runSameJobGatewayHealthSmoke(input, ports);
            } catch (cause) {
                throw Object.assign(bad(cause), { owner });
            }
        },
    });
}

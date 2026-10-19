// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { lookupPilotTool, prerequisiteFailure } from '../scripts/lib/pilot-tool-lookup.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';
import { digest } from '../scripts/lib/windows-preflight.mjs';
const selected = 'C:\\Program Files\\Git\\bin\\git.exe';
function fixture(result, requestedTool = 'git.exe', overrides = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-lookup-'));
    const journal = new PilotEvidence(root);
    const rows = [],
        states = [],
        launches = [];
    let referenced = false,
        held;
    const record = (stage, data) => {
        rows.push({ stage, data });
        journal.append(stage, data);
        return overrides.afterRecord?.(stage, data);
    };
    const onProcessState = (state) => {
        states.push(state);
        if (!state.closed) {
            held = createOwnershipHold({ kind: 'controlled-lookup-unknown', state }, record, {
                interval: () => ({
                    ref() {
                        referenced = true;
                    },
                }),
            });
        }
    };
    const run = () =>
        lookupPilotTool(requestedTool, {
            record,
            ordinal: requestedTool === 'git.exe' ? 1 : 2,
            workDeadline: 10000,
            clock: () => 500,
            clockDomain: 'controlled-monotonic-ms',
            onProcessState,
            spawn: (...args) => {
                launches.push(args);
                if (result instanceof Error) throw result;
                return result;
            },
            realpath: (p) => p,
            absolute: path.win32.isAbsolute,
            identity: (p) => ({ path: p, sha256: 'a'.repeat(64), pe: { architecture: 'x64' } }),
            inheritedEnvironment: { Path: 'C:\\tools;' + 'x'.repeat(5000), SECRET: 'not retained' },
            cwd: 'D:\\source',
            ...overrides.options,
        });
    return {
        run,
        rows,
        states,
        launches,
        get held() {
            return held;
        },
        get referenced() {
            return referenced;
        },
        close() {
            const closure = journal.close();
            assert.equal(closure.complete, true);
            const persisted = fs
                .readFileSync(path.join(root, 'pilot.jsonl'), 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map(JSON.parse);
            assert.deepEqual(
                persisted.map(({ stage, data }) => ({ stage, data })),
                rows,
            );
            fs.rmSync(root, { recursive: true });
        },
    };
}
const good = {
    pid: 412,
    status: 0,
    signal: null,
    stdout: selected + '\r\nC:\\other\\git.exe\r\n',
    stderr: '',
};
for (const tool of ['git.exe', 'pwsh.exe'])
    test('lookup retains launch, result and first selected identity for ' + tool, async () => {
        const f = fixture(good, tool);
        try {
            assert.equal(await f.run(), selected);
            assert.deepEqual(f.launches, [
                [
                    'where.exe',
                    [tool],
                    { windowsHide: true, encoding: 'utf8', timeout: 2000, maxBuffer: 8192 },
                ],
            ]);
            assert.equal(f.states[0].closed, true);
            assert.equal(f.held, undefined);
            const start = f.rows[0].data;
            assert.equal(start.requestedTool, tool);
            assert.equal(start.resolverIdentity.available, false);
            assert.equal(start.inheritedPATH.truncated, true);
            assert.equal(Buffer.from(start.inheritedPATH.prefixBase64, 'base64').length, 4096);
            assert(!JSON.stringify(f.rows).includes('not retained'));
            const raw = f.rows.find(
                (r) => r.stage === 'tool-lookup-output' && r.data.stream === 'stdout',
            ).data;
            assert.equal(Buffer.from(raw.base64, 'base64').toString(), good.stdout);
            const result = f.rows.find((r) => r.stage === 'tool-lookup-result').data;
            assert.equal(result.streams.stdout.sha256, digest(Buffer.from(good.stdout)));
            assert.equal(f.rows.at(-1).stage, 'tool-lookup-identity');
            assert.equal(f.rows.at(-1).data.identity.path, selected);
        } finally {
            f.close();
        }
    });
test('nonzero status retains exact tool and stderr before refusal, with known command return', async () => {
    const f = fixture(
        {
            ...good,
            status: 1,
            stdout: '',
            stderr: 'INFO: Could not find files for the given pattern(s).\r\n',
        },
        'pwsh.exe',
    );
    try {
        await assert.rejects(f.run, /pwsh.exe/);
        assert.equal(f.states[0].closed, true);
        assert(!f.held);
        const r = f.rows.find((r) => r.stage === 'tool-lookup-result').data;
        assert.equal(r.status, 1);
        assert.equal(r.error, null);
        assert.equal(
            Buffer.from(
                f.rows.find((r) => r.stage === 'tool-lookup-output' && r.data.stream === 'stderr')
                    .data.base64,
                'base64',
            ).toString(),
            'INFO: Could not find files for the given pattern(s).\r\n',
        );
    } finally {
        f.close();
    }
});
for (const code of ['ETIMEDOUT', 'ENOBUFS', 'ENOENT'])
    test(code + ' latches a referenced uncertainty hold before result persistence', async () => {
        const error = Object.assign(Error('controlled ' + code), {
            code,
            errno: -1,
            syscall: 'spawnSync where.exe',
        });
        const f = fixture({
            ...good,
            error,
            status: null,
            stdout: 'partial λ',
            stderr: 'partial failure',
        });
        try {
            await assert.rejects(f.run, /git.exe/);
            assert(f.held && f.referenced);
            assert.equal(f.states[0].closed, false);
            const hold = f.rows.findIndex((r) => r.stage === 'ownership-held.json');
            const result = f.rows.findIndex((r) => r.stage === 'tool-lookup-result');
            assert(hold >= 0 && hold < result);
            assert.equal(f.rows[result].data.error.code, code);
            assert.equal(
                f.rows[result].data.streams.stdout.sha256,
                digest(Buffer.from('partial λ')),
            );
        } finally {
            f.close();
        }
    });
test('thrown spawn error is retained and cannot assert closure', async () => {
    const f = fixture(Object.assign(Error('spawn threw'), { code: 'EACCES' }));
    try {
        await assert.rejects(f.run, /git.exe/);
        assert(f.referenced);
        assert.equal(f.states[0].closed, false);
        assert.equal(f.rows.at(-1).data.error.code, 'EACCES');
    } finally {
        f.close();
    }
});
test('signal-only return latches hold before ordinary admission refusal', async () => {
    const f = fixture({ ...good, status: null, signal: 'SIGTERM' });
    try {
        await assert.rejects(f.run);
        assert(f.referenced);
        assert.equal(f.rows.at(-1).data.signal, 'SIGTERM');
    } finally {
        f.close();
    }
});
test('output prefixes and error fields stay bounded with explicit truncation', async () => {
    const error = Object.assign(Error('x'.repeat(6000)), { code: 'E'.repeat(500) });
    const f = fixture({
        ...good,
        status: null,
        error,
        stdout: 'λ'.repeat(10000),
        stderr: 'y'.repeat(30000),
    });
    try {
        await assert.rejects(f.run);
        const r = f.rows.at(-1).data;
        assert.equal(r.error.message.length, 1024);
        assert.equal(r.error.code.length, 128);
        for (const stream of ['stdout', 'stderr']) {
            assert.equal(r.streams[stream].retainedBytes, 8192);
            assert.equal(r.streams[stream].truncated, true);
        }
        for (const r of f.rows) assert(Buffer.byteLength(JSON.stringify(r)) < 65536);
    } finally {
        f.close();
    }
});
test('successful command with malformed output refuses without inventing a selected identity', async () => {
    const f = fixture({ ...good, stdout: 'relative.exe\r\n"C:\\quoted.exe"\r\n' });
    try {
        await assert.rejects(f.run, /no acceptable absolute path/);
        assert.equal(f.states[0].closed, true);
        assert(!f.rows.some((r) => r.stage === 'tool-lookup-identity'));
    } finally {
        f.close();
    }
});
test('selected path remains retained if realpath or executable identity validation fails', async () => {
    for (const step of ['realpath', 'identity']) {
        const f = fixture(good, 'git.exe', {
            options: {
                [step]: () => {
                    throw Error('controlled ' + step);
                },
            },
        });
        try {
            await assert.rejects(f.run, new RegExp(step));
            assert.equal(f.rows.at(-1).stage, 'tool-lookup-selection');
            assert.equal(f.rows.at(-1).data.selected, selected);
        } finally {
            f.close();
        }
    }
});
test('unknown process hold survives later diagnostic persistence refusal', async () => {
    const f = fixture({ ...good, status: null, error: Error('timeout') }, 'git.exe', {
        afterRecord: (stage) => {
            if (stage === 'tool-lookup-output') throw Error('receipt refused');
        },
    });
    try {
        await assert.rejects(f.run, /receipt refused/);
        assert(f.held && f.referenced);
        assert.equal(f.states[0].closed, false);
    } finally {
        f.close();
    }
});
test('first receipt refusal prevents the lookup from launching', async () => {
    const f = fixture(good, 'git.exe', {
        afterRecord: (stage) => {
            if (stage === 'tool-lookup-start') throw Error('start refused');
        },
    });
    try {
        await assert.rejects(f.run, /start refused/);
        assert.equal(f.launches.length, 0);
    } finally {
        f.close();
    }
});
test('entry failure diagnostics retain the original stack and named prerequisite within fixed caps', async () => {
    const error = Error('x'.repeat(5000));
    error.stack = 'original stack ' + 's'.repeat(8000);
    const d = prerequisiteFailure(error, 'runtime-identity:winptyDll');
    assert.equal(d.prerequisite, 'runtime-identity:winptyDll');
    assert.equal(d.error.length, 2048);
    assert.equal(d.stack.length, 4096);
    assert(d.stack.startsWith('original stack'));
    assert.equal(prerequisiteFailure('non-error', 'early').stack, null);
});
test('actual entry lookup callback holds uncertainty before forwarding a failed command receipt', async () => {
    const source = fs.readFileSync(
        new URL('../scripts/windows-native-pilot.mts', import.meta.url),
        'utf8',
    );
    const start = source.indexOf('        let lookupOrdinal = 0;');
    const end = source.indexOf('        const git = await where(', start);
    const calls = [];
    let prerequisite = '';
    const ctx = {
        productClock: { now: () => 500 },
        startedAt: 0,
        pilotLimits: { totalMs: 600000, reserveMs: 60000 },
        lookupPilotTool,
        admitEarly() {},
        entryRecord(stage, data) {
            calls.push(stage);
        },
        hold(state) {
            calls.push(state.kind);
        },
        set prerequisite(v) {
            prerequisite = v;
        },
    };
    // Execute the production entry callback with only the lookup transport replaced.
    ctx.lookupPilotTool = (name, options) =>
        lookupPilotTool(name, {
            ...options,
            spawn: () => ({ ...good, status: null, error: Error('controlled timeout') }),
        });
    const where = vm.runInNewContext(source.slice(start, end) + 'where', ctx);
    await assert.rejects(() => where('git.exe'), /git.exe/);
    assert.equal(prerequisite, 'tool-lookup:git.exe');
    assert(calls.indexOf('pilot-prerequisite-query-unknown') < calls.indexOf('tool-lookup-output'));
});

test('actual CLI runtime-selector refusal retains a bounded top-level stack before evidence setup', async () => {
    const env = { ...process.env };
    delete env.HUB_WINDOWS_NATIVE_PILOT;
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/windows-native-pilot.mts'], {
        env,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
    });
    assert.equal(r.status, 1);
    assert.equal(r.error, undefined);
    const receipt = r.stderr
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .find((r) => r?.kind === 'pilot-top-level-failure');
    assert(receipt);
    assert.match(receipt.error, /Separate native pilot selector required/);
    assert.match(receipt.stack, /requirePilotRuntimeReady/);
    assert.equal(receipt.prerequisite, 'pre-entry-runtime-gate-or-unhandled');
    assert(receipt.stack.length <= 4096);
});

test('long cwd and selected identity paths retain bounded prefixes with full-value hashes', async () => {
    const long = 'C:\\' + '界'.repeat(2500);
    const f = fixture({ ...good, stdout: long + '\r\n' }, 'git.exe', {
        options: {
            cwd: long,
            identity: (p) => ({
                path: p,
                realpath: p,
                sha256: 'a'.repeat(64),
                pe: { architecture: 'x64' },
            }),
        },
    });
    try {
        assert.equal(await f.run(), long);
        assert.equal(f.rows[0].data.cwdTruncated, true);
        const identity = f.rows.at(-1).data;
        assert.deepEqual(identity.truncatedIdentityFields, ['path', 'realpath']);
        assert.equal(identity.identity.path.length, 1024);
        assert.equal(
            f.rows.find((r) => r.stage === 'tool-lookup-selection').data.selectedSHA256,
            digest(Buffer.from(long)),
        );
        for (const r of f.rows) assert(Buffer.byteLength(JSON.stringify(r)) < 65536);
    } finally {
        f.close();
    }
});

test('success-shaped truncated output never grants a selected path', async () => {
    const f = fixture({ ...good, stdout: selected + '\r\n' + 'x'.repeat(9000) });
    try {
        await assert.rejects(f.run, /output incomplete/);
        assert.equal(f.states[0].closed, true);
        assert(!f.rows.some((r) => r.stage === 'tool-lookup-selection'));
    } finally {
        f.close();
    }
});
test('inconsistent zero status with a signal holds and refuses instead of returning a capability', async () => {
    const f = fixture({ ...good, signal: 'SIGTERM' });
    try {
        await assert.rejects(f.run, /lookup failed/);
        assert(f.held && f.referenced);
        assert.equal(f.states[0].closed, false);
        assert(!f.rows.some((r) => r.stage === 'tool-lookup-selection'));
    } finally {
        f.close();
    }
});
test('missing text output never grants a path even with zero status', async () => {
    const f = fixture({ ...good, stderr: undefined });
    try {
        await assert.rejects(f.run, /output incomplete/);
        assert.equal(
            f.rows.find((r) => r.stage === 'tool-lookup-result').data.streams.stderr.decodedText,
            false,
        );
    } finally {
        f.close();
    }
});
test('lookup requires the correct immutable ordinal and a finite absolute cutoff before launch', async () => {
    for (const options of [{ ordinal: 2 }, { workDeadline: Infinity }]) {
        const f = fixture(good, 'git.exe', { options });
        try {
            await assert.rejects(f.run);
            assert.equal(f.launches.length, 0);
            assert.equal(f.rows.length, 0);
        } finally {
            f.close();
        }
    }
});
test('timeout is clipped after awaited start persistence and timings use the original cutoff', async () => {
    let now = 500;
    const f = fixture(good, 'git.exe', {
        options: { clock: () => now },
        afterRecord: async (stage) => {
            if (stage === 'tool-lookup-start') {
                await Promise.resolve();
                now = 9990;
            }
        },
    });
    try {
        assert.equal(await f.run(), selected);
        assert.equal(f.launches[0][2].timeout, 10);
        const start = f.rows[0].data;
        const result = f.rows.find((r) => r.stage === 'tool-lookup-result').data;
        assert.equal(start.startedAt, 500);
        assert.equal(start.maxTimeoutMs, 2000);
        assert.equal(result.spawnStartedAt, 9990);
        assert.equal(result.completedAt, 9990);
        assert.equal(result.timeoutMs, 10);
        assert.equal(result.workDeadline, 10000);
        assert.equal(result.ordinal, 1);
        assert.equal(result.clockDomain, 'controlled-monotonic-ms');
    } finally {
        f.close();
    }
});
test('pending start receipt cannot launch a query and a crossed cutoff is checked when it resolves', async () => {
    let now = 500,
        release;
    const gate = new Promise((r) => (release = r));
    const f = fixture(good, 'git.exe', {
        options: { clock: () => now },
        afterRecord: (stage) => (stage === 'tool-lookup-start' ? gate : undefined),
    });
    const pending = f.run();
    try {
        await new Promise(setImmediate);
        assert.equal(f.launches.length, 0);
        now = 10000;
        release();
        await assert.rejects(() => pending, /cutoff expired/);
        assert.equal(f.launches.length, 0);
    } finally {
        release();
        await pending.catch(() => {});
        f.close();
    }
});
test('pre-existing cancellation prevents request persistence and spawn', async () => {
    const f = fixture(good, 'git.exe', {
        options: {
            check() {
                throw Error('controlled cancel');
            },
        },
    });
    try {
        await assert.rejects(f.run, /controlled cancel/);
        assert.equal(f.launches.length, 0);
        assert.equal(f.rows.length, 0);
    } finally {
        f.close();
    }
});
test('cancellation delivered by awaited request receipt prevents spawn', async () => {
    let cancelled = false;
    const f = fixture(good, 'git.exe', {
        options: {
            check() {
                if (cancelled) throw Error('controlled cancel');
            },
        },
        afterRecord: async (stage) => {
            if (stage === 'tool-lookup-start') {
                await Promise.resolve();
                cancelled = true;
            }
        },
    });
    try {
        await assert.rejects(f.run, /controlled cancel/);
        assert.equal(f.launches.length, 0);
    } finally {
        f.close();
    }
});
test('cancellation during a lookup is checked after result latching and durable raw receipts', async () => {
    let cancelled = false,
        spawned = 0;
    const f = fixture(good, 'git.exe', {
        options: {
            check() {
                if (cancelled) throw Error('controlled cancel');
            },
            spawn() {
                spawned++;
                cancelled = true;
                return good;
            },
        },
    });
    try {
        await assert.rejects(f.run, /controlled cancel/);
        assert.equal(spawned, 1);
        assert.equal(f.states.length, 1);
        assert.equal(f.states[0].closed, true);
        assert.equal(f.rows.at(-1).stage, 'tool-lookup-result');
        assert(!f.rows.some((r) => r.stage === 'tool-lookup-selection'));
    } finally {
        f.close();
    }
});
for (const stage of ['tool-lookup-result', 'tool-lookup-selection', 'tool-lookup-identity'])
    test('awaited ' + stage + ' crossing the cutoff prevents downstream admission', async () => {
        let now = 500;
        const f = fixture(good, 'git.exe', {
            options: { clock: () => now },
            afterRecord: async (s) => {
                if (s === stage) {
                    await Promise.resolve();
                    now = 10000;
                }
            },
        });
        try {
            await assert.rejects(f.run, /cutoff expired/);
            assert.equal(f.rows.at(-1).stage, stage);
            assert.equal(f.states[0].closed, true);
        } finally {
            f.close();
        }
    });
async function actualEntrySequence(results) {
    const source = fs.readFileSync(
        new URL('../scripts/windows-native-pilot.mts', import.meta.url),
        'utf8',
    );
    const a = source.indexOf('        let lookupOrdinal = 0;'),
        b = source.indexOf("        prerequisite = 'git-root-and-winpty-paths';", a);
    assert(a > 0 && b > a);
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-lookup-sequence-'));
    const journal = new PilotEvidence(root);
    const rows = [],
        tools = [],
        states = [];
    let laterStage = false,
        referenced = false,
        held;
    const record = (stage, data) => {
        rows.push({ stage, data });
        journal.append(stage, data);
    };
    const ctx = {
        productClock: { now: () => 500 },
        startedAt: 0,
        pilotLimits: { totalMs: 600000, reserveMs: 60000 },
        contract: { interpreter: { path: 'C:\\Windows\\powershell.exe' } },
        admitEarly() {},
        entryRecord: record,
        prerequisite: '',
        hold(state) {
            held = createOwnershipHold(state, record, {
                interval: () => ({
                    ref() {
                        referenced = true;
                    },
                }),
            });
        },
        lookupPilotTool(name, options) {
            return lookupPilotTool(name, {
                ...options,
                spawn(command, args, launch) {
                    tools.push(name);
                    assert.equal(launch.timeout, 2000);
                    return results[name];
                },
                absolute: path.win32.isAbsolute,
                realpath: (p) => p,
                identity: (p) => ({ path: p, sha256: 'a'.repeat(64), pe: { architecture: 'x64' } }),
                onProcessState(state) {
                    states.push(state);
                    options.onProcessState(state);
                },
            });
        },
    };
    let result, error;
    try {
        result = await vm.runInNewContext(
            '(async()=>{' + source.slice(a, b) + 'return {git,pwsh};})()',
            ctx,
        );
        laterStage = true;
    } catch (e) {
        error = String(e);
    } finally {
        const closure = journal.close();
        assert.equal(closure.complete, true);
        fs.rmSync(root, { recursive: true });
    }
    return { rows, tools, states, laterStage, result, error, held: Boolean(held), referenced };
}
test('actual production entry awaits successful Git then pwsh with deterministic ordered receipts', async () => {
    const r = await actualEntrySequence({
        'git.exe': good,
        'pwsh.exe': { ...good, stdout: 'C:\\tools\\pwsh.exe\r\n' },
    });
    assert.equal(r.error, undefined);
    assert.equal(r.laterStage, true);
    assert.deepEqual(r.tools, ['git.exe', 'pwsh.exe']);
    const starts = r.rows.filter((r) => r.stage === 'tool-lookup-start');
    assert.deepEqual(
        starts.map((r) => r.data.ordinal),
        [1, 2],
    );
    assert.deepEqual(
        starts.map((r) => r.data.requestedTool),
        ['git.exe', 'pwsh.exe'],
    );
    assert(
        r.rows.findIndex((r) => r.stage === 'tool-lookup-identity' && r.data.ordinal === 1) <
            r.rows.findIndex((r) => r.stage === 'tool-lookup-start' && r.data.ordinal === 2),
    );
});
for (const failed of ['git.exe', 'pwsh.exe'])
    test(
        'actual entry failure at ' + failed + ' prevents later lookup/preparation admission',
        async () => {
            const r = await actualEntrySequence({
                'git.exe':
                    failed === 'git.exe' ? { ...good, status: 1, stderr: 'git refused' } : good,
                'pwsh.exe': { ...good, status: 1, stderr: 'pwsh refused' },
            });
            assert.match(r.error, new RegExp(failed));
            assert.equal(r.laterStage, false);
            assert.deepEqual(r.tools, failed === 'git.exe' ? ['git.exe'] : ['git.exe', 'pwsh.exe']);
            const result = r.rows.filter((r) => r.stage === 'tool-lookup-result').at(-1);
            assert.equal(result.data.requestedTool, failed);
            assert.equal(result.data.status, 1);
            assert.equal(r.held, false);
        },
    );

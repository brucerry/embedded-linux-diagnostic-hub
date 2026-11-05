import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync, constants } from 'node:fs';
import { OwnedGatewayStage } from '../scripts/lib/owned-gateway-stage.mjs';
import { createDiagnosticGatewayExecution, validateDiagnosticGatewayContext, DIAGNOSTIC_GATEWAY_BRANCH } from '../scripts/lib/diagnostic-gateway-execution.mjs';
import { startDiagnosticGatewayCommand, GATEWAY_COMMAND_BOUNDS } from '../scripts/lib/diagnostic-gateway-command.mjs';
import { DIAGNOSTIC_GATEWAY_POLICY } from '../scripts/lib/diagnostic-gateway-inspection.mjs';
import { produceGatewayArchive } from '../scripts/lib/gateway-archive-producer.mjs';
import { pipelineFixture, memoryFilesystem } from './fixtures/gateway-producer-memory';

function filesFixture(f = memoryFilesystem()) {
    const controls: any = {},
        directories = new Set<any>(),
        events: string[] = [];
    f.write('/project/file', Buffer.from('abc'));
    f.write('/tools/git', Buffer.from('authored Git executable bytes, never run'));
    const native: any = {
        ...f.fs,
        async open(p: string, flags: number) {
            assert.ok(flags & constants.O_NOFOLLOW);
            if (controls.openHold) await controls.openHold.promise;
            if (controls.openError) throw controls.openError;
            if (flags & constants.O_DIRECTORY) {
                const h: any = {
                    async stat() {
                        return f.fs.lstat(p);
                    },
                    async sync() {
                        events.push('directory.sync');
                        if (controls.dirSyncError) throw controls.dirSyncError;
                    },
                    async close() {
                        events.push('directory.close');
                        if (controls.dirCloseError) throw controls.dirCloseError;
                        directories.delete(h);
                    },
                };
                directories.add(h);
                return h;
            }
            const h = await f.fs.open(p, flags & constants.O_EXCL ? 'wx' : 'r');
            return {
                ...h,
                async read(...a: [Buffer, number, number]) {
                    if (controls.readError) throw controls.readError;
                    return h.read(...a);
                },
                async write(buffer: Buffer, offset: number, length: number, position: number) {
                    if (controls.writeError) throw controls.writeError;
                    const n = controls.partial ? Math.min(length, controls.partial) : length;
                    const old = f.bytes(p),
                        next = Buffer.alloc(Math.max(old.length, position + n));
                    old.copy(next);
                    buffer.copy(next, position, offset, offset + n);
                    f.write(p, next);
                    return { bytesWritten: n };
                },
                async sync() {
                    events.push('file.sync');
                    if (controls.syncError) throw controls.syncError;
                },
                async close() {
                    events.push('file.close');
                    if (controls.closeHold) await controls.closeHold.promise;
                    if (controls.closeError) throw controls.closeError;
                    await h.close();
                },
            };
        },
        async opendir(p: string) {
            const rows = await f.fs.readdir(p);
            let at = 0;
            const h = {
                async read() {
                    if (controls.dirReadError) throw controls.dirReadError;
                    return rows[at++] ?? null;
                },
                async close() {
                    if (controls.dirCloseError) throw controls.dirCloseError;
                    directories.delete(h);
                },
            };
            directories.add(h);
            return h;
        },
    };
    return { ...f, controls, native, directories, events };
}
const context = () => ({ repository: 'brucerry/embedded-linux-diagnostic-hub', private: false,
    ref: 'refs/heads/' + DIAGNOSTIC_GATEWAY_BRANCH, event: 'push', attempt: '1', runner: 'github-hosted',
    system: 'Linux', arch: 'X64', sha: 'a'.repeat(40), run: '12345', policy: DIAGNOSTIC_GATEWAY_POLICY });
const environment = { PATH: '/tools/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
const selection = () => ({ context: context(), root: '/project', gitPath: '/usr/bin/git', gitSHA256: 'b'.repeat(64),
    nodePath: '/tools/bin/node', esbuildPath: '/project/node_modules/esbuild/bin/esbuild',
    npmPath: '/tools/lib/node_modules/npm/bin/npm-cli.js', environment });
const plan = (role = 'build') => Object.freeze({ owner: 'c'.repeat(32), id: role === 'build' ? 1 : 2, role,
    cwd: role === 'build' ? '/project' : '/project/validation/gateway-diagnostic/stage',
    command: Object.freeze(role === 'build' ? ['/tools/bin/node', '/project/node_modules/esbuild/bin/esbuild', '/project/gateway/main.ts',
        '--bundle', '--platform=node', '--format=cjs', '--outfile=/project/validation/gateway-diagnostic/build/main.cjs', '--external:ssh2']
        : ['/tools/bin/node', '/tools/lib/node_modules/npm/bin/npm-cli.js', 'install', '--package-lock-only', '--offline', '--ignore-scripts',
            '--omit=optional', '--no-audit', '--no-fund', '--global=false', '--workspaces=false',
            '--prefix=/project/validation/gateway-diagnostic/stage', '--cache=/project/validation/gateway-diagnostic/cache',
            '--userconfig=/project/validation/gateway-diagnostic/config/user.npmrc', '--globalconfig=/project/validation/gateway-diagnostic/config/global.npmrc']) });
function fixture() {
    const children: any[] = [], timers: Function[] = [], calls: any[] = [];
    let now = 0;
    const forbidden = () => assert.fail('No native file operation admitted');
    const ports: any = {
        filesystem: Object.fromEntries(['realpath', 'lstat', 'open', 'opendir', 'mkdir'].map((k) => [k, forbidden])),
        launch(file: string, args: string[], options: any) {
            calls.push([file, args, options]);
            const child: any = new EventEmitter(); Object.assign(child, { pid: 123 + children.length, exitCode: null, signalCode: null, stdin: null,
                stdout: new EventEmitter(), stderr: new EventEmitter() }); children.push(child); return child;
        },
        setTimer(fn: Function, ms: number) { assert.ok([480000, 120000].includes(ms)); timers.push(fn); return timers.length; },
        clearTimer() {}, now: () => now,
    };
    const close = (child: any, code = 0) => { child.stdout.emit('close'); child.stderr.emit('close'); child.emit('exit', code, null); child.emit('close', code, null); };
    return { ports, children, calls, close, expire: () => { now = 480001; timers[0](); } };
}
test('diagnostic command success waits for both pipes, exit and actual child close', async () => {
    const f = fixture(), o = startDiagnosticGatewayCommand(plan(), environment, f.ports), c = f.children[0];
    c.emit('spawn'); c.emit('exit', 0, null); c.emit('close', 0, null); c.stdout.emit('close');
    assert.equal(o.snapshot().directRetired, false); c.stderr.emit('close');
    const r = await o.result; await o.closed;
    assert.equal(r.lifecycle.closeObserved, true); assert.equal(r.lifecycle.code, 0);
    assert.equal(o.snapshot().processGroupRetirement, null); assert.equal(o.snapshot().listeners, 0);
});
test('deadline preserves custody and never signals, then late direct close cannot become success', async () => {
    const f = fixture(), o = startDiagnosticGatewayCommand(plan(), environment, f.ports), c = f.children[0];
    c.kill = () => assert.fail('No signal permitted'); c.emit('spawn'); f.expire();
    await assert.rejects(o.result); assert.equal(o.snapshot().directRetired, false);
    f.close(c); await o.closed; await assert.rejects(o.result);
});
test('overflow drains bounded output and requires acknowledged closure', async () => {
    const f = fixture(), o = startDiagnosticGatewayCommand(plan(), environment, f.ports), c = f.children[0]; c.emit('spawn');
    c.stderr.emit('data', Buffer.alloc(GATEWAY_COMMAND_BOUNDS.build.stderr + 1));
    await assert.rejects(o.result); assert.equal(o.snapshot().directRetired, false);
    c.stderr.emit('data', Buffer.alloc(1024)); f.close(c); await o.closed;
});
test('async timer registration blocks dispatch and cannot retire unknown ownership', async () => {
    const f = fixture(); f.ports.setTimer = () => Promise.resolve(1);
    const o = startDiagnosticGatewayCommand(plan(), environment, f.ports);
    await assert.rejects(o.result); assert.equal(f.calls.length, 0); assert.equal(o.snapshot().directRetired, false);
});
test('rejected or unacknowledged launch remains owned without replay', async () => {
    const f = fixture(); f.ports.launch = () => { throw Error('authored uncertain dispatch'); };
    const cap = createDiagnosticGatewayExecution(selection(), f.ports);
    await assert.rejects(cap.execute(plan())); await assert.rejects(cap.execute(plan()));
    assert.equal(cap.snapshot().commandOwners, 1); assert.equal(cap.snapshot().failed, true);
    assert.throws(() => cap.assertSettled());
});
test('nonzero or inconsistent closure cannot yield a stage acknowledgement', async () => {
    for (const mode of ['nonzero', 'inconsistent', 'missing-spawn']) {
        const f = fixture(), o = startDiagnosticGatewayCommand(plan(), environment, f.ports), c = f.children[0];
        if (mode !== 'missing-spawn') c.emit('spawn');
        c.stdout.emit('close'); c.stderr.emit('close'); c.emit('exit', mode === 'nonzero' ? 1 : 0, null);
        c.emit('close', mode === 'inconsistent' ? 1 : mode === 'nonzero' ? 1 : 0, null);
        await assert.rejects(o.result); await o.closed;
    }
});
test('one fixed build then one same-owner offline lock command; caller mutation cannot redirect', async () => {
    const f = fixture(), selected = selection(), cap = createDiagnosticGatewayExecution(selected, f.ports);
    selected.root = '/outside'; f.ports.launch = () => assert.fail('Changed launcher must not run');
    const task = cap.execute(plan()); f.children[0].emit('spawn'); f.close(f.children[0]); await task;
    await assert.rejects(cap.execute(plan()));
    const task2 = cap.execute(plan('lock')); f.children[1].emit('spawn'); f.close(f.children[1]); await task2;
    cap.assertSettled(); await assert.rejects(cap.execute(plan('lock')));
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
        assert.equal(call[2].shell, false); assert.deepEqual(call[2].env, { ...environment, NODE_ENV: 'production' });
        assert.equal(call[2].env.HOME, undefined); assert.equal(call[2].env.NPM_CONFIG_REGISTRY, undefined);
    }
});
test('changed owner, output, shell command and online lock plan fail before dispatch', async () => {
    for (const mutate of [(p: any) => { p.command[0] = '/bin/sh'; }, (p: any) => { p.command[6] = '--outfile=/outside'; },
        (p: any) => { p.cwd = '/outside'; }, (p: any) => { p.role = 'lock'; }]) {
        const f = fixture(), cap = createDiagnosticGatewayExecution(selection(), f.ports), p: any = structuredClone(plan()); mutate(p);
        p.command = Object.freeze(p.command); Object.freeze(p); await assert.rejects(cap.execute(p)); assert.equal(f.calls.length, 0);
    }
    const f = fixture(), cap = createDiagnosticGatewayExecution(selection(), f.ports), task = cap.execute(plan());
    f.children[0].emit('spawn'); f.close(f.children[0]); await task;
    for (const change of [{ owner: 'd'.repeat(32) }, { command: Object.freeze(plan('lock').command.filter((s) => s !== '--offline')) }])
        await assert.rejects(cap.execute(Object.freeze({ ...plan('lock'), ...change })));
    assert.equal(f.calls.length, 1);
});
for (const [key, value] of [['private', true], ['attempt', '2'], ['ref', 'refs/heads/main'], ['runner', 'self-hosted'], ['event', 'workflow_dispatch'], ['policy', 'release']] as const)
    test('Gateway context fails closed for ' + key, () => { assert.throws(() => validateDiagnosticGatewayContext({ ...context(), [key]: value })); });

test('actual producer stage plans cross the fixed capability and preserve two acknowledged roles', async () => {
    const p = pipelineFixture(), f = fixture(), s = selection();
    p.options.leaf = 'gateway-diagnostic';
    Object.assign(p.tools, { esbuildEntryPath: s.esbuildPath, npmEntryPath: s.npmPath }); p.tools.runtime.executablePath = s.nodePath;
    const original = f.ports.launch;
    f.ports.launch = (file: string, args: string[], options: any) => {
        const c = original(file, args, options);
        if (args.includes('--bundle')) p.filesystem.write('/project/validation/gateway-diagnostic/build/main.cjs', Buffer.from('synthetic compiled code, never run'));
        Promise.resolve().then(() => { c.emit('spawn'); f.close(c); }); return c;
    };
    const files = filesFixture(p.filesystem);
    const cap = createDiagnosticGatewayExecution(s, { ...f.ports, filesystem: files.native });
    const r = await produceGatewayArchive(p.context, p.options, { ...p.io, filesystem: cap.filesystem, execute: cap.execute, writeExclusive: cap.writeExclusive });
    cap.assertSettled(); assert.equal(r.record.build.role, 'build'); assert.equal(r.record.lockPreparation.role, 'lock');
    assert.equal(r.record.retirement, null); assert.equal(r.record.releaseAcceptance, false); assert.equal(f.calls.length, 2);
});
test('native entry and workflow preserve guards, source pinning, no upload or application entry', () => {
    const e = readFileSync(new URL('../.github/diagnostic-gateway-entry.mjs', import.meta.url), 'utf8');
    const w = readFileSync(new URL('../.github/workflows/diagnostic-gateway-build.yml', import.meta.url), 'utf8');
    const before = (source: string, guard: string, effect: string) => { const a = source.indexOf(guard), b = source.indexOf(effect); assert.ok(a >= 0 && b > a); };
    const contextGuard = 'validateDiagnosticGatewayContext({', acquisition = 'createOwnedWebFiles(fs)';
    before(e, contextGuard, acquisition); assert.throws(() => before(e.replace(contextGuard, ''), contextGuard, acquisition));
    assert.ok(e.includes('sourceFactory, execute: admitted.execute, writeExclusive: admitted.writeExclusive')); assert.ok(e.includes('admitted.assertSettled()'));
    assert.ok(!/\b(?:kill|chmod|rm|unlink|exec|execSync)\s*\(/.test(e));
    assert.ok(w.includes('branches: [' + DIAGNOSTIC_GATEWAY_BRANCH + ']'));
    assert.ok(w.includes('timeout-minutes: 20') && w.includes('contents: read'));
    for (const [guard, effect] of [['test "$GITHUB_RUN_ATTEMPT" = 1', 'uses: actions/checkout'], ['bcf82c09162de030cc8a259a1e0c4606ae82aac8', 'uses: actions/setup-node']]) {
        before(w, guard, effect); assert.throws(() => before(w.replace(guard, ''), guard, effect));
    }
    assert.ok(!/actions\/(?:upload|cache)|secrets\.|id-token:|contents: write|workflow_dispatch/.test(w));
    assert.ok(!e.includes('package-gateway.mjs') && !w.includes('npm run gateway'));
});

test('actual admitted exclusive writer holds stage admission until file close acknowledgement', async () => {
    const f = fixture(), files = filesFixture();
    let release!: () => void;
    files.controls.closeHold = { promise: new Promise<void>((r) => { release = r; }) };
    const cap = createDiagnosticGatewayExecution(selection(), { ...f.ports, filesystem: files.native });
    const stage = new OwnedGatewayStage(cap.filesystem, '/project', 'held-write', cap.writeExclusive);
    const task = stage.initialize();
    for (let i = 0; i < 300 && !files.events.includes('file.close'); i++) await Promise.resolve();
    assert.ok(files.events.includes('file.close'));
    assert.equal(stage.snapshot().pendingFiles.length, 1);
    assert.throws(() => stage.plan('build', {}));
    release(); await task; assert.equal(stage.snapshot().pendingFiles.length, 0);
});
test('rejected actual owned file close preserves both file and stage custody and original cause', async () => {
    const f = fixture(), files = filesFixture(), primary = Error('authored close failure'); files.controls.closeError = primary;
    const cap = createDiagnosticGatewayExecution(selection(), { ...f.ports, filesystem: files.native });
    const stage = new OwnedGatewayStage(cap.filesystem, '/project', 'rejected-write', cap.writeExclusive);
    await assert.rejects(stage.initialize(), (e: any) => e.cause === primary);
    assert.equal(stage.snapshot().pendingFiles.length, 1); assert.equal(stage.snapshot().failed, true);
    assert.throws(() => stage.assertQuiescent());
});

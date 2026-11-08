import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { NetworkCollector } from '../backend/ssh/network.ts';
import { probes } from '../shared/diagnostics/probes.ts';
import { shippingGatewayProbePlan } from './fixtures/shipping-gateway-probes.ts';
import { shippingSshMemory } from './fixtures/shipping-gateway-ssh-memory.ts';
import { prepareNativeShippingGatewayTarget } from './fixtures/shipping-gateway-ssh-native.mts';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const prefix = 'export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; ';
// Only this fixed pure function is projected, never the module/SSH2. Source pin checked below.
function classifier() {
    const source = readFileSync('backend/ssh/session.ts', 'utf8');
    assert.equal(
        hash(source),
        '8cae1798cf782af8e6afe95c111d8dd177f69d525bacdd09df70c62b9460520f',
        'Wrong SSH source before projection',
    );
    const tree = ts.createSourceFile('session.ts', source, ts.ScriptTarget.Latest, true);
    const selected = tree.statements.filter(
        (n): n is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(n) && n.name?.text === 'classifyExit',
    );
    assert.equal(selected.length, 1);
    assert.ok(
        selected[0].body &&
            selected[0].body.statements.length === 1 &&
            ts.isReturnStatement(selected[0].body.statements[0]),
    );
    const code = selected[0].getText(tree).replace(/^export\s+/, '') + '; classifyExit;';
    return vm.runInNewContext(
        ts.transpileModule(code, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        }).outputText,
        {},
    );
}
test('native wrapper import is definition-only and construction has no server, timer or key generation effect', async () => {
    assert.equal(typeof prepareNativeShippingGatewayTarget, 'function');
    const f = shippingSshMemory();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.timers, []);
    await f.fixture.close();
    assert.equal(f.fixture.snapshot().retired, true);
    assert.deepEqual(f.calls, []);
    assert.throws(() => f.fixture.start());
    assert.throws(() => f.fixture.verifyComplete());
});
test('standalone target covers the complete authored default collection using actual pure collector logic', async () => {
    const f = shippingSshMemory(),
        plan = shippingGatewayProbePlan(),
        classify = classifier();
    const target = await f.fixture.start();
    assert.equal(target.host, '127.0.0.1');
    assert.equal(target.port, 58732);
    f.discover();
    await f.pulse();
    const client = f.authenticate();
    const collector = new NetworkCollector();
    const requested: string[] = [],
        results: any[] = [];
    for (const probe of probes)
        results.push(
            await collector.collect(probe, async (id, command) => {
                const channel = f.exec(client, prefix + command);
                await f.pulse();
                assert.equal(channel.closed, true);
                requested.push(id);
                return {
                    id,
                    command,
                    stdout: Buffer.concat(channel.out).toString(),
                    stderr: Buffer.concat(channel.err).toString(),
                    exitCode: channel.code,
                    status: classify(channel.code),
                    durationMs: 0,
                    collectedAt: '2026-11-07T00:00:00.000Z',
                    truncated: false,
                };
            }),
        );
    assert.deepEqual(
        results.map((r) => ({
            id: r.id,
            status: r.status,
            exitCode: r.exitCode,
            stdoutSHA256: hash(r.stdout),
            stderrSHA256: hash(r.stderr),
        })),
        plan.expectedProbes,
    );
    assert.equal(results.length, 36);
    assert.equal(requested.length, 41);
    assert.deepEqual([...requested].sort(), plan.commands.map((r) => r.id).sort());
    assert.ok(
        results
            .filter((r) => r.networkEvidence)
            .every((r) => r.networkEvidence.omissions.length === 0),
    );
    const scope = f.fixture.sessionInput('b'.repeat(32));
    assert.equal(scope.expectedProbes.length, 36);
    assert.equal(scope.target.password, f.credentials.password);
    client.end();
    await f.pulse();
    await f.fixture.close();
    const receipt = f.fixture.verifyComplete();
    assert.equal(receipt.counts.execs, 41);
    assert.equal(receipt.releaseAcceptance, false);
    assert.equal(receipt.ssh2InternalRetirement, null);
    assert.equal(receipt.wholeGroupRetirement, null);
    assert.equal(
        f.fixture.snapshot().listeners +
            f.fixture.snapshot().pendingOperations +
            f.fixture.snapshot().timers,
        0,
    );
    for (const secret of [
        f.credentials.password,
        f.credentials.fingerprint,
        'inert-test-key-never-parsed',
        plan.commands[0].command,
    ])
        assert.ok(!JSON.stringify(receipt).includes(secret));
    assert.ok(f.timers.every((row) => row.cleared));
});
test('optional tool commands use one literal printf escape and reject the overescaped form', () => {
    const plan = shippingGatewayProbePlan(),
        slash = String.fromCharCode(92);
    const extras = plan.commands.filter((row) => row.id.startsWith('ip-'));
    assert.equal(extras.length, 5);
    for (const row of extras) {
        const needle = ' is not installed.' + slash + 'n';
        assert.ok(row.command.includes(needle));
        assert.equal(plan.reply(row.command)?.id, row.id);
        assert.equal(
            plan.reply(row.command.replace(needle, ' is not installed.' + slash + slash + 'n')),
            null,
        );
    }
});
test('exact command matching refuses prefixed, truncated and replayed commands', async () => {
    const plan = shippingGatewayProbePlan();
    assert.equal(plan.reply('evil; ' + plan.commands[0].command), null);
    assert.equal(plan.reply(plan.commands[0].command.slice(1)), null);
    const f = shippingSshMemory();
    await f.fixture.start();
    const client = f.authenticate();
    f.exec(client, plan.commands[0].command);
    await f.pulse();
    f.exec(client, plan.commands[0].command);
    await f.pulse();
    await assert.rejects(f.fixture.failure);
    await f.fixture.close();
    assert.equal(f.fixture.snapshot().failed, true);
    assert.throws(() => f.fixture.verifyComplete());
});
for (const hold of ['holdEOF', 'holdStderrClose', 'holdEndAck', 'holdWrite'])
    test('fixture retains owned channel until actual ' + hold + ' acknowledgement', async () => {
        const f = shippingSshMemory();
        await f.fixture.start();
        const client = f.authenticate();
        f.controls[hold] = true;
        const channel = f.exec(client, shippingGatewayProbePlan().commands[0].command);
        await f.pulse();
        const closing = f.fixture.close();
        await f.pulse();
        assert.equal(f.fixture.snapshot().retired, false);
        assert.equal(f.fixture.snapshot().channels, 1);
        f.controls[hold] = false;
        if (hold === 'holdWrite') {
            for (const ack of f.heldWrites.splice(0)) ack();
        }
        if (hold === 'holdEOF') channel.emit('end');
        if (hold === 'holdStderrClose') channel.stderr.emit('close');
        if (hold === 'holdEndAck') channel.endCallback();
        await closing;
        assert.equal(f.fixture.snapshot().channels, 0);
        assert.equal(f.fixture.snapshot().retired, true);
    });
for (const hold of ['holdSocket', 'holdListenerEvent', 'holdListenerAck'])
    test('client-close or listener callback alone cannot retire ' + hold, async () => {
        const f = shippingSshMemory();
        await f.fixture.start();
        const client = f.authenticate();
        f.controls[hold] = true;
        const closing = f.fixture.close();
        await f.pulse();
        assert.equal(f.fixture.snapshot().retired, false);
        f.controls[hold] = false;
        if (hold === 'holdSocket') client.socket.closeNow();
        if (hold === 'holdListenerEvent') f.tcp.emit('close');
        if (hold === 'holdListenerAck') {
            /* Releasing a held callback is explicit in the fake host below. */ f.tcp.releaseCloseAck();
        }
        await closing;
        assert.equal(f.fixture.snapshot().retired, true);
    });
test('deadline begins only graceful owned closure and never manufactures a pass', async () => {
    const f = shippingSshMemory();
    await f.fixture.start();
    f.authenticate();
    f.expire();
    await assert.rejects(f.fixture.failure);
    await f.fixture.closed;
    assert.equal(f.fixture.snapshot().failed, true);
    assert.equal(f.calls.filter((x) => x === 'listener-close').length, 1);
    assert.throws(() => f.fixture.verifyComplete());
});
test('normal close keeps late retired timer callbacks from rewriting the receipt', async () => {
    const f = shippingSshMemory();
    await f.fixture.start();
    await f.fixture.close();
    const before = f.fixture.snapshot();
    for (const row of f.timers) row.callback();
    assert.deepEqual(f.fixture.snapshot(), before);
});
test('wrong password fails, refuses authentication and cannot become complete on later closure', async () => {
    const f = shippingSshMemory();
    await f.fixture.start();
    f.authenticate('wrong');
    await assert.rejects(f.fixture.failure);
    await f.fixture.close();
    assert.equal(f.fixture.snapshot().counts.passwordAccepted, 0);
    assert.throws(() => f.fixture.verifyComplete());
});
for (const mode of ['badTimer', 'badClear', 'wrongCount'])
    test('unknown fixture host operation retains custody: ' + mode, async () => {
        const f = shippingSshMemory();
        f.controls[mode] = true;
        if (mode === 'badTimer') {
            await assert.rejects(f.fixture.start());
        } else {
            await f.fixture.start();
            void f.fixture.close();
        }
        await assert.rejects(f.fixture.failure);
        await f.pulse();
        assert.equal(f.fixture.snapshot().retired, false);
    });
test('unsupported asynchronous factory retains both the returned promise and its late object', async () => {
    const f = shippingSshMemory();
    f.controls.unknownSSH = true;
    await assert.rejects(f.fixture.start());
    await f.pulse();
    assert.equal(f.fixture.snapshot().retired, false);
    assert.equal(f.fixture.snapshot().unknownOperations, 1);
    assert.equal(f.fixture.snapshot().unknownReturnedValuesRetained, 1);
    assert.ok(!f.calls.includes('tcp-factory'));
});

test('fixture and pure projection bind the exact reviewed source and retained SSH2 public API', () => {
    const pins = {
        'backend/ssh/session.ts':
            '8cae1798cf782af8e6afe95c111d8dd177f69d525bacdd09df70c62b9460520f',
        'backend/ssh/network.ts':
            'ece263fbe5683acf7f31eeefc76b57a278c7ef4c2d637c8ecdf7937e55eaea39',
        'shared/diagnostics/probes.ts':
            '45ee9fc12d98bcde7f2a4cedb3b64921399e71928f02eb6ce9331bac6cce156b',
        'shared/diagnostics/processes.ts':
            '65dde4a9c134983a88fbac5c7e977e0463b67a315a0e5e3508223b2704690eb4',
        'shared/diagnostics/network/evidence.ts':
            '9791c9cc25cd426b5b30eec0cc599e4ccf3dd24a11d8c019373a93a6c40594ef',
    };
    for (const [file, pin] of Object.entries(pins))
        assert.equal(hash(readFileSync(file)), pin, file);
    const readme = readFileSync('node_modules/ssh2/README.md', 'utf8'),
        server = readFileSync('node_modules/ssh2/lib/server.js', 'utf8'),
        channel = readFileSync('node_modules/ssh2/lib/Channel.js', 'utf8');
    assert.ok(readme.includes('**injectSocket**'));
    assert.ok(server.includes("this._srv.emit('connection', socket)"));
    assert.ok(
        server.indexOf("this.emit('close');", server.indexOf("debug && debug('Socket closed')")) <
            server.indexOf('this._chanMgr.cleanup(err)'),
    );
    assert.ok(channel.includes('if (this.server || !this.allowHalfOpen)'));
    assert.equal(
        JSON.parse(readFileSync('node_modules/ssh2/package.json', 'utf8')).version,
        '1.17.0',
    );
});

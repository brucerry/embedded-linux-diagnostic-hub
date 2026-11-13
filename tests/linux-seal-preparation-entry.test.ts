// Actual entry orchestration under closed memory ports; no physical fixture is imported.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(
    new URL('../scripts/linux-owned-seal-preparation-fixture.ts', import.meta.url),
    'utf8',
);
assert.equal(source.split('import.meta.url').length, 2);
const code =
    ts.transpileModule(source.replace('import.meta.url', "'file:///fixed/entry.ts'"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText + '\nexports.inspect = () => Array.from(runs);';

function model() {
    const events: string[] = [],
        timers = new Set<object>();
    const prepared = {},
        owner = {},
        observation = { kind: 'memory-only observation' };
    let selected: unknown, record: any;
    const state = {
        fixtureThrows: false,
        fixtureFailure: undefined as unknown,
        writerThrows: false,
        writerFailure: undefined as unknown,
        changeDesktop: false,
        status: 'fixture-seal-preparation-paused',
        pending: false,
    };
    const processPort: any = {
        platform: 'linux',
        arch: 'x64',
        getuid: () => 1000,
        geteuid: () => 1000,
        stdin: { isTTY: true },
        stdout: { isTTY: true, write: () => events.push('stdout') },
        stderr: { write: () => events.push('stderr') },
        env: { DISPLAY: ':99' },
        argv: ['node'],
    };
    const context = {
        host: { version: '0.6.0', sourceRoot: '/model/envelope-b' },
        root: '/model/installed',
        sourceCommit: 'a'.repeat(40),
        runId: '1',
        runAttempt: '1',
        dataHome: '/model/data',
        copies: { description: 'test-only copies' },
        records: { description: 'test-only originals' },
        revalidateCopies() {
            events.push('copies');
        },
        writeSealPreparationRecord(bytes: Buffer) {
            events.push('record');
            if (state.writerThrows) throw state.writerFailure;
            record = JSON.parse(bytes.toString('utf8'));
            return {
                path: '/model/records/seal-preparation.json',
                bytes: bytes.length,
                sha256: 'b'.repeat(64),
            };
        },
    };
    const modules = new Map<string, any>([
        ['node:path', path],
        ['node:url', { fileURLToPath }],
        [
            './linux-owned-installation-fixture.ts',
            {
                async runLinuxOwnedInstallationFixture(args: unknown) {
                    events.push('current-b');
                    selected = args;
                    if (state.fixtureThrows) throw state.fixtureFailure;
                    if (state.changeDesktop) processPort.env.DISPLAY = ':55';
                    return prepared;
                },
                getLinuxOwnedCurrentBFixtureContext(value: unknown) {
                    events.push('context');
                    assert.equal(value, prepared);
                    return context;
                },
            },
        ],
        [
            '../electron/linux-permanent-setup.ts',
            {
                linuxPermanentArguments(args: string[]) {
                    events.push('arguments');
                    assert.deepEqual(Array.from(args), [
                        '--install-directory',
                        '/model/installed',
                        '--version',
                        '0.6.0',
                        '--operation',
                        'finalize',
                        '--terminal',
                        '--no-menu',
                    ]);
                    return { capturedArgs: args };
                },
                async runLinuxPermanentOwnedFixture(
                    host: unknown,
                    choices: unknown,
                    data: unknown,
                    prompts: any,
                    desktop: unknown,
                    mode: string,
                ) {
                    events.push('product');
                    assert.equal(host, context.host);
                    assert.ok(choices);
                    assert.equal(data, context.dataHome);
                    assert.equal(mode, 'seal-preparation');
                    assert.equal(prompts.terminal.hasPending(), false);
                    assert.equal(prompts.now(), 100);
                    assert.equal((desktop as any).DISPLAY, ':99');
                    return {
                        status: state.status,
                        owner,
                        interruption: observation,
                        releaseAcceptance: false,
                    };
                },
                linuxPermanentSetupDiagnostics(value: unknown) {
                    events.push('custody');
                    assert.equal(value, owner);
                    return state.status === 'cancelled'
                        ? {
                              phase: 'cancelled',
                              native: { failed: false, retainedFDs: 0 },
                              backend: {
                                  backend: {
                                      failed: false,
                                      pending: null,
                                      retainedFDs: 0,
                                      retainedDirs: 0,
                                      retainedServers: 0,
                                      retainedSockets: 0,
                                      retainedTimers: 0,
                                  },
                              },
                          }
                        : {
                              phase:
                                  state.status === 'fixture-seal-preparation-paused'
                                      ? 'fixture-paused'
                                      : 'retained-unknown',
                              primarySet: false,
                              native: { failed: false, retainedFDs: 0 },
                              backend: {
                                  backend: {
                                      failed: false,
                                      pending: null,
                                      retainedFDs: 0,
                                      retainedDirs: 0,
                                      retainedServers: 0,
                                      retainedSockets: 0,
                                      retainedTimers: 0,
                                  },
                              },
                              launch: {
                                  verdict: 'SEAL_PREPARATION_PAUSED',
                                  code: 'SEAL_PREPARATION_PAUSED',
                                  pending: null,
                                  reservation: 'none',
                                  childOwned: false,
                                  timerOwned: false,
                                  spawned: true,
                                  exited: true,
                                  closed: true,
                                  initialConfirmed: false,
                                  retainedConfirmed: false,
                                  sealRecovered: false,
                                  sealInterrupted: true,
                                  pipes: {
                                      stdout: { end: true, close: true },
                                      stderr: { end: true, close: true },
                                  },
                                  readback: { closed: true, failed: false },
                                  quitControl: { closed: true, failed: false },
                              },
                          };
                },
            },
        ],
        [
            '../electron/linux-setup-prompts.ts',
            {
                linuxTerminalPrompt() {
                    events.push('terminal');
                    return { hasPending: () => state.pending };
                },
            },
        ],
    ]);
    const module = { exports: {} as any };
    const sandbox = vm.createContext(
        {
            module,
            exports: module.exports,
            Buffer,
            process: processPort,
            performance: { now: () => 100 },
            setInterval() {
                const timer = {};
                timers.add(timer);
                return timer;
            },
            require(name: string) {
                assert.ok(modules.has(name), 'Unreviewed import');
                return modules.get(name);
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
    new vm.Script(code).runInContext(sandbox, { timeout: 1000 });
    assert.equal(events.length, 0, 'Import/main guard must not invoke a fixture or product.');
    return {
        state,
        processPort,
        events,
        timers,
        selected: () => selected,
        record: () => record,
        run: () => module.exports.runLinuxOwnedSealPreparationFixture(['--a-appdir', '/model/a']),
        inspect: () => module.exports.inspect() as any[],
    };
}

test('entry refuses missing owned terminal/GUI before the current-B fixture is called', async () => {
    for (const field of ['tty', 'display', 'root']) {
        const m = model();
        if (field === 'tty') m.processPort.stdin.isTTY = false;
        if (field === 'display') m.processPort.env = {};
        if (field === 'root') m.processPort.getuid = () => 0;
        await assert.rejects(m.run(), /SEAL_FIXTURE_OWNED_TERMINAL_AND_GUI_REQUIRED/);
        assert.deepEqual(m.events, []);
        assert.equal(m.timers.size, 0);
    }
});

test('entry uses original current-B context and actual product result before fixed record publication', async () => {
    const m = model();
    m.state.changeDesktop = true;
    const result = await m.run();
    assert.equal(m.processPort.env.DISPLAY, ':55');
    assert.equal(result.status, 'cooperative-seal-preparing-paused');
    assert.deepEqual(Array.from(m.selected() as string[]), [
        '--a-appdir',
        '/model/a',
        '--scenario',
        'current-b',
    ]);
    assert.deepEqual(m.events, [
        'current-b',
        'context',
        'copies',
        'arguments',
        'terminal',
        'product',
        'custody',
        'copies',
        'record',
    ]);
    assert.equal(m.record().product.interruption.kind, 'memory-only observation');
    assert.equal(m.record().releaseAcceptance, false);
    assert.equal(m.record().abruptInterruptionObserved, false);
    assert.equal(result.finalized, false);
    assert.equal(result.releaseAcceptance, false);
    assert.equal(m.inspect().length, 0);
    assert.equal(m.timers.size, 0);
});

test('entry preserves falsey failures and uncertain product/record custody without retry or publication', async () => {
    for (const mode of ['fixture', 'unknown', 'writer']) {
        const m = model();
        if (mode === 'fixture') m.state.fixtureThrows = true;
        if (mode === 'unknown') m.state.status = 'retained-unknown';
        if (mode === 'writer') m.state.writerThrows = true;
        const result = await m.run();
        assert.equal(result.status, 'retained-nonpassing');
        assert.equal(result.releaseAcceptance, false);
        assert.equal(m.timers.size, 1);
        assert.equal(m.inspect().length, 1);
        assert.equal(m.inspect()[0].primarySet, true);
        if (mode !== 'unknown') assert.equal(m.inspect()[0].primary, undefined);
        assert.equal(m.events.filter((e) => e === 'current-b').length, 1);
        assert.equal(m.events.filter((e) => e === 'product').length, mode === 'fixture' ? 0 : 1);
        assert.equal(m.record(), undefined);
        assert.equal(m.events.filter((e) => e === 'record').length, mode === 'writer' ? 1 : 0);
    }
});

test('known cancelled review returns without retaining a timer or manufacturing a pause record', async () => {
    const m = model();
    m.state.status = 'cancelled';
    const result = await m.run();
    assert.equal(result.status, 'cancelled');
    assert.equal(result.releaseAcceptance, false);
    assert.equal(m.timers.size, 0);
    assert.equal(m.inspect().length, 0);
    assert.equal(m.record(), undefined);
    assert.equal(m.events.includes('record'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
    updaterMemoryTests,
    updaterMemoryPath,
    updaterTestEnvironment,
    assertUpdaterSourcePath,
    assertUpdaterBundle,
    assertUpdaterOutput,
    assertUpdaterCommand,
    observeUpdaterCommand,
} from '../scripts/lib/updater-memory-test-plan.mjs';
import memoryPath from '../scripts/lib/updater-memory-path.mjs';
import { mkdir as memoryMkdir } from './fixtures/updater-memory-io';

const tap =
    '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# updater-memory-global-fetch-attempts 0\n';
test('source admission rejects traversal and protected paths before filesystem lookup', () => {
    assert.doesNotThrow(() => assertUpdaterSourcePath('electron/update-owned-file.ts'));
    for (const name of [
        '../outside.ts',
        '/outside.ts',
        'C:/outside.ts',
        'a\\outside.ts',
        './a.ts',
        'a/../outside.ts',
        '.git/config',
        'a/node_modules/foreign/index.js',
    ])
        assert.throws(() => assertUpdaterSourcePath(name));
});
test('the memory namespace is identical for Windows, macOS and Linux path models', async () => {
    assert.equal(memoryPath, path.posix);
    for (const [host, hostPath] of [
        ['win32', path.win32],
        ['darwin', path.posix],
        ['linux', path.posix],
    ] as const) {
        const native = hostPath.join('/memory/updates', '0.2.0');
        if (host === 'win32') {
            assert.notEqual(native, '/memory/updates/0.2.0');
            await assert.rejects(memoryMkdir(native, { recursive: true, mode: 0o700 }));
        } else await memoryMkdir(native, { recursive: true, mode: 0o700 });
        const selected = memoryPath.join('/memory/updates', '0.2.0');
        assert.equal(selected, '/memory/updates/0.2.0');
        await memoryMkdir(selected, { recursive: true, mode: 0o700 });
    }
});
test('child environments use owned temp paths and only the required inherited Windows root', () => {
    const node = path.win32.join('C:/', 'Node', 'node.exe');
    const stage = path.win32.join('C:/', 'owned', 'stage');
    const systemRoot = path.win32.join('C:/', 'Windows');
    const value = updaterTestEnvironment(
        {
            Path: 'D:/tools',
            SystemRoot: systemRoot,
            HOME: 'unchanged-home',
            SECRET: 'never-inherit',
            NODE_OPTIONS: '--unreviewed',
        },
        node,
        stage,
        'win32',
    );
    assert.equal(value.TMPDIR, stage);
    assert.equal(value.TEMP, stage);
    assert.equal(value.TMP, stage);
    assert.equal(value.SystemRoot, systemRoot);
    assert.equal(value.HOME, 'unchanged-home');
    assert.equal(value.PATH, path.win32.dirname(node) + ';D:/tools');
    assert.equal(value.SECRET, undefined);
    assert.equal(value.NODE_OPTIONS, undefined);
    for (const platform of ['linux', 'darwin']) {
        const env = updaterTestEnvironment(
            { PATH: '/bin', HOME: '/home/synthetic' },
            '/tools/node',
            '/owned/stage',
            platform,
        );
        assert.equal(env.TMPDIR, '/owned/stage');
        assert.equal(env.HOME, '/home/synthetic');
        assert.equal(env.PATH, '/tools:/bin');
        assert.equal(env.SystemRoot, undefined);
    }
    for (const root of [undefined, 'relative', '//server/share', 'C:/Windows'])
        assert.throws(() => updaterTestEnvironment({ SystemRoot: root }, node, stage, 'win32'));
    assert.throws(() =>
        updaterTestEnvironment({ SystemRoot: systemRoot }, node, '//server/share', 'win32'),
    );
});
test('npm test requires the complete updater lane before preserving the ordinary glob', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    assert.equal(
        pkg.scripts.test,
        'node scripts/test-updater-memory.mjs && tsx --test tests/*.test.ts',
    );
    assert.equal(pkg.scripts['test:updater-memory'], 'node scripts/test-updater-memory.mjs');
    assert.deepEqual(
        updaterMemoryTests.map((value) => value.cases),
        [3, 1, 27, 2, 1],
    );
    assert.equal(new Set(updaterMemoryTests.map((value) => value.entry)).size, 5);
    assert.deepEqual(
        updaterMemoryTests.map((value) => value.entry),
        [
            'tests/updater-cache-failure-memory.cases.ts',
            'tests/updater-coordinator-memory.cases.ts',
            'tests/updater-owned-lifetime-memory.cases.ts',
            'tests/updater-owned-marker-memory.cases.ts',
            'tests/update-acquisition-retirement-memory.cases.ts',
        ],
    );
    assert.deepEqual(
        [...new Set(updaterMemoryTests.map((value) => value.fixture))],
        ['tests/fixtures/updater-memory-io.ts', 'tests/fixtures/update-owned-memory.ts'],
    );
});
test('missing, duplicate, skipped, failed or incomplete case evidence refuses a pass', () => {
    assert.equal(assertUpdaterOutput(tap, 1).pass, 1);
    for (const text of [
        tap.replace('# skipped 0', '# skipped 1'),
        tap.replace('# fail 0', '# fail 1'),
        tap.replace('# pass 1', '# pass 0'),
        tap.replace('# tests 1\n', ''),
        tap + '# tests 1\n',
        tap.replace('fetch-attempts 0', 'fetch-attempts 1'),
        tap.replace('# updater-memory-global-fetch-attempts 0\n', ''),
    ])
        assert.throws(() => assertUpdaterOutput(text, 1));
    assert.throws(() => assertUpdaterOutput(tap, 2));
});
test('unaliased filesystem, network, child and foreign input/output bundles refuse execution', () => {
    const root = path.resolve('/project'),
        semverRoot = path.resolve('/deps/semver'),
        fixture = path.join(root, 'tests/fixtures/memory.ts'),
        output = path.resolve('/owned/test.cjs');
    const pathFixture = path.join(root, updaterMemoryPath);
    const options = { root, semverRoot, fixture, output, probe: undefined, pathFixture };
    const meta = { outputs: { [output]: { imports: [{ external: true, path: 'node:test' }] } } };
    assert.doesNotThrow(() =>
        assertUpdaterBundle(meta, [fixture, path.join(semverRoot, 'index.js')], options),
    );
    for (const specifier of [
        'node:path',
        'node:fs',
        'node:fs/promises',
        'node:http',
        'node:child_process',
        'electron',
    ])
        assert.throws(() =>
            assertUpdaterBundle(
                { outputs: { [output]: { imports: [{ external: true, path: specifier }] } } },
                [fixture],
                options,
            ),
        );
    const pathMeta = { outputs: { [output]: { imports: [{ external: true, path: 'path' }] } } };
    assert.throws(() => assertUpdaterBundle(pathMeta, [fixture], options));
    assert.doesNotThrow(() => assertUpdaterBundle(pathMeta, [fixture, pathFixture], options));
    assert.throws(() => assertUpdaterBundle(meta, [], options));
    assert.throws(() =>
        assertUpdaterBundle(meta, [fixture, path.resolve('/project-sibling/foreign.ts')], options),
    );
    assert.throws(() =>
        assertUpdaterBundle(
            meta,
            [fixture, path.join(root, 'node_modules/foreign/index.js')],
            options,
        ),
    );
    assert.throws(() => assertUpdaterBundle({ outputs: {} }, [fixture], options));
    assert.throws(() =>
        assertUpdaterBundle(meta, [fixture], { ...options, output: output + '.foreign' }),
    );
});
class Child extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    signals = 0;
    kill() {
        this.signals++;
        assert.fail('Observer must not signal');
    }
}
function clock() {
    let fire!: () => void,
        cleared = 0;
    return {
        set(fn: () => void) {
            fire = fn;
            return 1;
        },
        clear() {
            cleared++;
        },
        fire() {
            fire();
        },
        cleared: () => cleared,
    };
}
function close(child: Child, code = 0, stderrEOF = true) {
    child.emit('exit', code, null);
    child.stdout.emit('end');
    if (stderrEOF) child.stderr.emit('end');
    child.emit('close', code, null);
}
test('an exit and both pipe EOFs do not release custody before actual child close', async () => {
    const child = new Child(),
        timer = clock();
    let settled = false;
    const pending = observeUpdaterCommand(child, { clock: timer }).then((value) => {
        settled = true;
        return value;
    });
    child.emit('spawn');
    child.stdout.emit('data', Buffer.from('ok'));
    child.emit('exit', 0, null);
    child.stdout.emit('end');
    child.stderr.emit('end');
    await Promise.resolve();
    assert.equal(settled, false);
    child.emit('close', 0, null);
    const value = await pending;
    assertUpdaterCommand(value);
    assert.equal(value.stdout.toString(), 'ok');
    assert.equal(timer.cleared(), 1);
    assert.equal(child.signals, 0);
});
test('deadline retains the same child until close and never becomes a successful command', async () => {
    const child = new Child(),
        timer = clock();
    let settled = false;
    const pending = observeUpdaterCommand(child, { clock: timer }).then((value) => {
        settled = true;
        return value;
    });
    child.emit('spawn');
    timer.fire();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(child.signals, 0);
    close(child);
    const value = await pending;
    assert.equal(value.deadline, true);
    assert.throws(() => assertUpdaterCommand(value));
});
test('a spawn error retains observation through close and cannot become a successful command', async () => {
    const child = new Child(),
        timer = clock();
    let settled = false;
    const pending = observeUpdaterCommand(child, { clock: timer }).then((value) => {
        settled = true;
        return value;
    });
    child.emit('error', {
        toString() {
            throw Error('unprintable');
        },
    });
    await Promise.resolve();
    assert.equal(settled, false);
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', null, null);
    const value = await pending;
    assert.equal(value.error, 'Unprintable child error.');
    assert.throws(() => assertUpdaterCommand(value));
    assert.equal(child.signals, 0);
});
test('overflow, nonzero exit and missing EOF stay failed after acknowledged close', async () => {
    for (const fault of ['overflow', 'exit', 'EOF']) {
        const child = new Child(),
            timer = clock(),
            pending = observeUpdaterCommand(child, { clock: timer, limit: 4 });
        child.emit('spawn');
        if (fault === 'overflow') child.stdout.emit('data', Buffer.from('12345'));
        close(child, fault === 'exit' ? 1 : 0, fault !== 'EOF');
        const value = await pending;
        assert.throws(() => assertUpdaterCommand(value));
        assert.ok(value.stdout.length <= 4);
        assert.equal(child.signals, 0);
    }
});
test('the real preload blocks fetch in a VM double and fails attempts or replacement', async () => {
    const source = readFileSync('scripts/lib/updater-memory-network-guard.cjs', 'utf8');
    for (const mode of ['clean', 'attempt', 'replace']) {
        let onExit!: () => void;
        const lines: string[] = [];
        const proc = {
            exitCode: 0,
            stdout: {
                write(value: string) {
                    lines.push(value);
                },
            },
            on(name: string, fn: () => void) {
                assert.equal(name, 'exit');
                onExit = fn;
            },
        };
        const context = vm.createContext({ process: proc });
        vm.runInContext(source, context, { timeout: 1000 });
        if (mode === 'attempt')
            await assert.rejects(context.fetch('synthetic-not-a-URL'), /Unexpected global fetch/);
        if (mode === 'replace') context.fetch = () => assert.fail('Never invoke replacement');
        onExit();
        assert.equal(proc.exitCode, mode === 'clean' ? 0 : 1);
        assert.equal(
            lines.join(''),
            '# updater-memory-global-fetch-attempts ' + (mode === 'attempt' ? 1 : 0) + '\n',
        );
    }
});

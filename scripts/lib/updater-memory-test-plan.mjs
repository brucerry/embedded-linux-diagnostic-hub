import assert from 'node:assert/strict';
import path from 'node:path';

export const updaterMemoryTests = Object.freeze(
    [
        { name: 'updater-cache-failure-memory', fixture: 'updater-memory-io', cases: 3 },
        { name: 'updater-coordinator-memory', fixture: 'updater-memory-io', cases: 1 },
        { name: 'updater-owned-lifetime-memory', fixture: 'update-owned-memory', cases: 27 },
        { name: 'updater-owned-marker-memory', fixture: 'update-owned-memory', cases: 2 },
        { name: 'update-acquisition-retirement-memory', fixture: 'update-owned-memory', cases: 1 },
    ].map(({ name, fixture, cases }) =>
        Object.freeze({
            entry: `tests/${name}.cases.ts`,
            fixture: `tests/fixtures/${fixture}.ts`,
            cases,
        }),
    ),
);
export const updaterMemoryPath = 'scripts/lib/updater-memory-path.mjs';
const externals = new Set(['node:assert/strict', 'node:test', 'node:crypto', 'path']);
const inside = (parent, file) => file.startsWith(parent + path.sep);

export function assertUpdaterSourcePath(name) {
    assert.ok(typeof name === 'string' && name && !/[:\\]/.test(name));
    assert.ok(!path.posix.isAbsolute(name) && path.posix.normalize(name) === name);
    assert.ok(!name.split('/').some((part) => ['.', '..', '.git', 'node_modules'].includes(part)));
}

export function assertUpdaterBundle(
    meta,
    inputs,
    { root, semverRoot, fixture, probe, output, pathFixture },
) {
    assert.equal(Object.keys(meta.outputs).length, 1);
    assert.equal(path.resolve(root, Object.keys(meta.outputs)[0]), output);
    for (const output of Object.values(meta.outputs))
        for (const value of output.imports) {
            assert.ok(
                value.external && externals.has(value.path),
                'Unadmitted emitted import: ' + value.path,
            );
            if (value.path === 'path')
                assert.ok(inputs.includes(pathFixture), 'Memory path adapter is absent.');
        }
    assert.ok(inputs.includes(fixture), 'Memory fixture is absent from the bundle.');
    for (const file of inputs)
        assert.ok(
            file === probe ||
                inside(semverRoot, file) ||
                (inside(root, file) &&
                    !path.relative(root, file).split(path.sep).includes('node_modules')),
            'Bundle input escaped the reviewed source/dependency roots.',
        );
}

/** @param {Record<string, string | undefined>} base */
export function updaterTestEnvironment(base, executable, stage, platform) {
    assert.ok(['linux', 'darwin', 'win32'].includes(platform));
    const paths = platform === 'win32' ? path.win32 : path.posix;
    for (const value of [executable, stage])
        assert.ok(
            typeof value === 'string' && paths.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value),
        );
    /** @type {Record<string, string | undefined>} */
    const result = {
        PATH: paths.dirname(executable) + paths.delimiter + (base.PATH ?? base.Path ?? ''),
        HOME: base.HOME,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        TMPDIR: stage,
    };
    if (platform === 'win32') {
        const systemRoot = base.SystemRoot ?? base.SYSTEMROOT;
        for (const value of [executable, stage, systemRoot])
            assert.ok(
                typeof value === 'string' &&
                    /^[A-Za-z]:\\/.test(value) &&
                    paths.normalize(value) === value &&
                    !/[\x00-\x1f\x7f]/.test(value),
                'Require canonical local Windows paths.',
            );
        result.SystemRoot = systemRoot;
        result.TEMP = result.TMP = stage;
    }
    return result;
}

export function assertUpdaterOutput(text, expected) {
    /** @type {Record<string, number>} */
    const values = {};
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
        const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
        assert.equal(matches.length, 1, 'Missing or duplicate TAP count: ' + key);
        values[key] = Number(matches[0][1]);
    }
    assert.equal(values.tests, expected);
    assert.equal(values.pass, expected);
    for (const key of ['fail', 'cancelled', 'skipped']) assert.equal(values[key], 0);
    assert.deepEqual(
        [...text.matchAll(/^# updater-memory-global-fetch-attempts (\d+)$/gm)].map((m) => m[1]),
        ['0'],
    );
    return values;
}

export function assertUpdaterCommand(value) {
    assert.ok(
        value.spawned && value.exitObserved && value.closed && value.stdoutEOF && value.stderrEOF,
    );
    assert.equal(value.code, 0);
    assert.equal(value.signal, null);
    assert.ok(!value.deadline && !value.overflow && !value.error);
}

// Timeout reports retained custody. Never signal a process or infer exit from a PID lookup.
/** @param {any} child @param {any} [options] @returns {Promise<any>} */
export function observeUpdaterCommand(child, options = {}) {
    const {
        timeoutMs = 120_000,
        limit = 1024 ** 2,
        clock = { set: setTimeout, clear: clearTimeout },
        onDeadline = () => {},
    } = options;
    return new Promise((resolve) => {
        const state = {
            spawned: false,
            exitObserved: false,
            closed: false,
            stdoutEOF: false,
            stderrEOF: false,
            code: null,
            signal: null,
            deadline: false,
            overflow: false,
            error: null,
        };
        const chunks = { stdout: [], stderr: [] },
            sizes = { stdout: 0, stderr: 0 };
        const timer = clock.set(() => {
            state.deadline = true;
            try {
                onDeadline();
            } catch {
                state.error = 'Deadline reporting failed.';
            }
        }, timeoutMs);
        child.once('spawn', () => {
            state.spawned = true;
        });
        child.once('error', (error) => {
            try {
                state.error = String(error);
            } catch {
                state.error = 'Unprintable child error.';
            }
        });
        child.once('exit', (code, signal) => {
            state.exitObserved = true;
            state.code = code;
            state.signal = signal;
        });
        for (const name of ['stdout', 'stderr']) {
            child[name].on('data', (bytes) => {
                if (!Buffer.isBuffer(bytes)) {
                    state.error = 'Non-buffer child output.';
                    return;
                }
                const keep = Math.max(0, Math.min(bytes.length, limit - sizes[name]));
                if (keep) chunks[name].push(Buffer.from(bytes.subarray(0, keep)));
                sizes[name] += bytes.length;
                state.overflow ||= sizes[name] > limit;
            });
            child[name].once('end', () => {
                state[name + 'EOF'] = true;
            });
            child[name].once('error', () => {
                state.error = 'Child output pipe failed.';
            });
        }
        child.once('close', () => {
            state.closed = true;
            clock.clear(timer);
            resolve({
                ...state,
                bytes: sizes,
                stdout: Buffer.concat(chunks.stdout),
                stderr: Buffer.concat(chunks.stderr),
            });
        });
    });
}

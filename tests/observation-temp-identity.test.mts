// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observationContext, observationMain } from '../scripts/windows-observation-pair.mts';
import {
    bindObservationDirectory,
    requireObservationDirectoryIdentity,
} from '../scripts/lib/observation-paths.mjs';
function model({ reverse = false, caseVariant = false } = {}) {
    const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp',
        short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
    const facts = new Map();
    for (const root of [long, short]) {
        let file = root,
            level = 7;
        for (;;) {
            facts.set(file.toLowerCase(), {
                realpath: file,
                dev: '742408122',
                ino: String(9007199254740990n + BigInt(level)),
                directory: true,
                file: false,
            });
            const parent = path.win32.dirname(file);
            if (parent === file) break;
            file = parent;
            level--;
        }
    }
    const tmp = reverse ? long : short,
        profile = reverse ? 'C:\\Users\\RUNNER~1' : 'C:\\Users\\runneradmin';
    const input = caseVariant ? tmp.toLowerCase() : tmp;
    const env = {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'X64',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_RUN_ATTEMPT: '1',
        HUB_WINDOWS_OBSERVATION_PAIR: '1',
        USERPROFILE: profile,
        LOCALAPPDATA: path.win32.dirname(tmp),
        TEMP: input,
        TMP: input,
    };
    const identity = (file) => {
        const row = facts.get(file.toLowerCase());
        assert(row, 'Unknown directory ' + file);
        if (row.error) throw Error(row.error);
        return { path: file, ...row };
    };
    const realpath = (file) => identity(file).realpath;
    const ops = {
        platform: 'win32',
        arch: 'x64',
        version: 'v24.22.0',
        tmp: input,
        realpath,
        identity,
        ancestry: (file) => [identity(file)],
        recheck: (rows) => {
            if (ops.rejectRecheck) throw Error('Guard refused');
            for (const old of rows) assert.deepEqual(identity(old.path), old);
        },
    };
    return { env, ops, facts, long, short, input, identity };
}
for (const variation of [{}, { reverse: true }, { caseVariant: true }])
    test(
        'physical TEMP aliases admitted without rewriting environment ' + JSON.stringify(variation),
        () => {
            const f = model(variation),
                before = structuredClone(f.env),
                c = observationContext(f.env, f.ops);
            assert.equal(c.tmp, f.ops.realpath(f.input));
            assert.deepEqual(f.env, before);
            c.check();
        },
    );
for (const fault of [
    'different-device',
    'different-inode',
    'missing',
    'file',
    'zero-inode',
    'unsafe-rounded-inode',
    'symlink',
    'junction',
    'reparse',
    'ancestry',
])
    test('invalid ' + fault + ' refuses before entry lease/challenge/workload', async (t) => {
        const f = model();
        const r = f.facts.get(f.short.toLowerCase());
        if (fault === 'different-device') r.dev = '1';
        if (fault === 'different-inode') r.ino = '2';
        if (fault === 'zero-inode') r.ino = '0';
        if (fault === 'unsafe-rounded-inode') r.ino = Number(r.ino);
        if (fault === 'file') {
            r.directory = false;
            r.file = true;
        }
        if (fault === 'missing') f.facts.delete(f.short.toLowerCase());
        if (['symlink', 'junction', 'reparse'].includes(fault))
            f.facts.get('c:\\users\\runner~1').error = 'Metadata alias/reparse refused';
        if (fault === 'ancestry')
            f.ops.ancestry = () => {
                throw Error('Path guard refused');
            };
        const open = t.mock.method(fs, 'openSync', () =>
                assert.fail('No descriptor or marker admission'),
            ),
            mkdir = t.mock.method(fs, 'mkdirSync', () =>
                assert.fail('No preparation/runtime/challenge admission'),
            );
        const expected = {
            'different-device': /directory device differs/,
            'different-inode': /directory object differs/,
            missing: /Unknown directory/,
            file: /directory required/,
            'zero-inode': /identity unavailable/,
            'unsafe-rounded-inode': /identity unavailable/,
            symlink: /Metadata alias\/reparse refused/,
            junction: /Metadata alias\/reparse refused/,
            reparse: /Metadata alias\/reparse refused/,
            ancestry: /Path guard refused/,
        };
        await assert.rejects(observationMain([], f.env, f.ops), expected[fault]);
        assert.equal(open.mock.callCount(), 0);
        assert.equal(mkdir.mock.callCount(), 0);
    });
for (const change of [
    'actual-ancestor',
    'expected-ancestor',
    'actual-object',
    'expected-object',
    'environment',
    'reparse-after-admission',
    'guard-after-admission',
])
    test('post-wait TEMP revalidation refuses ' + change, () => {
        const f = model(),
            c = observationContext(f.env, f.ops);
        c.check();
        if (change === 'actual-ancestor') f.facts.get('c:\\users\\runner~1').ino = '30';
        if (change === 'expected-ancestor') f.facts.get('c:\\users\\runneradmin').ino = '30';
        if (change === 'actual-object') f.facts.get(f.short.toLowerCase()).ino = '31';
        if (change === 'expected-object') f.facts.get(f.long.toLowerCase()).ino = '31';
        if (change === 'environment') f.env.TEMP = 'D:\\else';
        if (change === 'reparse-after-admission')
            f.facts.get('c:\\users\\runner~1').error = 'Reparse refused';
        if (change === 'guard-after-admission') f.ops.rejectRecheck = true;
        assert.throws(() => c.check());
    });
test('exact BigInt-derived identity comparison never rounds adjacent inode values', () => {
    const f = model();
    f.facts.get(f.short.toLowerCase()).ino = '9007199254740992';
    f.facts.get(f.long.toLowerCase()).ino = '9007199254740993';
    assert.throws(() => requireObservationDirectoryIdentity(f.short, f.long, f.identity));
});
test('real disposable directory alias or ancestor symlink refuses even when targets match', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-observation-alias-')));
    try {
        const actual = path.join(root, 'actual');
        fs.mkdirSync(actual);
        fs.mkdirSync(path.join(actual, 'child'));
        fs.symlinkSync(actual, path.join(root, 'alias'), 'dir');
        assert.throws(() =>
            bindObservationDirectory(path.join(root, 'alias'), actual, { paths: path }),
        );
        assert.throws(() =>
            bindObservationDirectory(
                path.join(root, 'alias', 'child'),
                path.join(actual, 'child'),
                { paths: path },
            ),
        );
        assert.equal(
            requireObservationDirectoryIdentity(actual, actual).ino,
            String(fs.lstatSync(actual, { bigint: true }).ino),
        );
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

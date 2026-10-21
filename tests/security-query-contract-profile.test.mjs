import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { matchedOneDirectoryCommand } from '../scripts/lib/security-query-contract-profile.mjs';
import {
    firstCollectorSecurityQuery,
    runSecurityCommand,
} from '../scripts/lib/pilot-security-command.mjs';
import {
    winpsContractCases,
    requireWinpsContractReply,
} from '../scripts/lib/pilot-winps-contract.mjs';
import { projectCollectorEnvironment } from '../scripts/lib/product-collector-environment.mjs';
import { progressReply } from './fixtures/security-diagnostic-progress.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts/lib/pilot-winps-contract.mjs'), 'utf8');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const nodeExecutable = path.join(root, 'fixture-node/node.exe');
const powershell = path.join(root, 'fixture-winps/powershell.exe');
const fixture = path.join(root, "fixture [brackets] $dollar 'quote'");
const plans = [{ path: fixture, kind: 'directory' }],
    raw = JSON.stringify(plans);
const environment = Object.freeze({
    SystemRoot: 'fixture-Windows',
    WINDIR: 'fixture-Windows',
    PATH: 'owner-PATH',
    TEMP: 'fixture-temp',
    TMP: 'fixture-temp',
    PSModulePath: 'fixture-modules',
    GITHUB_REPOSITORY: 'fixture/repo',
    GITHUB_TOKEN: 'NEVER_FORWARD_THIS',
    UNPROJECTED: 'NEVER_FORWARD_THIS_EITHER',
});
const childPATH = path.dirname(nodeExecutable) + ';' + path.dirname(powershell);

test('all original 30 case inputs and metadata/provider assertions stay byte-exact', () => {
    assert.equal(
        sha(winpsContractCases.toString()),
        '0bb875d9da853c20bddbe3f9f921efc35d368dc132864b34750604825d6c0e6f',
    );
    assert.equal(
        sha(requireWinpsContractReply.toString()),
        '20286c9102bfce5a6ac5904f71cf0b7b61f3bd7615c4e7e18edd0d0f071f5a1f',
    );
    const cases = winpsContractCases(
        [fixture, path.join(root, 'second fixture')],
        path.join(root, 'sentinel'),
        path.join(root, 'absent'),
    );
    assert.equal(cases.length, 30);
    assert.equal(new Set(cases.map((c) => c.name)).size, 30);
    assert.equal(cases.filter((c) => c.expected === 'green').length, 3);
    assert.equal(cases.filter((c) => c.expected !== 'green').length, 27);
    assert.deepEqual(cases.find((c) => c.name === 'one-directory').plans, plans);
    assert(source.includes("testCase.name === 'one-directory' && oneDirectoryCommand"));
    assert(/\?\s+oneDirectoryCommand\s+:\s+command/.test(source));
    assert(source.includes('const parsed = JSON.parse(reply.stdout.replace('));
    assert(source.includes('const admitted = requireWinpsContractReply('));
});
test('one-shot control preserves exact fixture bytes/options and uses the original projection without mutation', () => {
    const calls = [],
        before = { ...environment },
        marker = {};
    const record = () => {},
        check = () => {},
        onProcessState = () => {};
    const command = (...args) => {
        calls.push(args);
        return marker;
    };
    const control = matchedOneDirectoryCommand({
        sourceRoot: root,
        nodeExecutable,
        powershell,
        environment,
        command,
    });
    assert.equal(
        control(root, powershell, raw, {
            red: false,
            timeout: 10000,
            record,
            check,
            onProcessState,
        }),
        marker,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), [root, powershell, raw]);
    const options = calls[0][3];
    assert.deepEqual(options.environment, projectCollectorEnvironment(environment, childPATH));
    assert.equal(options.environment.PATH, childPATH);
    assert(!Object.hasOwn(options.environment, 'GITHUB_TOKEN'));
    assert(!Object.hasOwn(options.environment, 'UNPROJECTED'));
    assert.equal(options.timeout, 10000);
    assert.equal(options.record, record);
    assert.equal(options.check, check);
    assert.equal(options.onProcessState, onProcessState);
    assert.equal(typeof options.diagnostic, 'object');
    assert.deepEqual(environment, before);
    assert.throws(() => control(root, powershell, raw, { red: false }));
    assert.equal(calls.length, 1);
});
const invalid = [
    ['foreign source', () => [root + '-other', powershell, raw, { red: false }]],
    ['foreign executable', () => [root, powershell + '-other', raw, { red: false }]],
    ['red control', () => [root, powershell, raw, { red: true }]],
    ['missing red binding', () => [root, powershell, raw, {}]],
    [
        'file plan',
        () => [root, powershell, JSON.stringify([{ path: fixture, kind: 'file' }]), { red: false }],
    ],
    ['two plans', () => [root, powershell, JSON.stringify([...plans, ...plans]), { red: false }]],
    ['scalar plan', () => [root, powershell, '{}', { red: false }]],
    [
        'extra field',
        () => [root, powershell, JSON.stringify([{ ...plans[0], extra: true }]), { red: false }],
    ],
    [
        'relative path',
        () => [
            root,
            powershell,
            JSON.stringify([{ path: 'relative', kind: 'directory' }]),
            { red: false },
        ],
    ],
    ['foreign capability', () => [root, powershell, raw, { red: false, diagnostic: {} }]],
];
for (const [name, args] of invalid)
    test(`${name} refuses before command effects and consumes the control`, () => {
        let calls = 0;
        const control = matchedOneDirectoryCommand({
            sourceRoot: root,
            nodeExecutable,
            powershell,
            environment,
            command() {
                calls++;
            },
        });
        assert.throws(() => control(...args()));
        assert.throws(() => control(root, powershell, raw, { red: false }));
        assert.equal(calls, 0);
    });
test('control and target share diagnostic launch properties while fixture/target input remains different', () => {
    const launches = [],
        reply = progressReply();
    const options = {
        red: false,
        timeout: 10000,
        check() {},
        record() {},
        onProcessState() {},
        identity: (file) => ({ path: file, pe: { architecture: 'x64' }, sha256: 'a'.repeat(64) }),
        spawn(exe, args, opts) {
            launches.push({ exe, args, options: opts });
            return reply;
        },
    };
    const control = matchedOneDirectoryCommand({
        sourceRoot: root,
        nodeExecutable,
        powershell,
        environment,
        command: runSecurityCommand,
    });
    const result = control(root, powershell, raw, options);
    const targetRaw = JSON.stringify([{ path: root, kind: 'directory' }]);
    const target = firstCollectorSecurityQuery({ outputRoot: root, diagnostic: true });
    const targetResult = target(root, powershell, targetRaw, {
        ...options,
        environment: projectCollectorEnvironment(environment, childPATH),
    });
    assert.equal(result.stdout, reply.reportText);
    assert.equal(targetResult.stdout, reply.reportText);
    assert.equal(launches.length, 2); // Two injected callbacks, never OS children.
    const a = launches[0],
        b = launches[1];
    assert.equal(a.exe, b.exe);
    assert.deepEqual(a.args, b.args);
    assert.notEqual(
        a.options.env.HUB_NATIVE_PILOT_SECURITY_PATHS,
        b.options.env.HUB_NATIVE_PILOT_SECURITY_PATHS,
    );
    const stripInput = (x) => {
        const copy = { ...x, env: { ...x.env } };
        delete copy.env.HUB_NATIVE_PILOT_SECURITY_PATHS;
        return copy;
    };
    assert.deepEqual(stripInput(a.options), stripInput(b.options));
    assert.equal(a.options.cwd, root);
    assert.equal(a.options.env.PSModulePath, undefined);
    assert.equal(a.options.env.HUB_NATIVE_PILOT_SECURITY_DIAGNOSTIC, 'first-collector-query-v2');
    assert.equal(a.options.shell, false);
    assert.equal(a.options.timeout, 10000);
    assert.equal(a.options.maxBuffer, 65536);
    assert.throws(() =>
        requireWinpsContractReply(
            JSON.parse(result.stdout),
            { expected: 'green', plans },
            powershell,
            'fixture.ps1',
        ),
    );
});

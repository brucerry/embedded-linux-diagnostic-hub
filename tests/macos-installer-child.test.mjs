import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
    captureMacHelperOperation,
    projectMacHelperChild,
    inspectMacInstallHelper,
    macHelperRecordPath,
} from '../scripts/lib/macos-installer-child.mjs';
import { createMacNativeIO } from '../scripts/lib/macos-native-io.mjs';
import { consumeInstallerLifecycleEvidence } from '../scripts/lib/installer-lifecycle-evidence.mjs';
import { installerMemoryFixture } from './fixtures/installer-lifecycle-memory.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const install = 'macos-bundle:install';
const nonce = '1'.repeat(32);
const runRoot = '/synthetic/task/diagnostic-hub-v060-macos-native-run-' + nonce;
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function fixture() {
    const base = installerMemoryFixture();
    const expected = base.expected;
    const archive = expected.artifacts.find((row) => row.name === 'Diagnostic-Hub-macos-arm64.zip');
    const operation = {
        operationId: nonce + ':' + install + ':helper:1',
        caseId: install,
        observerSource: { commit: expected.sourceCommit, tree: expected.sourceTree },
        package: { ...archive, version: expected.version, sourceCommit: expected.sourceCommit },
        fixtureRoot: runRoot + '/install',
        helper: runRoot + '/bin/download-run-macos.sh',
    };
    const command = [
        '/bin/bash',
        operation.helper,
        '--version',
        'v' + expected.version,
        '--directory',
        operation.fixtureRoot + '/Applications',
        '--no-launch',
    ];
    const row = {
        kind: 'fixed-child',
        index: 0,
        command,
        operation,
        error: 'none',
        exitObserved: true,
        closeObserved: true,
        exitCode: 0,
        signal: null,
        stdoutEOF: true,
        stderrEOF: true,
        streams: Object.fromEntries(
            ['stdout', 'stderr'].map((name) => [
                name,
                { path: 'child-0.' + name, bytes: 0, sha256: hash('') },
            ]),
        ),
    };
    const item = base.receipt.cases.find((value) => value.id === install);
    const bind = () => {
        base.change(install, (value) => {
            value.observation = structuredClone(row);
        });
        const bytes = json(row),
            path = macHelperRecordPath(row.index);
        base.files.set(path, bytes);
        item.evidence.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    };
    bind();
    return { base, expected, row, operation, item, bind };
}

test('install helper consistency is reread on each consumer invocation and remains unqualified', async () => {
    const f = fixture();
    let rowReads = 0;
    const read = async (path, maximum) => {
        const bytes = f.base.files.get(path);
        assert.ok(bytes && bytes.length <= maximum);
        if (path === 'evidence/child-0.json') rowReads++;
        return Buffer.from(bytes);
    };
    for (let index = 0; index < 2; index++) {
        const result = await consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, read);
        assert.equal(
            result.observations.find((row) => row.caseId === install).status,
            'helper-and-pipes-consistent-unqualified',
        );
        assert.equal(result.releaseAcceptance, false);
        assert.equal(result.status, 'installer-lifecycle-unqualified');
    }
    assert.equal(rowReads, 2);
});

test('honestly rehashed case command package and closure substitutions are rejected semantically', async () => {
    for (const mutate of [
        (row) => {
            row.operation.caseId = 'macos-bundle:repair';
        },
        (row) => {
            row.operation.operationId = nonce + ':' + install + ':helper:2';
        },
        (row) => {
            row.operation.observerSource.commit = 'd'.repeat(40);
        },
        (row) => {
            row.operation.observerSource.tree = 'd'.repeat(40);
        },
        (row) => {
            row.operation.package.sha256 = 'd'.repeat(64);
        },
        (row) => {
            row.operation.package.version = '0.5.2';
        },
        (row) => {
            row.operation.package.sourceCommit = 'd'.repeat(40);
        },
        (row) => {
            row.command[0] = '/different/bash';
        },
        (row) => {
            row.command[3] = 'v0.5.2';
        },
        (row) => {
            row.command.pop();
        },
        (row) => {
            row.closeObserved = false;
        },
        (row) => {
            row.exitObserved = false;
        },
        (row) => {
            row.stdoutEOF = false;
        },
        (row) => {
            row.stderrEOF = false;
        },
        (row) => {
            row.exitCode = 7;
        },
        (row) => {
            row.signal = 'SIGTERM';
        },
    ]) {
        const f = fixture();
        mutate(f.row);
        f.bind();
        await assert.rejects(
            consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        );
    }
});

test('operation IDs must be strings rather than coercible mutable values', () => {
    const f = fixture();
    for (const operationId of [[f.operation.operationId], null, 1, {}])
        assert.throws(() => captureMacHelperOperation({ ...f.operation, operationId }));
});

test('original child record is required and cannot be replaced by matching envelope labels', async () => {
    for (const change of [
        (f) => {
            f.item.evidence.pop();
        },
        (f) => {
            f.item.evidence.at(-1).path = 'evidence/child-1.json';
        },
        (f) => {
            f.row.index = 1;
            f.base.change(install, (value) => {
                value.observation = structuredClone(f.row);
            });
        },
        (f) => {
            f.base.files.set('evidence/child-0.json', Buffer.from('{}\n'));
        },
        (f) => {
            const other = structuredClone(f.row);
            other.exitCode = 7;
            const bytes = json(other);
            f.base.files.set('evidence/child-0.json', bytes);
            Object.assign(f.item.evidence.at(-1), { bytes: bytes.length, sha256: hash(bytes) });
        },
        (f) => {
            const bytes = Buffer.from(JSON.stringify(f.row) + '\n');
            f.base.files.set('evidence/child-0.json', bytes);
            Object.assign(f.item.evidence.at(-1), { bytes: bytes.length, sha256: hash(bytes) });
        },
    ]) {
        const f = fixture();
        change(f);
        await assert.rejects(
            consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        );
    }
});

test('one retained dynamic child fact cannot be reused for another installer case', async () => {
    const f = fixture();
    f.base.receipt.cases[1].evidence.push({ ...f.item.evidence.at(-1) });
    await assert.rejects(
        consumeInstallerLifecycleEvidence(f.base.receipt, f.expected, f.base.read),
        /reuse/,
    );
});

test('truthful failed helper rows remain publishable but cannot pass install consistency', () => {
    const f = fixture();
    const row = projectMacHelperChild(
        {
            ...f.row,
            exitCode: 70,
            request: {
                executable: f.row.command[0],
                args: f.row.command.slice(1),
                operation: f.operation,
            },
        },
        0,
        f.row.streams,
    );
    assert.equal(row.exitCode, 70);
    assert.equal(row.closeObserved, true);
    assert.throws(() => inspectMacInstallHelper(row, f.expected));
});

test('the actual child owner submits and projects immutable snapshots without publishing env', async () => {
    const f = fixture(),
        child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let submitted;
    const io = createMacNativeIO(0, {
        taskRoot: '/synthetic/task',
        now: () => 0,
        fs: {},
        spawn(executable, args, options) {
            submitted = { executable, args, options };
            queueMicrotask(() => {
                child.emit('exit', 0, null);
                child.stdout.emit('end');
                child.stderr.emit('end');
                child.emit('close');
            });
            return child;
        },
    });
    io.state.root = runRoot; // Fake admitted state; no filesystem/native permission is conferred.
    const args = f.row.command.slice(1),
        env = { PRIVATE_TOKEN: 'SECRET_ENV_CANARY' };
    const pending = io.child('/bin/bash', args, env, '/synthetic/source', f.operation);
    args[0] = '/changed-helper';
    env.PRIVATE_TOKEN = 'CHANGED';
    f.operation.package.sha256 = 'd'.repeat(64);
    const returned = await pending;
    assert.deepEqual(returned.command, f.row.command);
    assert.deepEqual(submitted.args, f.row.command.slice(1));
    assert.equal(submitted.options.env.PRIVATE_TOKEN, 'SECRET_ENV_CANARY');
    assert.equal(submitted.options.cwd, '/synthetic/source');
    const row = projectMacHelperChild(io.state.children[0], 0, f.row.streams);
    assert.equal(
        row.operation.package.sha256,
        f.expected.artifacts.find((row) => row.name.endsWith('.zip')).sha256,
    );
    assert.ok(!JSON.stringify(row).includes('SECRET_ENV_CANARY'));
    assert.ok(!JSON.stringify(row).includes('PRIVATE_TOKEN'));
    assert.equal(
        inspectMacInstallHelper(row, f.expected),
        'helper-and-pipes-consistent-unqualified',
    );
    assert.equal(io.needsHold(), false);
});

test('case binding outside the retained run root rejects before fake child submission', async () => {
    const f = fixture();
    let submitted = 0;
    const io = createMacNativeIO(0, {
        taskRoot: '/synthetic/task',
        now: () => 0,
        fs: {},
        spawn() {
            submitted++;
        },
    });
    io.state.root = '/synthetic/different-run';
    await assert.rejects(
        io.child('/bin/bash', f.row.command.slice(1), {}, '/synthetic/source', f.operation),
    );
    assert.equal(submitted, 0);
    assert.equal(io.state.children.length, 0);
});

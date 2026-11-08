import assert from 'node:assert/strict';
import path from 'node:path';

// These are the existing terminal-row and stage byte bounds, not a qualification policy.
export const MAC_HELPER_RECORD_LIMIT = 65536;
const hashPattern = /^[a-f0-9]{64}$/;
const keys = (value, wanted) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...wanted].sort());
};
function absolute(value) {
    assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 4096);
    assert.ok(
        path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value !== '/',
    );
    assert.ok(!/[\\\x00-\x1f\x7f]/.test(value));
}
function commandVector(value) {
    assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 32);
    for (const part of value)
        assert.ok(typeof part === 'string' && part.length > 0 && part.length <= 4096);
}
export function macHelperRecordPath(index) {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 32);
    return 'evidence/child-' + index + '.json';
}

/** Only caller-selected identities already available before a helper submission. A nonce
 * and paths here are consistency bindings, never proof of permission or service-run origin. */
export function captureMacHelperOperation(value) {
    const copy = structuredClone(value);
    keys(copy, ['operationId', 'caseId', 'observerSource', 'package', 'fixtureRoot', 'helper']);
    assert.equal(typeof copy.operationId, 'string');
    const match = /^([a-f0-9]{32}):(macos-bundle:[a-z][a-z-]{0,63}):helper:([1-9][0-9]{0,7})$/.exec(
        copy.operationId,
    );
    assert.ok(match);
    assert.equal(copy.caseId, match[2]);
    keys(copy.observerSource, ['commit', 'tree']);
    for (const field of ['commit', 'tree'])
        assert.match(copy.observerSource[field], /^[a-f0-9]{40}$/);
    keys(copy.package, ['name', 'bytes', 'sha256', 'version', 'sourceCommit']);
    assert.match(copy.package.name, /^Diagnostic-Hub-macos-(?:arm64|x64)\.zip$/);
    assert.ok(Number.isSafeInteger(copy.package.bytes) && copy.package.bytes > 0);
    assert.match(copy.package.sha256, hashPattern);
    assert.ok(typeof copy.package.version === 'string' && copy.package.version.length <= 128);
    assert.match(copy.package.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
    assert.match(copy.package.sourceCommit, /^[a-f0-9]{40}$/);
    absolute(copy.fixtureRoot);
    absolute(copy.helper);
    assert.equal(path.posix.basename(copy.fixtureRoot), copy.caseId.slice('macos-bundle:'.length));
    const runRoot = path.posix.dirname(copy.fixtureRoot);
    assert.equal(path.posix.basename(runRoot), 'diagnostic-hub-v060-macos-native-run-' + match[1]);
    assert.equal(copy.helper, path.posix.join(runRoot, 'bin/download-run-macos.sh'));
    Object.freeze(copy.observerSource);
    Object.freeze(copy.package);
    return Object.freeze(copy);
}

/** Closed allowlist projection of the existing private child record. It preserves failed
 * and refusal facts too; it does not turn a returned row into a successful install. */
export function projectMacHelperChild(record, index, streams) {
    macHelperRecordPath(index);
    const request = record.request;
    assert.ok(request);
    const command = [request.executable, ...request.args];
    commandVector(command);
    const row = {
        kind: 'fixed-child',
        index,
        command,
        operation: request.operation === null ? null : captureMacHelperOperation(request.operation),
        error: record.error,
        exitObserved: record.exitObserved,
        closeObserved: record.closeObserved,
        exitCode: record.exitCode,
        signal: record.signal,
        stdoutEOF: record.stdoutEOF,
        stderrEOF: record.stderrEOF,
        streams: structuredClone(streams),
    };
    assert.ok(['none', 'timeout', 'spawn-error'].includes(row.error));
    for (const key of ['exitObserved', 'closeObserved', 'stdoutEOF', 'stderrEOF'])
        assert.equal(typeof row[key], 'boolean');
    assert.ok(row.exitCode === null || Number.isSafeInteger(row.exitCode));
    assert.ok(row.signal === null || /^SIG[A-Z0-9]+$/.test(row.signal));
    keys(row.streams, ['stdout', 'stderr']);
    for (const name of ['stdout', 'stderr']) {
        const ref = row.streams[name];
        keys(ref, ['path', 'bytes', 'sha256']);
        assert.equal(ref.path, 'child-' + index + '.' + name);
        assert.ok(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= 65536);
        assert.match(ref.sha256, hashPattern);
    }
    return row;
}

/** Install-case helper/pipe consistency only. It proves neither an installed payload nor
 * genuine run issuance, helper loaded bytes, environment application or descendant retirement. */
export function inspectMacInstallHelper(row, expected) {
    keys(row, [
        'kind',
        'index',
        'command',
        'operation',
        'error',
        'exitObserved',
        'closeObserved',
        'exitCode',
        'signal',
        'stdoutEOF',
        'stderrEOF',
        'streams',
    ]);
    assert.equal(row.kind, 'fixed-child');
    macHelperRecordPath(row.index);
    const operation = captureMacHelperOperation(row.operation);
    assert.equal(operation.caseId, 'macos-bundle:install');
    assert.match(operation.operationId, /^[a-f0-9]{32}:macos-bundle:install:helper:1$/);
    assert.ok(['darwin-arm64', 'darwin-x64'].includes(expected.lane));
    assert.deepEqual(operation.observerSource, {
        commit: expected.sourceCommit,
        tree: expected.sourceTree,
    });
    const packages = expected.artifacts.filter(
        (item) => item.name === 'Diagnostic-Hub-macos-' + expected.lane.slice(7) + '.zip',
    );
    assert.equal(packages.length, 1);
    assert.deepEqual(operation.package, {
        ...packages[0],
        version: expected.version,
        sourceCommit: expected.sourceCommit,
    });
    commandVector(row.command);
    assert.deepEqual(row.command, [
        '/bin/bash',
        operation.helper,
        '--version',
        'v' + expected.version,
        '--directory',
        path.posix.join(operation.fixtureRoot, 'Applications'),
        '--no-launch',
    ]);
    const projected = projectMacHelperChild(
        { ...row, request: { executable: row.command[0], args: row.command.slice(1), operation } },
        row.index,
        row.streams,
    );
    assert.deepEqual(projected, row);
    for (const key of ['exitObserved', 'closeObserved', 'stdoutEOF', 'stderrEOF'])
        assert.equal(row[key], true, 'Missing observed helper closure: ' + key);
    assert.equal(row.exitCode, 0);
    assert.equal(row.signal, null);
    assert.equal(row.error, 'none');
    return 'helper-and-pipes-consistent-unqualified';
}

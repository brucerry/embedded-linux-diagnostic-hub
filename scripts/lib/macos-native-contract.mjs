import assert from 'node:assert/strict';
import path from 'node:path';
import { digest } from './staged-artifact-gate.mjs';
import { validateMacManifest } from './macos-release.mjs';

export const NATIVE_TASK = '/Users/bruce/Codex/2026-10-24/task';
export const NATIVE_LIMITS = Object.freeze({
    windowMs: 120000,
    streamBytes: 65536,
    resultBytes: 8192,
    stageBytes: 65536,
    controlBytes: 1048576,
    admissionBytes: 65536,
    terminalBytes: 327680,
    terminalRows: 32,
    evidenceBytes: 10485760,
});
export const NATIVE_EFFECTS = Object.freeze([
    'install',
    'repair',
    'distinct-version-replacement',
    'owned-app-launch-normal-quit',
    'owned-loopback',
    'fixed-save-dialog-substitution',
    'new-report-export-temporary-disposal',
    'controlled-activation-failure',
    'verified-new-bundle-removal',
    'helper-stage-disposal',
]);
const FLAGS = [
    'approval',
    'approval-sha256',
    'root',
    'source-root',
    'current-zip',
    'current-info',
    'current-tree',
    'prior-zip',
    'prior-info',
    'prior-tree',
];
const hashPattern = /^[a-f0-9]{64}$/;
export function parseMacNativeArgs(argv) {
    assert.ok(Array.isArray(argv) && argv.every((value) => typeof value === 'string'));
    if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return { mode: 'help' };
    assert.ok(['--validate', '--run'].includes(argv[0]), 'Choose --validate or --run explicitly.');
    const parsed = { mode: argv[0].slice(2) };
    for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index].slice(2),
            value = argv[index + 1];
        assert.ok(
            argv[index].startsWith('--') && FLAGS.includes(flag) && !Object.hasOwn(parsed, flag),
        );
        assert.ok(value && !value.startsWith('--') && value.length <= 4096);
        if (flag === 'approval-sha256') assert.match(value, hashPattern);
        else
            assert.ok(
                path.posix.isAbsolute(value) &&
                    path.posix.normalize(value) === value &&
                    !value.includes('\0') &&
                    value.startsWith(NATIVE_TASK + '/'),
            );
        parsed[flag] = value;
    }
    assert.ok(
        FLAGS.every((flag) => Object.hasOwn(parsed, flag)),
        'All package and approval bindings are required.',
    );
    assert.ok(
        !FLAGS.filter((flag) => flag !== 'approval-sha256').some(
            (flag) => parsed[flag] === parsed.root && flag !== 'root',
        ),
    );
    return parsed;
}
export function normalizeMacTree(value) {
    const rows = value.entries ?? value.files;
    assert.ok(Array.isArray(rows) && rows.length > 0);
    const entries = new Map();
    for (const item of rows) {
        const relative = item.path;
        assert.ok(
            typeof relative === 'string' &&
                relative.length > 0 &&
                relative !== '.' &&
                !path.posix.isAbsolute(relative) &&
                path.posix.normalize(relative) === relative &&
                !relative.split('/').includes('..') &&
                !relative.includes('\\') &&
                !relative.includes('\0'),
        );
        assert.ok(!entries.has(relative) && ['file', 'symlink', 'directory'].includes(item.kind));
        const row = { path: relative, kind: item.kind };
        if (item.kind === 'file') {
            assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
            assert.match(item.sha256, hashPattern);
            assert.ok(Number.isInteger(item.mode) && item.mode >= 0 && item.mode <= 0o777);
            Object.assign(row, { bytes: item.bytes, sha256: item.sha256, mode: item.mode });
        } else if (item.kind === 'symlink') {
            assert.ok(
                typeof item.target === 'string' &&
                    item.target.length > 0 &&
                    !path.posix.isAbsolute(item.target) &&
                    !item.target.includes('\\'),
            );
            const resolved = path.posix.normalize(
                path.posix.join(path.posix.dirname(relative), item.target),
            );
            assert.ok(
                resolved !== '..' && !resolved.startsWith('../') && !item.target.includes('\0'),
            );
            row.target = item.target;
        } else if (item.mode !== undefined) {
            assert.ok(Number.isInteger(item.mode) && item.mode >= 0 && item.mode <= 0o777);
            row.mode = item.mode;
        }
        entries.set(relative, row);
    }
    for (const relative of [...entries.keys()]) {
        let parent = path.posix.dirname(relative);
        while (parent !== '.') {
            if (entries.has(parent))
                assert.equal(
                    entries.get(parent).kind,
                    'directory',
                    'An archive parent cannot be a link/file.',
                );
            else entries.set(parent, { path: parent, kind: 'directory' });
            parent = path.posix.dirname(parent);
        }
    }
    assert.ok(entries.get('Contents/Info.plist')?.kind === 'file');
    assert.ok(entries.get('Contents/Resources/app.asar')?.kind === 'file');
    assert.ok(entries.get('Contents/MacOS/Diagnostic Hub')?.kind === 'file');
    return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export async function validateMacNativeRequest(parsed, io, expectedSourcePins) {
    assert.notEqual(parsed.mode, 'help');
    let controlBytes = 0;
    const readJSON = async (file, cap) => {
        const bytes = await io.read(file, cap);
        controlBytes += bytes.length;
        assert.ok(controlBytes <= NATIVE_LIMITS.controlBytes);
        return { bytes, value: JSON.parse(bytes.toString('utf8')) };
    };
    const { bytes: approvalBytes, value: approval } = await readJSON(
        parsed.approval,
        NATIVE_LIMITS.admissionBytes,
    );
    assert.equal(digest(approvalBytes), parsed['approval-sha256']);
    assert.equal(approval.operation, 'macos-native-installer-lifecycle');
    assert.equal(approval.approved, true);
    assert.match(approval.nonce, /^[a-f0-9]{32}$/);
    assert.equal(
        parsed.root,
        path.posix.join(NATIVE_TASK, 'diagnostic-hub-v060-macos-native-run-' + approval.nonce),
    );
    assert.equal(approval.root, parsed.root);
    assert.equal(approval.sourceRoot, parsed['source-root']);
    assert.equal(await io.canonicalDir(approval.sourceRoot), approval.sourceRoot);
    assert.ok(
        approval.sourceRoot !== parsed.root && !approval.sourceRoot.startsWith(parsed.root + '/'),
    );
    assert.equal(approval.windowMs, NATIVE_LIMITS.windowMs);
    assert.ok(
        Number.isSafeInteger(approval.clockAllowanceMs) &&
            approval.clockAllowanceMs >= 0 &&
            approval.clockAllowanceMs < approval.windowMs,
    );
    assert.ok(Number.isSafeInteger(approval.minimumFreeBytes) && approval.minimumFreeBytes > 0);
    assert.deepEqual([...approval.effects].sort(), [...NATIVE_EFFECTS].sort());
    const now = io.nowUTC();
    const issued = Date.parse(approval.issuedAt),
        expiry = Date.parse(approval.expiresAt);
    assert.equal(new Date(issued).toISOString(), approval.issuedAt);
    assert.equal(new Date(expiry).toISOString(), approval.expiresAt);
    assert.ok(
        issued <= now + approval.clockAllowanceMs &&
            expiry - issued === approval.windowMs &&
            now < expiry - approval.clockAllowanceMs,
    );
    io.setExpiry(expiry, approval.clockAllowanceMs);
    assert.equal(await io.canonicalDir(NATIVE_TASK), NATIVE_TASK);
    assert.ok(await io.absent(parsed.root));
    assert.ok(await io.absent(parsed.root + '.SPENT.json'));
    assert.ok(
        approval.inputs &&
            approval.pins &&
            approval.pins.length === expectedSourcePins.length &&
            approval.pins.length <= 20,
    );
    const metadata = io.metadata();
    assert.equal(metadata.platform, 'darwin');
    assert.match(metadata.node, /^24\./);
    assert.equal(metadata.executable, expectedSourcePins.find((item) => item.role === 'node').path);
    assert.ok(['arm64', 'x64'].includes(metadata.arch));
    for (const expected of expectedSourcePins) {
        const pin = approval.pins.find((item) => item.role === expected.role);
        assert.ok(
            pin && pin.path === expected.path && Number.isSafeInteger(pin.bytes) && pin.bytes > 0,
        );
        assert.match(pin.sha256, hashPattern);
        assert.deepEqual(await io.hash(pin.path, pin.bytes), {
            bytes: pin.bytes,
            sha256: pin.sha256,
        });
    }
    const packages = {};
    for (const role of ['current', 'prior']) {
        const wanted = approval.inputs[role];
        assert.ok(
            wanted &&
                wanted.zip === parsed[role + '-zip'] &&
                wanted.info === parsed[role + '-info'] &&
                wanted.tree === parsed[role + '-tree'],
        );
        assert.ok(Number.isSafeInteger(wanted.zipBytes) && wanted.zipBytes > 0);
        for (const key of ['zipSHA256', 'infoSHA256', 'treeSHA256'])
            assert.match(wanted[key], hashPattern);
        const info = await readJSON(wanted.info, 65536),
            tree = await readJSON(wanted.tree, NATIVE_LIMITS.controlBytes);
        assert.equal(digest(info.bytes), wanted.infoSHA256);
        assert.equal(digest(tree.bytes), wanted.treeSHA256);
        assert.ok(
            typeof info.value.version === 'string' &&
                /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(info.value.version),
        );
        assert.deepEqual(await io.hash(wanted.zip, wanted.zipBytes), {
            bytes: wanted.zipBytes,
            sha256: wanted.zipSHA256,
        });
        validateMacManifest(info.value, {
            arch: metadata.arch,
            version: info.value.version,
            commit: info.value.commit,
            sha256: wanted.zipSHA256,
        });
        const inventory = normalizeMacTree(tree.value);
        assert.equal(
            inventory.find((item) => item.path === 'Contents/Resources/app.asar').sha256,
            info.value.asarSHA256,
        );
        packages[role] = {
            version: info.value.version,
            sourceCommit: info.value.commit,
            zipPath: wanted.zip,
            zipSHA256: wanted.zipSHA256,
            asarSHA256: info.value.asarSHA256,
            info: info.value,
            inventory,
            identity: wanted,
        };
    }
    assert.notEqual(packages.current.version, packages.prior.version);
    assert.notEqual(packages.current.zipSHA256, packages.prior.zipSHA256);
    assert.equal(approval.sourceCommit, packages.current.sourceCommit);
    assert.match(approval.sourceTree, /^[a-f0-9]{40}$/);
    const summary = {
        schemaVersion: 1,
        operation: approval.operation,
        root: parsed.root,
        nonce: approval.nonce,
        approvalSHA256: digest(approvalBytes),
        current: packages.current.identity,
        prior: packages.prior.identity,
        pins: approval.pins,
        effects: approval.effects,
        windowMs: approval.windowMs,
        expiresAt: approval.expiresAt,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= NATIVE_LIMITS.admissionBytes);
    return { parsed, approval, packages, metadata, summary, expectedSourcePins, controlBytes };
}

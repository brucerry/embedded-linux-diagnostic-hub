import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedReceiptBytes } from './bounded-receipt-json.mjs';
import { macAsset, macManifest, validateMacManifest } from './macos-release.mjs';
import { includesWindowsSetup } from './release-assets.mjs';

const macLanes = new Set(['darwin-arm64', 'darwin-x64']);
const bindingData = new WeakMap();
const markerLimit = 8192;
const buildInfoLimit = 64 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

export const requiresStagedMacRuntimeBinding = (expected) =>
    macLanes.has(expected.lane) && includesWindowsSetup(expected.version);

function context(expected) {
    assert.ok(requiresStagedMacRuntimeBinding(expected), 'No current staged Mac lane selected.');
    const { lane, version, sourceCommit, sourceTree, runId, runAttempt } = expected;
    for (const commit of [sourceCommit, sourceTree]) assert.match(commit, /^[a-f0-9]{40}$/);
    for (const value of [runId, runAttempt]) assert.match(value, /^[1-9][0-9]{0,31}$/);
    return { lane, version, sourceCommit, sourceTree, runId, runAttempt };
}
function exactRef(rows, field, name, max = Number.MAX_SAFE_INTEGER) {
    assert.ok(Array.isArray(rows));
    const selected = rows.filter((row) => row[field] === name);
    assert.equal(selected.length, 1, 'Require a unique pinned Mac input: ' + name);
    const { bytes, sha256 } = selected[0];
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= max);
    assert.match(sha256, /^[a-f0-9]{64}$/);
    return { [field]: name, bytes, sha256 };
}
function artifactRefs(expected) {
    const arch = expected.lane.slice('darwin-'.length);
    return {
        archive: exactRef(expected.artifacts, 'name', macAsset(arch)),
        manifest: exactRef(expected.artifacts, 'name', macManifest(arch), buildInfoLimit),
    };
}
const markerFile = ({ lane }) => `${lane}/installed-environment.txt`;
function helperMarker(receipt, expected) {
    const helpers = receipt.cases.filter((item) => item.id === 'bundle-helper-installer');
    assert.equal(helpers.length, 1, 'Require one retained Mac helper case.');
    const [helper] = helpers;
    assert.equal(helper.status, 'passed');
    assert.equal(helper.exitCode, 0);
    assert.equal(helper.signal, null);
    const marker = exactRef(helper.evidence, 'path', markerFile(expected), markerLimit);
    assert.ok(
        receipt.cases
            .filter((item) => item !== helper)
            .every((item) => !item.evidence.some((entry) => entry.path === marker.path)),
        'Mac helper marker must belong only to its own case.',
    );
    return marker;
}

async function readInside(root, relative, maximum) {
    const base = await realpath(root);
    const file = path.join(base, ...relative.split('/'));
    assert.equal(await realpath(file), file, 'Aliased staged Mac input.');
    return readBoundedReceiptBytes(file, maximum);
}
async function readPinned(root, relative, ref, maximum) {
    const bytes = await readInside(root, relative, maximum);
    assert.equal(bytes.length, ref.bytes, 'Staged Mac input length changed.');
    assert.equal(hash(bytes), ref.sha256, 'Staged Mac input bytes changed.');
    return bytes;
}

function installPaths(bytes) {
    const content = text(bytes);
    const fields = /^HUB_TEST_EXECUTABLE=([^\n]+)\nHUB_MAC_INSTALLED_APP=([^\n]+)\n$/.exec(content);
    assert.ok(fields && fields[0] === content, 'Invalid retained Mac helper marker.');
    const [, executable, app] = fields;
    assert.ok(
        path.posix.isAbsolute(app) &&
            path.posix.normalize(app) === app &&
            !/[\\\x00-\x1f\x7f]/.test(app) &&
            path.posix.basename(app) === 'Diagnostic Hub.app',
        'Require canonical helper-installed Mac bundle path.',
    );
    assert.equal(
        executable,
        app + '/Contents/MacOS/Diagnostic Hub',
        'Mac helper executable does not belong to its installed bundle.',
    );
    return { executable, asar: app + '/Contents/Resources/app.asar' };
}

function buildInfo(bytes) {
    const value = text(bytes);
    const parsed = JSON.parse(value);
    assert.ok(
        [
            JSON.stringify(parsed),
            JSON.stringify(parsed) + '\n',
            JSON.stringify(parsed, null, 2) + '\n',
        ].includes(value),
        'Require unambiguous Mac shipping build-info bytes.',
    );
    return parsed;
}

/** Hash the existing helper report without rewriting it. The successful case retains this ref. */
export async function recordStagedMacInstallMarker(root, expected) {
    const relative = markerFile(context(expected));
    const bytes = await readInside(root, relative, markerLimit);
    installPaths(bytes);
    return { path: relative, bytes: bytes.length, sha256: hash(bytes) };
}

/** Correlate the native case with the separately selected staged asset hashes and helper
 * output. The readback binds observed named-file hashes/paths, not loaded inodes or provenance. */
export async function readStagedMacRuntimeBinding(releaseRoot, evidenceRoot, receipt, expected) {
    const selected = context(expected),
        refs = artifactRefs(expected),
        marker = helperMarker(receipt, selected);
    const info = validateMacManifest(
        buildInfo(await readPinned(releaseRoot, refs.manifest.name, refs.manifest, buildInfoLimit)),
        {
            version: selected.version,
            commit: selected.sourceCommit,
            arch: selected.lane.slice('darwin-'.length),
            sha256: refs.archive.sha256,
        },
    );
    assert.ok(info.payloadIdentity, 'Missing current Mac shipping payload identity.');
    const binding = Object.freeze(
        installPaths(await readPinned(evidenceRoot, marker.path, marker, markerLimit)),
    );
    bindingData.set(binding, {
        selected,
        refs,
        marker,
        executableSHA256: info.payloadIdentity.executableSHA256,
        asarSHA256: info.payloadIdentity.asarSHA256,
    });
    return binding;
}

/** Inputs cannot make a binding merely by supplying its visible path pair. */
export function validateStagedMacRuntimeBinding(actual, expected, receipt) {
    const binding = expected.macRuntimeBinding,
        selected = context(expected),
        pinned = bindingData.get(binding);
    assert.ok(pinned, 'Missing independently read current Mac runtime binding.');
    assert.deepEqual(pinned.selected, selected, 'Mac runtime binding belongs to a different run.');
    assert.deepEqual(
        pinned.refs,
        artifactRefs(expected),
        'Staged Mac runtime artifact pins changed.',
    );
    assert.deepEqual(
        pinned.marker,
        helperMarker(receipt, selected),
        'Retained Mac helper pin changed.',
    );
    assert.equal(
        actual.executable,
        binding.executable,
        'Observed Mac executable is not helper-installed.',
    );
    assert.equal(actual.asar, binding.asar, 'Observed Mac ASAR is not helper-installed.');
    assert.equal(
        actual.executableSHA256,
        pinned.executableSHA256,
        'Observed Mac executable SHA-256 differs from shipping payload.',
    );
    assert.equal(
        actual.asarSHA256,
        pinned.asarSHA256,
        'Observed Mac ASAR SHA-256 differs from shipping payload.',
    );
    return actual;
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requireOwnedDraft } from './release-draft.mjs';
import { publishedCatalog, validatePublishedFiles } from './published-release.mjs';

export const EXISTING_RELEASE = Object.freeze({
    repository: 'brucerry/embedded-linux-diagnostic-hub',
    tag: 'v0.5.1',
    version: '0.5.1',
    source: 'dd71117299982c869dbcd187079e7951b60ac878',
    tagObject: '91cb1ca71bfb81eb5c1ff9218f02144f462759b7',
    run: 38523035861,
    attempt: 1,
    failedJob: 115725641476,
    draft: 412405837,
});
export const QUALIFIED_ARTIFACTS = Object.freeze(
    [
        {
            name: 'Diagnostic-Hub-lab-gateway',
            id: 11875276911,
            size_in_bytes: 30990,
            digest: 'sha256:1feb1568c2bf4e38f3f5a686bdfb5bd9754bdd8c8e6a4383671885db783439a4',
        },
        {
            name: 'Diagnostic-Hub-web-portable',
            id: 11875062249,
            size_in_bytes: 348201,
            digest: 'sha256:e2268c1b025d01d71117ebe9e7c5a1d92a51b208f87672e2f71c89f452b677f1',
        },
        {
            name: 'Diagnostic-Hub-win-x64',
            id: 11874743637,
            size_in_bytes: 102626648,
            digest: 'sha256:51f7ce9814983eea1d295d3de513229b8277b2d73b0d1a2bfb24803a686c1e7f',
        },
        {
            name: 'Diagnostic-Hub-linux-x64',
            id: 11874358204,
            size_in_bytes: 246395339,
            digest: 'sha256:5c9252add563604bd22540af22aaa9a8a403ae4eba1d8a53c0bd58a8c6872e6b',
        },
    ].map((artifact) => Object.freeze(artifact)),
);
export const SUCCESSFUL_JOBS = Object.freeze([
    'version',
    'draft',
    'website / build',
    'desktop / build',
    'linux / build',
    'macos / build (macos-15-intel, x64, mac)',
    'macos / build (macos-15, arm64, mac-arm64)',
    'linux / gnome (debian:13, 48, x11)',
    'linux / gnome (debian:13, 48, wayland)',
    'linux / gnome (ubuntu:24.04, 46, x11)',
    'linux / gnome (ubuntu:24.04, 46, wayland)',
    'linux / gnome (ubuntu:22.04, 42, x11)',
    'linux / gnome (ubuntu:22.04, 42, wayland)',
    'linux / gnome (ubuntu:26.04, 50, wayland)',
]);
const SKIPPED_JOBS = [
    'Audit already published release (read only)',
    'Verify audited public Mac command',
    'published-macos',
];
export const OPERATIONAL_FILES = Object.freeze([
    'scripts/lib/release-notes.mjs',
    'scripts/release-draft.mjs',
    'tests/release-publication-notes.test.ts',
    'scripts/lib/existing-release-recovery.mjs',
    'scripts/check-existing-release-recovery.mjs',
    '.github/workflows/release-existing-recovery.yml',
    'tests/existing-release-recovery.test.ts',
]);
const marker =
    'Diagnostic Hub guarded draft; source=' +
    EXISTING_RELEASE.source +
    '; tag=' +
    EXISTING_RELEASE.tag;
const names = publishedCatalog(EXISTING_RELEASE.version);
export const MAX_RECOVERY_BYTES = 1024 * 1024 * 1024;
export function requireExistingSource(tag, source, remoteRef, remoteTag) {
    assert.equal(tag, EXISTING_RELEASE.tag);
    assert.equal(source, EXISTING_RELEASE.source);
    assert.equal(remoteRef.object.type, 'tag');
    assert.equal(remoteRef.object.sha, EXISTING_RELEASE.tagObject, 'Immutable tag object changed.');
    assert.equal(remoteTag.tag, EXISTING_RELEASE.tag);
    assert.equal(remoteTag.object.type, 'commit');
    assert.equal(remoteTag.object.sha, EXISTING_RELEASE.source, 'Immutable source changed.');
}
export function validateExistingQualification(run, jobs, artifacts) {
    assert.equal(run.id, EXISTING_RELEASE.run);
    assert.equal(run.run_attempt, EXISTING_RELEASE.attempt);
    assert.equal(run.head_sha, EXISTING_RELEASE.source);
    assert.equal(run.head_branch, EXISTING_RELEASE.tag);
    assert.equal(run.path, '.github/workflows/release.yml');
    assert.equal(run.event, 'push');
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'failure');
    assert.equal(run.repository.full_name, EXISTING_RELEASE.repository);
    assert.equal(run.repository.private, false);
    assert.equal(new Set(jobs.map((j) => j.id)).size, jobs.length);
    assert.deepEqual(
        jobs.map((j) => j.name).sort(),
        [...SUCCESSFUL_JOBS, ...SKIPPED_JOBS, 'publish'].sort(),
    );
    for (const job of jobs) {
        assert.equal(job.run_id, EXISTING_RELEASE.run);
        assert.equal(job.status, 'completed');
        if (SUCCESSFUL_JOBS.includes(job.name))
            assert.equal(job.conclusion, 'success', 'Unqualified job: ' + job.name);
        else if (SKIPPED_JOBS.includes(job.name)) assert.equal(job.conclusion, 'skipped');
        else {
            assert.equal(job.id, EXISTING_RELEASE.failedJob);
            assert.equal(job.conclusion, 'failure');
            assert.deepEqual(
                job.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name),
                ['Publish only the complete guarded and tested draft'],
            );
            for (const name of [
                'Check every release asset, checksum and source manifest',
                'Prepare four-section release notes from the previous published release',
            ])
                assert.ok(job.steps.some((s) => s.name === name && s.conclusion === 'success'));
        }
    }
    for (const pinned of QUALIFIED_ARTIFACTS) {
        const matches = artifacts.filter((a) => a.name === pinned.name);
        assert.equal(matches.length, 1);
        const a = matches[0];
        assert.deepEqual(
            { name: a.name, id: a.id, size_in_bytes: a.size_in_bytes, digest: a.digest },
            pinned,
        );
        assert.equal(a.expired, false);
        assert.equal(a.workflow_run.id, EXISTING_RELEASE.run);
        assert.equal(a.workflow_run.head_sha, EXISTING_RELEASE.source);
        assert.equal(a.workflow_run.head_branch, EXISTING_RELEASE.tag);
    }
    return QUALIFIED_ARTIFACTS.map((a) => ({ ...a }));
}
export function validateKnownPublicationFailure(log) {
    assert.ok(
        log.includes("assert.ok(finalNotes.startsWith('Description:\\n'))"),
        'Original failure does not match diagnosed heading guard.',
    );
    assert.ok(log.includes('scripts/release-draft.mjs:228:12'));
}
export function existingInventory(release) {
    requireOwnedDraft(release, {
        tag: EXISTING_RELEASE.tag,
        commit: EXISTING_RELEASE.source,
        marker,
    });
    assert.equal(release.id, EXISTING_RELEASE.draft);
    assert.equal(release.name, EXISTING_RELEASE.tag);
    assert.equal(release.prerelease, false);
    assert.ok(Array.isArray(release.assets));
    assert.deepEqual(
        release.assets.map((a) => a.name).sort(),
        names,
        'Recovery requires all 24 existing assets.',
    );
    assert.equal(new Set(release.assets.map((a) => a.id)).size, names.length);
    let size = 0;
    return release.assets
        .map((a) => {
            assert.ok(Number.isSafeInteger(a.id) && a.id > 0);
            assert.ok(Number.isSafeInteger(a.size) && a.size > 0 && a.size <= 512 * 1024 * 1024);
            assert.match(a.digest, /^sha256:[a-f0-9]{64}$/);
            size += a.size;
            assert.ok(size <= MAX_RECOVERY_BYTES);
            return { id: a.id, name: a.name, size: a.size, digest: a.digest };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}
export function requireExistingInventory(release, inventory) {
    assert.deepEqual(existingInventory(release), inventory, 'Existing draft inventory changed.');
}
export function createExistingReceipt(release, artifacts, toolingSHA) {
    assert.match(toolingSHA, /^[a-f0-9]{40}$/);
    assert.deepEqual(artifacts, QUALIFIED_ARTIFACTS);
    return {
        schema: 1,
        context: { ...EXISTING_RELEASE },
        toolingSHA,
        artifacts: artifacts.map((a) => ({ ...a })),
        inventory: existingInventory(release),
    };
}
export function validateExistingReceipt(receipt, toolingSHA) {
    assert.deepEqual(
        Object.keys(receipt).sort(),
        ['schema', 'context', 'toolingSHA', 'artifacts', 'inventory'].sort(),
    );
    assert.equal(receipt.schema, 1);
    assert.deepEqual(receipt.context, EXISTING_RELEASE);
    assert.match(toolingSHA, /^[a-f0-9]{40}$/);
    assert.equal(receipt.toolingSHA, toolingSHA);
    assert.deepEqual(receipt.artifacts, QUALIFIED_ARTIFACTS);
    const modeled = {
        id: EXISTING_RELEASE.draft,
        name: EXISTING_RELEASE.tag,
        tag_name: EXISTING_RELEASE.tag,
        target_commitish: EXISTING_RELEASE.source,
        body: marker,
        draft: true,
        prerelease: false,
        assets: receipt.inventory,
    };
    assert.deepEqual(existingInventory(modeled), receipt.inventory);
    return receipt;
}
export function validateExistingFiles(files, inventory, tagBlob) {
    assert.deepEqual(Object.keys(files).sort(), names);
    for (const asset of inventory) {
        const bytes = files[asset.name];
        assert.equal(bytes.length, asset.size);
        assert.equal(
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
            asset.digest,
            'Staged bytes changed: ' + asset.name,
        );
    }
    validatePublishedFiles(
        files,
        {
            version: EXISTING_RELEASE.version,
            commit: EXISTING_RELEASE.source,
            minimumMacOSVersion: '13.0.0',
        },
        tagBlob,
    );
    const json = (name) => JSON.parse(files[name].toString().replace(/^\uFEFF/, ''));
    const win = json('build-info.json');
    assert.equal(win.version, EXISTING_RELEASE.version);
    assert.equal(win.commit, EXISTING_RELEASE.source);
    assert.ok(['Valid', 'NotSigned'].includes(win.signature));
    const linux = json('linux-build-info.json');
    assert.equal(linux.version, EXISTING_RELEASE.version);
    assert.equal(linux.commit, EXISTING_RELEASE.source);
    assert.equal(linux.platform, 'linux');
    assert.equal(linux.arch, 'x64');
    assert.deepEqual(
        Object.keys(linux.assets).sort(),
        ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz'].sort(),
    );
    for (const [name, sha] of Object.entries(linux.assets))
        assert.equal(createHash('sha256').update(files[name]).digest('hex'), sha);
}
export async function extractQualifiedArchive(bytes, artifact) {
    assert.equal(bytes.length, artifact.size_in_bytes);
    assert.equal(
        'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        artifact.digest,
        'Qualified artifact ZIP digest changed.',
    );
    const expected = {
        'Diagnostic-Hub-lab-gateway': [
            'Diagnostic-Hub-Gateway-0.5.1.tar.gz',
            'Diagnostic-Hub-Gateway-0.5.1.tar.gz.sha256',
        ],
        'Diagnostic-Hub-web-portable': [
            'Diagnostic-Hub-Web-0.5.1.zip',
            'Diagnostic-Hub-Web-0.5.1.zip.sha256',
            'download-run.ps1',
            'download-run.ps1.sha256',
            'download-run.sh',
            'download-run.sh.sha256',
            'download-run-macos.sh',
            'download-run-macos.sh.sha256',
        ],
        'Diagnostic-Hub-win-x64': [
            'Diagnostic-Hub.exe',
            'Diagnostic-Hub.exe.sha256',
            'build-info.json',
        ],
        'Diagnostic-Hub-linux-x64': [
            'Diagnostic-Hub-linux-x64.AppImage',
            'Diagnostic-Hub-linux-x64.AppImage.sha256',
            'Diagnostic-Hub-linux-x64.tar.gz',
            'Diagnostic-Hub-linux-x64.tar.gz.sha256',
            'linux-build-info.json',
        ],
    }[artifact.name];
    assert.ok(expected);
    const seen = new Set();
    let total = 0;
    const { unzipSync } = await import('fflate');
    const decoded = unzipSync(bytes, {
        filter: (file) => {
            assert.ok(expected.includes(file.name), 'Unexpected artifact path.');
            assert.ok(!seen.has(file.name), 'Duplicate artifact path.');
            seen.add(file.name);
            assert.ok(
                Number.isSafeInteger(file.originalSize) &&
                    file.originalSize > 0 &&
                    file.originalSize <= 512 * 1024 * 1024,
            );
            total += file.originalSize;
            assert.ok(total <= 512 * 1024 * 1024);
            return true;
        },
    });
    assert.deepEqual(Object.keys(decoded).sort(), expected.sort());
    return Object.fromEntries(
        Object.entries(decoded).map(([name, bytes]) => [name, Buffer.from(bytes)]),
    );
}

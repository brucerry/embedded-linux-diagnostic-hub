import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import {
    EXISTING_RELEASE as p,
    QUALIFIED_ARTIFACTS,
    SUCCESSFUL_JOBS,
    requireExistingSource,
    validateExistingQualification,
    validateKnownPublicationFailure,
    existingInventory,
    createExistingReceipt,
    validateExistingReceipt,
    requireExistingInventory,
    extractQualifiedArchive,
} from '../scripts/lib/existing-release-recovery.mjs';
import { publishedCatalog } from '../scripts/lib/published-release.mjs';
function evidence() {
    const run = {
        id: p.run,
        run_attempt: p.attempt,
        head_sha: p.source,
        head_branch: p.tag,
        path: '.github/workflows/release.yml',
        event: 'push',
        status: 'completed',
        conclusion: 'failure',
        repository: { full_name: p.repository, private: false },
    };
    const successful = SUCCESSFUL_JOBS.map((name, i) => ({
        id: i + 1,
        name,
        run_id: p.run,
        status: 'completed',
        conclusion: 'success',
        steps: [],
    }));
    const skipped = [
        'Audit already published release (read only)',
        'Verify audited public Mac command',
        'published-macos',
    ].map((name, i) => ({
        id: 100 + i,
        name,
        run_id: p.run,
        status: 'completed',
        conclusion: 'skipped',
        steps: [],
    }));
    const publish = {
        id: p.failedJob,
        name: 'publish',
        run_id: p.run,
        status: 'completed',
        conclusion: 'failure',
        steps: [
            { name: 'Publish only the complete guarded and tested draft', conclusion: 'failure' },
            {
                name: 'Check every release asset, checksum and source manifest',
                conclusion: 'success',
            },
            {
                name: 'Prepare four-section release notes from the previous published release',
                conclusion: 'success',
            },
        ],
    };
    const artifacts = QUALIFIED_ARTIFACTS.map((a) => ({
        ...a,
        expired: false,
        workflow_run: { id: p.run, head_sha: p.source, head_branch: p.tag },
    }));
    return { run, jobs: [...successful, ...skipped, publish], artifacts };
}
function draft() {
    return {
        id: p.draft,
        name: p.tag,
        tag_name: p.tag,
        target_commitish: p.source,
        body: 'Diagnostic Hub guarded draft; source=' + p.source + '; tag=' + p.tag,
        draft: true,
        prerelease: false,
        assets: publishedCatalog(p.version).map((name, i) => ({
            id: i + 1,
            name,
            size: 100,
            digest: 'sha256:' + 'a'.repeat(64),
        })),
    };
}
test('recovery requires the diagnosed run, every native gate and exact immutable qualified artifact receipts', () => {
    const e = evidence();
    assert.deepEqual(
        validateExistingQualification(e.run, e.jobs, e.artifacts),
        QUALIFIED_ARTIFACTS,
    );
    for (const field of [
        { id: p.run + 1 },
        { run_attempt: 2 },
        { head_sha: 'b'.repeat(40) },
        { head_branch: 'main' },
        { event: 'workflow_dispatch' },
        { status: 'in_progress' },
        { repository: { full_name: p.repository, private: true } },
    ])
        assert.throws(() =>
            validateExistingQualification({ ...e.run, ...field }, e.jobs, e.artifacts),
        );
    const failed = structuredClone(e.jobs);
    failed[0].conclusion = 'failure';
    assert.throws(() => validateExistingQualification(e.run, failed, e.artifacts));
    assert.throws(() => validateExistingQualification(e.run, e.jobs.slice(1), e.artifacts));
    const altered = structuredClone(e.artifacts);
    altered[0].digest = 'sha256:' + 'b'.repeat(64);
    assert.throws(() => validateExistingQualification(e.run, e.jobs, altered));
    const expired = structuredClone(e.artifacts);
    expired[0].expired = true;
    assert.throws(() => validateExistingQualification(e.run, e.jobs, expired));
    validateKnownPublicationFailure(
        "assert.ok(finalNotes.startsWith('Description:\\n')) scripts/release-draft.mjs:228:12",
    );
    assert.throws(() => validateKnownPublicationFailure('Unrelated failure'));
});
test('recovery never relabels tag/source/draft or accepts incomplete or changed asset identity', () => {
    const ref = { object: { type: 'tag', sha: p.tagObject } },
        tag = { tag: p.tag, object: { type: 'commit', sha: p.source } };
    requireExistingSource(p.tag, p.source, ref, tag);
    assert.throws(() => requireExistingSource(p.tag, 'b'.repeat(40), ref, tag));
    assert.throws(() =>
        requireExistingSource(
            p.tag,
            p.source,
            { object: { type: 'tag', sha: 'b'.repeat(40) } },
            tag,
        ),
    );
    const d = draft(),
        inventory = existingInventory(d);
    assert.equal(inventory.length, 24);
    const receipt = createExistingReceipt(d, QUALIFIED_ARTIFACTS, 'c'.repeat(40));
    validateExistingReceipt(receipt, 'c'.repeat(40));
    assert.throws(() => validateExistingReceipt(receipt, 'd'.repeat(40)));
    for (const change of [
        { id: p.draft + 1 },
        { draft: false },
        { prerelease: true },
        { target_commitish: 'b'.repeat(40) },
        { assets: d.assets.slice(1) },
    ])
        assert.throws(() => existingInventory({ ...d, ...change }));
    const changed = structuredClone(d);
    changed.assets[0].id += 100;
    assert.throws(() => requireExistingInventory(changed, inventory));
    const malformed = structuredClone(receipt);
    malformed.inventory[0].digest = 'bad';
    assert.throws(() => validateExistingReceipt(malformed, 'c'.repeat(40)));
});
test('qualified ZIP extraction verifies exact archive bytes and refuses extra or traversing entries', async () => {
    const name = 'Diagnostic-Hub-lab-gateway';
    const archive = zipSync({
        'Diagnostic-Hub-Gateway-0.5.1.tar.gz': new Uint8Array([1]),
        'Diagnostic-Hub-Gateway-0.5.1.tar.gz.sha256': new Uint8Array([2]),
    });
    const info = {
        name,
        size_in_bytes: archive.length,
        digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'),
    };
    assert.equal(Object.keys(await extractQualifiedArchive(archive, info)).length, 2);
    await assert.rejects(
        extractQualifiedArchive(archive, { ...info, digest: 'sha256:' + 'a'.repeat(64) }),
    );
    const unsafe = zipSync({ '../outside': new Uint8Array([1]) });
    await assert.rejects(
        extractQualifiedArchive(unsafe, {
            name,
            size_in_bytes: unsafe.length,
            digest: 'sha256:' + createHash('sha256').update(unsafe).digest('hex'),
        }),
        /Unexpected artifact path/,
    );
});

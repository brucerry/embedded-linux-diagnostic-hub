import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    EXISTING_RELEASE as policy,
    QUALIFIED_ARTIFACTS,
    OPERATIONAL_FILES,
    requireExistingSource,
    validateExistingQualification,
    validateKnownPublicationFailure,
    existingInventory,
    requireExistingInventory,
    createExistingReceipt,
    validateExistingFiles,
    extractQualifiedArchive,
} from './lib/existing-release-recovery.mjs';
import { validateFinalReleaseNotes } from './lib/release-notes.mjs';
import { readRecoveryBytes } from './lib/recovery-download.mjs';

// Read-only preparation: no API POST/PATCH/DELETE, no app rebuild, no Git mutation.
assert.equal(process.argv[2], 'prepare');
assert.equal(process.env.GITHUB_REPOSITORY, policy.repository);
assert.ok(process.env.GH_TOKEN, 'Use the existing scoped workflow token.');
const toolingSHA = process.env.HUB_TOOLING_SHA;
assert.match(toolingSHA, /^[a-f0-9]{40}$/);
const tooling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.cwd();
const git = (args, cwd = source) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
assert.equal(git(['rev-parse', 'HEAD']), policy.source);
assert.equal(git(['rev-parse', 'refs/tags/' + policy.tag]), policy.tagObject);
assert.equal(git(['rev-parse', 'refs/tags/' + policy.tag + '^{commit}']), policy.source);
assert.equal(
    git(['status', '--porcelain', '--untracked-files=no']),
    '',
    'Immutable source checkout must be unchanged.',
);
assert.equal(git(['rev-parse', 'HEAD'], tooling), toolingSHA);
const changes = git(['diff', '--name-only', policy.source, toolingSHA], tooling)
    .split('\n')
    .filter(Boolean);
assert.ok(
    changes.every((name) => OPERATIONAL_FILES.includes(name)),
    'Recovery tooling changed app/helper/version files.',
);
const api = 'https://api.github.com/repos/' + policy.repository;
const headers = {
    Authorization: 'Bearer ' + process.env.GH_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};
async function read(endpoint) {
    const response = await fetch(api + endpoint, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
    });
    assert.equal(
        response.status,
        200,
        'Recovery evidence GET failed: ' + endpoint + '; ' + response.status,
    );
    return response.json();
}
const privateBytes = (endpoint, expectedSize, kind) =>
    readRecoveryBytes({ api, headers, endpoint, expectedSize, kind });
const [run, jobData, artifactData, remoteRef, remoteTag] = await Promise.all([
    read('/actions/runs/' + policy.run),
    read('/actions/runs/' + policy.run + '/jobs?per_page=100'),
    read('/actions/runs/' + policy.run + '/artifacts?per_page=100'),
    read('/git/ref/tags/' + policy.tag),
    read('/git/tags/' + policy.tagObject),
]);
assert.equal(jobData.total_count, jobData.jobs.length);
assert.equal(artifactData.total_count, artifactData.artifacts.length);
requireExistingSource(policy.tag, policy.source, remoteRef, remoteTag);
const artifacts = validateExistingQualification(run, jobData.jobs, artifactData.artifacts);
validateKnownPublicationFailure(
    (
        await privateBytes('/actions/jobs/' + policy.failedJob + '/logs', undefined, 'actions')
    ).toString(),
);
const draft = await read('/releases/' + policy.draft);
const inventory = existingInventory(draft);
const files = {};
for (const artifact of QUALIFIED_ARTIFACTS) {
    const decoded = await extractQualifiedArchive(
        await privateBytes(
            '/actions/artifacts/' + artifact.id + '/zip',
            artifact.size_in_bytes,
            'actions',
        ),
        artifact,
    );
    for (const [name, bytes] of Object.entries(decoded)) {
        assert.ok(!files[name], 'Duplicate qualified file.');
        files[name] = bytes;
    }
}
for (const asset of draft.assets.filter((a) =>
    /^Diagnostic-Hub-macos-(?:x64|arm64)\.zip(?:\.sha256)?$|^macos-build-info-(?:x64|arm64)\.json$/.test(
        a.name,
    ),
)) {
    assert.equal(asset.url, api + '/releases/assets/' + asset.id);
    files[asset.name] = await privateBytes('/releases/assets/' + asset.id, asset.size, 'release');
}
const blob = (name) =>
    execFileSync('git', ['show', policy.tag + ':' + name], {
        cwd: source,
        maxBuffer: 32 * 1024 * 1024,
    });
validateExistingFiles(files, inventory, blob);
const directory = path.join(source, 'release');
await mkdir(directory, { recursive: true });
assert.equal((await readdir(directory)).length, 0, 'Recovery staging directory must be empty.');
for (const [name, bytes] of Object.entries(files))
    await writeFile(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
const env = { ...process.env, GITHUB_SHA: policy.source, GITHUB_REF_NAME: policy.tag };
execFileSync(process.execPath, ['scripts/verify-release.mjs', '--assets'], {
    cwd: source,
    env,
    stdio: 'inherit',
});
execFileSync(process.execPath, ['scripts/release-notes.mjs'], {
    cwd: source,
    env,
    stdio: 'inherit',
});
validateFinalReleaseNotes(await readFile(path.join(directory, 'notes.md'), 'utf8'), policy.tag);
requireExistingInventory(await read('/releases/' + policy.draft), inventory);
const receipt = createExistingReceipt(draft, artifacts, toolingSHA);
const output = path.join(tooling, 'validation', 'existing-recovery');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
});
await writeFile(
    path.join(output, 'preparation.json'),
    JSON.stringify(
        {
            source: policy.source,
            tag: policy.tag,
            draft: policy.draft,
            qualifiedRun: policy.run,
            toolingSHA,
            operationalOnlyChanges: changes,
            files: inventory.length,
            sourceArtifactDigestsVerified: true,
            stagedHashesVerified: true,
            sourceManifestsAndHelpersVerified: true,
            serverWrites: 0,
            appRebuilds: 0,
            tagMoves: 0,
        },
        null,
        2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
);
console.log(
    'Prepared and verified all ' +
        inventory.length +
        ' existing files; zero server writes/rebuilds/tag moves.',
);

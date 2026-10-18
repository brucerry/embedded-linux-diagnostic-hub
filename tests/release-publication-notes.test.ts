import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { releaseAssets } from '../scripts/lib/release-assets.mjs';
import {
    PLATFORM_LANES,
    consumerCases,
    hashFile,
    laneFiles,
    producerCases,
    producerFiles,
} from '../scripts/lib/staged-artifact-gate.mjs';
import {
    EXISTING_RELEASE,
    QUALIFIED_ARTIFACTS,
    SUCCESSFUL_JOBS,
    createExistingReceipt,
} from '../scripts/lib/existing-release-recovery.mjs';

const fixtureRun = { runId: '123456', runAttempt: '1' };

/** Contract-test inputs only: no native execution, measured soak or reviewed policy is claimed. */
async function syntheticStagedEvidence(root: string, version: string, sourceCommit: string) {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('hub-publication-notes-'));
    assert.ok(['0.5.0', '0.5.1'].includes(version), 'Model only the historical note fixtures.');
    const output = path.join(root, 'synthetic-staged-contract-inputs');
    const label = { syntheticPublicationUnitOnly: true, nativeExecutionPerformed: false };
    const context = {
        version,
        sourceCommit,
        sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
            cwd: root,
            encoding: 'utf8',
        }).trim(),
        ...fixtureRun,
    };
    const record = async (name: string, value: unknown) => {
        const file = path.join(output, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(value) + '\n', { flag: 'wx' });
        const { bytes, sha256 } = await hashFile(file, name);
        return { path: name, bytes, sha256 };
    };
    const runtime = (lane: (typeof PLATFORM_LANES)[number]) => ({
        platform: lane.platform,
        arch: lane.arch,
        osRelease: 'synthetic-contract-model',
        node: '24.21.0',
        executable: lane.platform === 'win32' ? 'C:\\synthetic\\node.exe' : '/synthetic/node',
        executableSHA256: createHash('sha256').update('synthetic observer').digest('hex'),
    });
    const artifacts = (names: string[]) =>
        Promise.all(names.map((name) => hashFile(path.join(root, 'release', name), name)));
    const modelCase = (
        id: string,
        evidence: Array<{ path: string; bytes: number; sha256: string }>,
    ) => ({
        id,
        status: 'passed',
        exitCode: 0,
        signal: null,
        command: ['synthetic-publication-contract-model-only', id],
        evidence,
    });
    for (const lane of PLATFORM_LANES) {
        const applications = [];
        const cases = [];
        for (const id of consumerCases(lane.id)) {
            if (id.endsWith('runtime-identity')) {
                const asset =
                    lane.platform === 'win32'
                        ? 'Diagnostic-Hub.exe'
                        : lane.platform === 'darwin'
                          ? `Diagnostic-Hub-macos-${lane.arch}.zip`
                          : id.startsWith('appimage')
                            ? 'Diagnostic-Hub-linux-x64.AppImage'
                            : 'Diagnostic-Hub-linux-x64.tar.gz';
                const app = {
                    ...label,
                    asset,
                    packaged: true,
                    version,
                    platform: lane.platform,
                    arch: lane.arch,
                    executableSHA256: createHash('sha256')
                        .update('synthetic ' + asset)
                        .digest('hex'),
                    asarSHA256: createHash('sha256').update('synthetic asar').digest('hex'),
                    versions: { electron: '44.5.1', node: '24.21.0', chrome: 'synthetic' },
                    sandbox: true,
                };
                applications.push(app);
                cases.push(modelCase(id, [await record(`${lane.id}/${id}.json`, app)]));
            } else {
                cases.push(
                    modelCase(id, [await record(`${lane.id}/${id}.json`, { ...label, id })]),
                );
            }
        }
        await record(lane.id + '.json', {
            ...label,
            schemaVersion: 1,
            kind: 'staged-native-consumer',
            status: 'passed',
            ...context,
            lane: lane.id,
            runtime: runtime(lane),
            artifacts: await artifacts(laneFiles(version, lane.id)),
            applications,
            cases,
        });
    }
    for (const scope of ['web', 'gateway']) {
        const retained = await Promise.all(
            ['policy', 'runtime', 'normal', 'forced', 'loader'].map((kind) =>
                record(`${scope}/${kind}.json`, { ...label, scope, kind }),
            ),
        );
        await record(scope + '.json', {
            ...label,
            schemaVersion: 1,
            kind: 'staged-artifact-producer',
            status: 'passed',
            ...context,
            scope,
            runtime: runtime(PLATFORM_LANES[0]),
            artifacts: await artifacts(producerFiles(version, scope)),
            cases: producerCases(scope).map((id: string) => modelCase(id, retained)),
            qualificationScope: 'full-product',
            reviewedPolicySHA256: retained[0].sha256,
            runtimeProfileSHA256: retained[1].sha256,
            // These are schema boundary values, not durations/cycles measured by this test.
            normalGC: {
                status: 'passed',
                elapsedMs: 1800000,
                completedCycles: 100,
                receiptSHA256: retained[2].sha256,
            },
            forcedGC: {
                status: 'passed',
                elapsedMs: 1800000,
                completedCycles: 100,
                receiptSHA256: retained[3].sha256,
            },
            browserVersions: { chromium: 'synthetic', firefox: 'synthetic', webkit: 'synthetic' },
            optionalNativeAddon: 'absent',
            loaderProvenanceSHA256: retained[4].sha256,
        });
    }
    return output;
}

async function fixture(version: string, existing = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-publication-notes-'));
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    await cp('scripts', path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'public'));
    for (const name of ['download-run.ps1', 'download-run.sh', 'download-run-macos.sh'])
        await cp(path.join('public', name), path.join(root, 'public', name));
    await mkdir(path.join(root, 'docs/releases'), { recursive: true });
    await mkdir(path.join(root, 'release'));
    git('init', '--initial-branch=main');
    // Copied ESM scripts must resolve the existing dependencies without copying or committing them.
    await writeFile(path.join(root, '.gitignore'), '/node_modules\n', { flag: 'wx' });
    await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction');
    assert.equal(git('check-ignore', 'node_modules'), 'node_modules');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.name', 'Fixture Author');
    git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ version, build: { mac: { minimumSystemVersion: '13.0.0' } } }),
    );
    const headings =
        version === '0.5.1'
            ? ['📋 Description:', '🔧 Changes:', '🔖 Commits:', '🔗 Links:']
            : ['Description:', 'Changes:', 'Commits:', 'Links:'];
    const highlights =
        headings[0] +
        '\nTruthful fixture description.\n\n' +
        headings[1] +
        '\n- Fixture change.\n\n' +
        headings[2] +
        '\n- Placeholder.\n\n' +
        headings[3] +
        '\n[Setup](https://example.invalid/setup)\n';
    await writeFile(path.join(root, 'docs/releases/v' + version + '.txt'), highlights);
    git('add', '.');
    git('commit', '-m', 'fix: publication fixture');
    git('tag', '-a', 'v' + version, '-m', 'Fixture release');
    const commit = git('rev-parse', 'HEAD');
    const policy = {
        ...EXISTING_RELEASE,
        source: commit,
        tagObject: git('rev-parse', 'v' + version),
    };
    let receiptFactory = createExistingReceipt;
    if (existing) {
        // The copied policy binds only this owned fixture's Git identities; production pins remain unchanged.
        const policyFile = path.join(root, 'scripts/lib/existing-release-recovery.mjs');
        const code = (await readFile(policyFile, 'utf8'))
            .replace(EXISTING_RELEASE.source, policy.source)
            .replace(EXISTING_RELEASE.tagObject, policy.tagObject);
        await writeFile(policyFile, code);
        receiptFactory = (await import(pathToFileURL(policyFile).href)).createExistingReceipt;
    }
    const assets: Array<{
        id: number;
        name: string;
        size: number;
        digest: string;
        url: string;
        browser_download_url: string;
    }> = [];
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const add = async (name: string, bytes: Buffer) => {
        await writeFile(path.join(root, 'release', name), bytes);
        assets.push({
            id: assets.length + 100,
            name,
            size: bytes.length,
            digest: 'sha256:' + digest(bytes),
            url:
                'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/releases/assets/' +
                (assets.length + 100),
            browser_download_url:
                'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/untagged-fixture/' +
                name,
        });
    };
    const payloads = new Map<string, Buffer>();
    for (const name of releaseAssets(version)) {
        const helper = ['download-run.ps1', 'download-run.sh', 'download-run-macos.sh'].includes(
            name,
        );
        const bytes = helper
            ? existing
                ? execFileSync('git', ['show', EXISTING_RELEASE.tag + ':public/' + name], {
                      cwd: root,
                  })
                : await readFile(path.join(root, 'public', name))
            : Buffer.from('Fixture bytes: ' + name);
        payloads.set(name, bytes);
        await add(name, bytes);
        await add(name + '.sha256', Buffer.from(digest(bytes) + '  ' + name + '\n'));
    }
    await add(
        'build-info.json',
        Buffer.from(JSON.stringify({ version, commit, signature: 'NotSigned' })),
    );
    await add(
        'linux-build-info.json',
        Buffer.from(
            JSON.stringify({
                version,
                commit,
                platform: 'linux',
                arch: 'x64',
                assets: Object.fromEntries(
                    ['Diagnostic-Hub-linux-x64.AppImage', 'Diagnostic-Hub-linux-x64.tar.gz'].map(
                        (name) => [name, digest(payloads.get(name)!)],
                    ),
                ),
            }),
        ),
    );
    for (const arch of ['x64', 'arm64']) {
        const asset = 'Diagnostic-Hub-macos-' + arch + '.zip';
        await add(
            'macos-build-info-' + arch + '.json',
            Buffer.from(
                JSON.stringify({
                    platform: 'darwin',
                    arch,
                    version,
                    commit,
                    asset,
                    sha256: digest(payloads.get(asset)!),
                    asarSHA256: 'a'.repeat(64),
                    bundleIdentifier: 'dev.diagnostichub.desktop',
                    minimumMacOSVersion: '13.0.0',
                    signature: 'ad-hoc',
                    adHocIntegrityVerified: true,
                    notarized: false,
                    gatekeeperDownloadedAppQualified: false,
                    source: commit,
                    distribution: true,
                    packagedSourceMatches: true,
                }),
            ),
        );
    }
    const stagedOutput = existing
        ? undefined
        : await syntheticStagedEvidence(root, version, commit);
    const draft = {
        id: existing ? EXISTING_RELEASE.draft : 77,
        tag_name: 'v' + version,
        target_commitish: commit,
        body: 'Diagnostic Hub guarded draft; source=' + commit + '; tag=v' + version,
        draft: true,
        prerelease: false,
        name: 'v' + version,
        assets,
    };
    await writeFile(path.join(root, 'draft.json'), JSON.stringify(draft));
    const toolingSHA = git('rev-parse', 'HEAD');
    const receiptPath = path.join(root, 'receipt.json');
    if (existing) {
        await writeFile(
            receiptPath,
            JSON.stringify(receiptFactory(draft, QUALIFIED_ARTIFACTS, toolingSHA)),
        );
        const success = SUCCESSFUL_JOBS.map((name, index) => ({
            id: 1000 + index,
            name,
            run_id: EXISTING_RELEASE.run,
            status: 'completed',
            conclusion: 'success',
            steps: [],
        }));
        const skipped = [
            'Audit already published release (read only)',
            'Verify audited public Mac command',
            'published-macos',
        ].map((name, index) => ({
            id: 2000 + index,
            name,
            run_id: EXISTING_RELEASE.run,
            status: 'completed',
            conclusion: 'skipped',
            steps: [],
        }));
        const failed = {
            id: EXISTING_RELEASE.failedJob,
            name: 'publish',
            run_id: EXISTING_RELEASE.run,
            status: 'completed',
            conclusion: 'failure',
            steps: [
                {
                    name: 'Publish only the complete guarded and tested draft',
                    conclusion: 'failure',
                },
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
        const jobs = [...success, ...skipped, failed];
        const artifacts = QUALIFIED_ARTIFACTS.map((a) => ({
            ...a,
            expired: false,
            workflow_run: {
                id: EXISTING_RELEASE.run,
                head_sha: policy.source,
                head_branch: EXISTING_RELEASE.tag,
            },
        }));
        await writeFile(
            path.join(root, 'qualification.json'),
            JSON.stringify({
                run: {
                    id: EXISTING_RELEASE.run,
                    run_attempt: 1,
                    head_sha: policy.source,
                    head_branch: EXISTING_RELEASE.tag,
                    path: '.github/workflows/release.yml',
                    event: 'push',
                    status: 'completed',
                    conclusion: 'failure',
                    repository: { full_name: EXISTING_RELEASE.repository, private: false },
                },
                jobs: { jobs, total_count: jobs.length },
                artifacts: { artifacts, total_count: artifacts.length },
                ref: {
                    ref: 'refs/tags/' + EXISTING_RELEASE.tag,
                    object: { type: 'tag', sha: policy.tagObject },
                },
                tag: {
                    sha: policy.tagObject,
                    tag: EXISTING_RELEASE.tag,
                    object: { type: 'commit', sha: policy.source },
                },
            }),
        );
    }
    const bootstrap = path.join(root, 'mock-http.mjs');
    await writeFile(
        bootstrap,
        [
            "import fs from 'node:fs';",
            "import cp from 'node:child_process';",
            "import {syncBuiltinESMExports} from 'node:module';",
            "const draft=JSON.parse(fs.readFileSync('draft.json','utf8')); let reads=0; const qualification=fs.existsSync('qualification.json')?JSON.parse(fs.readFileSync('qualification.json','utf8')):null;",
            "const api='https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub';",
            "const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});",
            'globalThis.fetch=async(url,options={})=>{',
            "url=String(url); const method=options.method??'GET'; const auth=options.headers?.Authorization; if(method!=='GET')fs.writeFileSync('server-write-attempt.json',JSON.stringify({method,url}));",
            "if(method==='PATCH'){ if(url!==api+'/releases/'+draft.id||!auth)throw Error('Unexpected PATCH'); const body=JSON.parse(options.body); fs.writeFileSync('publication-request.json',JSON.stringify({url,method,body})); return response({...draft,...body}); }",
            "if(method!=='GET')throw Error('Unexpected mutation: '+method);",
            "if(qualification&&url===api+'/actions/runs/38523035861')return response(qualification.run);",
            "if(qualification&&url===api+'/actions/runs/38523035861/jobs?per_page=100')return response(qualification.jobs);",
            "if(qualification&&url===api+'/actions/runs/38523035861/artifacts?per_page=100')return response(qualification.artifacts);",
            "if(qualification&&url===api+'/git/ref/tags/v0.5.1')return response(qualification.ref);",
            "if(qualification&&url===api+'/git/tags/'+qualification.tag.sha)return response(qualification.tag);",
            'if(url===api)return response({private:false});',
            "if(url.startsWith(api+'/releases?per_page=100&page='))return response(url.endsWith('page=1')?[draft]:[]);",
            "if(url===api+'/releases/410956079')return response({draft:false});",
            "if(url===api+'/releases/'+draft.id){ if(!auth)return response({},404); reads++; const current=structuredClone(draft); const bad=process.env.HUB_EXISTING_BAD; if(bad==='missing')current.assets.pop(); if(bad==='changed'||(bad==='late-change'&&reads>1))current.assets[0].id+=5000; return response(current); }",
            'if(draft.assets.some(asset=>asset.browser_download_url===url))return response({},404);',
            "throw Error('Unexpected URL; real network forbidden: '+url); };",
            'const original=cp.execFileSync;',
            String.raw`cp.execFileSync=function(command,args,options){ const result=original(command,args,options); if(command===process.execPath&&args[0]==='scripts/release-notes.mjs'&&process.env.HUB_BAD_NOTES){ let notes=fs.readFileSync('release/notes.md','utf8'); const type=process.env.HUB_BAD_NOTES; if(type==='missing')notes=notes.replace(/^(?:🔗 )?Links:\n/m,''); else if(type==='duplicate')notes+='\n'+(draft.tag_name==='v0.5.1'?'🔧 ':'')+'Changes:\n- Duplicate.\n'; else if(type==='wrong-order')notes=notes.replace(/^(?:🔧 )?Changes:/m,'TEMP-HEADING:').replace(/^(?:🔖 )?Commits:/m,draft.tag_name==='v0.5.1'?'🔧 Changes:':'Changes:').replace('TEMP-HEADING:',draft.tag_name==='v0.5.1'?'🔖 Commits:':'Commits:'); else if(type==='wrong-emoji')notes=notes.replace('🔧 Changes:','📋 Changes:'); else if(type==='hidden-space'||type==='hidden-markdown')notes=notes.replace(/\n\n(?=(?:🔧 )?Changes:)/,'\n'+(type==='hidden-space'?'Changes:   ':'## Changes:')+'\n\n'); else if(type==='bad-url')notes=notes.replace('[Setup](https://example.invalid/setup)','[Setup](https://?)'); else if(type==='legacy-new')notes=notes.replace(/(?:📋|🔧|🔖|🔗) /g,''); fs.writeFileSync('release/notes.md',notes); } return result; };`,
            'syncBuiltinESMExports();',
        ].join('\n'),
    );
    return {
        root,
        commit,
        headings,
        stagedOutput,
        run: (invalid = '', badInventory = '', stagedEnv: Record<string, string> = {}) =>
            spawnSync(
                process.execPath,
                existing
                    ? ['scripts/release-draft.mjs', 'publish-existing', receiptPath]
                    : ['scripts/release-draft.mjs', 'publish'],
                {
                    cwd: root,
                    encoding: 'utf8',
                    timeout: 30000,
                    env: {
                        ...process.env,
                        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
                        GITHUB_REF_NAME: 'v' + version,
                        GITHUB_SHA: commit,
                        GITHUB_RUN_ID: fixtureRun.runId,
                        GITHUB_RUN_ATTEMPT: fixtureRun.runAttempt,
                        HUB_PLATFORM_EVIDENCE: stagedOutput,
                        GH_TOKEN: 'fixture-token',
                        HUB_BAD_NOTES: invalid,
                        HUB_EXISTING_BAD: badInventory,
                        HUB_TOOLING_SHA: toolingSHA,
                        NODE_OPTIONS: '--import=' + JSON.stringify(pathToFileURL(bootstrap).href),
                        ...stagedEnv,
                    },
                },
            ),
        close: async () => {
            if (
                !path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) ||
                !path.basename(root).startsWith('hub-publication-notes-')
            )
                throw Error('Invalid fixture cleanup');
            await rm(root, { recursive: true, force: true });
        },
    };
}
for (const version of ['0.5.0', '0.5.1']) {
    test(
        'actual publication CLI accepts the generated final note contract for ' + version,
        async () => {
            const f = await fixture(version);
            try {
                const result = f.run();
                assert.equal(result.status, 0, result.stderr);
                assert.match(result.stdout, /All four native staged-consumer receipts bind/);
                const request = JSON.parse(
                    await readFile(path.join(f.root, 'publication-request.json'), 'utf8'),
                );
                assert.equal(request.method, 'PATCH');
                assert.equal(request.body.draft, false);
                assert.equal(request.body.make_latest, 'true');
                const notes = await readFile(path.join(f.root, 'release/notes.md'), 'utf8');
                assert.equal(request.body.body, notes);
                assert.deepEqual(
                    notes.match(/^(?:(?:📋|🔧|🔖|🔗) )?(Description|Changes|Commits|Links):$/gm),
                    f.headings,
                );
                assert.ok(notes.includes('/commit/' + f.commit));
                assert.match(result.stdout, /Release version verified/);
                assert.match(result.stdout, /All four native staged-consumer receipts bind/);
            } finally {
                await f.close();
            }
        },
    );
}
test('actual publication CLI keeps staged evidence mandatory before any server write', async () => {
    const f = await fixture('0.5.1');
    try {
        assert.ok(f.stagedOutput);
        const refuses = async (name: string, env: Record<string, string> = {}) => {
            const result = f.run('', '', env);
            assert.equal(result.error, undefined, name);
            assert.equal(result.signal, null, name);
            assert.notEqual(result.status, 0, name);
            assert.match(result.stderr, /AssertionError|ENOENT/, name);
            for (const file of ['server-write-attempt.json', 'publication-request.json'])
                await assert.rejects(() => readFile(path.join(f.root, file)), { code: 'ENOENT' });
        };
        await refuses('run identity missing', { GITHUB_RUN_ID: '' });
        await refuses('receipt belongs to a different run', { GITHUB_RUN_ID: '999999' });
        for (const name of ['win32-x64.json', 'gateway.json']) {
            const file = path.join(f.stagedOutput, name);
            const original = await readFile(file);
            try {
                await rm(file);
                await refuses('required receipt missing: ' + name);
            } finally {
                await writeFile(file, original, { flag: 'wx' });
            }
        }
        for (const file of [
            path.join(f.stagedOutput, 'win32-x64/portable-desktop.json'),
            path.join(f.root, 'release/Diagnostic-Hub.exe'),
        ]) {
            const original = await readFile(file);
            try {
                await writeFile(file, Buffer.concat([original, Buffer.from('tampered')]));
                await refuses('retained bytes changed: ' + path.basename(file));
            } finally {
                await writeFile(file, original);
            }
        }
    } finally {
        await f.close();
    }
});

test('actual publication CLI rejects malformed final notes before PATCH for old and new formats', async () => {
    for (const version of ['0.5.0', '0.5.1']) {
        const invalids =
            version === '0.5.1'
                ? [
                      'missing',
                      'duplicate',
                      'wrong-order',
                      'wrong-emoji',
                      'legacy-new',
                      'hidden-space',
                      'hidden-markdown',
                      'bad-url',
                  ]
                : [
                      'missing',
                      'duplicate',
                      'wrong-order',
                      'hidden-space',
                      'hidden-markdown',
                      'bad-url',
                  ];
        const f = await fixture(version);
        try {
            for (const invalid of invalids) {
                const result = f.run(invalid);
                assert.notEqual(result.status, 0, version + ' ' + invalid + ' must reject');
                assert.match(result.stdout, /Release version verified/);
                assert.match(result.stderr, /Final release (?:note|link)|Release links/);
                await assert.rejects(
                    () => readFile(path.join(f.root, 'publication-request.json'), 'utf8'),
                    { code: 'ENOENT' },
                );
            }
        } finally {
            await f.close();
        }
    }
});

test('existing-only CLI publishes the complete pinned inventory without asset writes', async () => {
    const f = await fixture('0.5.1', true);
    try {
        const before = execFileSync('git', ['rev-parse', 'v0.5.1'], {
            cwd: f.root,
            encoding: 'utf8',
        });
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        const request = JSON.parse(
            await readFile(path.join(f.root, 'server-write-attempt.json'), 'utf8'),
        );
        assert.equal(request.method, 'PATCH');
        const after = execFileSync('git', ['rev-parse', 'v0.5.1'], {
            cwd: f.root,
            encoding: 'utf8',
        });
        assert.equal(after, before);
        const published = JSON.parse(
            await readFile(path.join(f.root, 'publication-request.json'), 'utf8'),
        );
        assert.equal(published.body.draft, false);
        assert.ok(published.body.body.startsWith('📋 Description:\n'));
    } finally {
        await f.close();
    }
});
test('existing-only CLI refuses missing, changed and late-changed inventory with zero server writes', async () => {
    const f = await fixture('0.5.1', true);
    try {
        for (const bad of ['missing', 'changed', 'late-change']) {
            const result = f.run('', bad);
            assert.notEqual(result.status, 0, bad);
            assert.match(result.stderr, /existing assets|inventory changed/i);
            await assert.rejects(
                () => readFile(path.join(f.root, 'server-write-attempt.json'), 'utf8'),
                { code: 'ENOENT' },
            );
            await assert.rejects(
                () => readFile(path.join(f.root, 'publication-request.json'), 'utf8'),
                { code: 'ENOENT' },
            );
        }
    } finally {
        await f.close();
    }
});

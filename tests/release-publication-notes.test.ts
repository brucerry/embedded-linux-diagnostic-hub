import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { releaseAssets } from '../scripts/lib/release-assets.mjs';
import {
    EXISTING_RELEASE,
    QUALIFIED_ARTIFACTS,
    SUCCESSFUL_JOBS,
    createExistingReceipt,
} from '../scripts/lib/existing-release-recovery.mjs';

async function fixture(version: string, existing = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-publication-notes-'));
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    if (existing) {
        execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', process.cwd(), root]);
        git('checkout', '--quiet', '--detach', EXISTING_RELEASE.tag);
    } else await cp('scripts', path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'docs/releases'), { recursive: true });
    await mkdir(path.join(root, 'release'));
    if (!existing) git('init', '--initial-branch=main');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.name', 'Fixture Author');
    git('config', 'user.email', 'fixture@example.invalid');
    if (!existing)
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
    if (!existing) {
        await writeFile(path.join(root, 'docs/releases/v' + version + '.txt'), highlights);
        git('add', '.');
        git('commit', '-m', 'fix: publication fixture');
        git('tag', 'v' + version);
    }
    const commit = git('rev-parse', 'HEAD');
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
        const bytes =
            existing &&
            ['download-run.ps1', 'download-run.sh', 'download-run-macos.sh'].includes(name)
                ? execFileSync('git', ['show', EXISTING_RELEASE.tag + ':public/' + name], {
                      cwd: root,
                  })
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
    const toolingSHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const receiptPath = path.join(root, 'receipt.json');
    if (existing) {
        await writeFile(
            receiptPath,
            JSON.stringify(createExistingReceipt(draft, QUALIFIED_ARTIFACTS, toolingSHA)),
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
                head_sha: EXISTING_RELEASE.source,
                head_branch: EXISTING_RELEASE.tag,
            },
        }));
        await writeFile(
            path.join(root, 'qualification.json'),
            JSON.stringify({
                run: {
                    id: EXISTING_RELEASE.run,
                    run_attempt: 1,
                    head_sha: EXISTING_RELEASE.source,
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
                    object: { type: 'tag', sha: EXISTING_RELEASE.tagObject },
                },
                tag: {
                    sha: EXISTING_RELEASE.tagObject,
                    tag: EXISTING_RELEASE.tag,
                    object: { type: 'commit', sha: EXISTING_RELEASE.source },
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
        run: (invalid = '', badInventory = '') =>
            spawnSync(
                process.execPath,
                existing
                    ? [path.resolve('scripts/release-draft.mjs'), 'publish-existing', receiptPath]
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
                        GH_TOKEN: 'fixture-token',
                        HUB_BAD_NOTES: invalid,
                        HUB_EXISTING_BAD: badInventory,
                        HUB_TOOLING_SHA: toolingSHA,
                        NODE_OPTIONS: '--import=' + JSON.stringify(pathToFileURL(bootstrap).href),
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
            } finally {
                await f.close();
            }
        },
    );
}
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

/** Derived qualification artifact only. No install, package-tree copy or dependency mutation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
export function optionalSshAccelerators() {
    return {
        name: 'qualification-js-only-ssh',
        setup(build) {
            build.onResolve({ filter: /(?:\.node$|^cpu-features$)/ }, (args) => ({
                path: args.path,
                namespace: 'excluded-ssh-accelerator',
            }));
            build.onLoad({ filter: /.*/, namespace: 'excluded-ssh-accelerator' }, () => ({
                contents:
                    'const error = new Error("Optional SSH accelerator excluded by qualification profile"); error.code="MODULE_NOT_FOUND"; throw error;',
                loader: 'js',
            }));
        },
    };
}
const preload = `
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url'),{registerHooks}=require('node:module');
if(typeof registerHooks!=='function')throw Error('Synchronous Node module hooks are required.');
if(/(?:^|\\s)(?:--(?:require|import|loader|experimental-loader)(?:=|\\s)|-r)/.test(process.env.NODE_OPTIONS||''))throw Error('Unreviewed NODE_OPTIONS preload/loader is unsupported by this qualification profile.');
const manifestPath=path.join(__dirname,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const {id,...core}=manifest;if(crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex')!==id)throw Error('Qualification manifest identity changed.');if(JSON.stringify(Object.keys(manifest.files).sort())!==JSON.stringify(['preload.cjs','ssh2.cjs']))throw Error('Incomplete qualification files.');
if(manifest.schema!==1||manifest.kind!=='ssh2-js-bundle')throw Error('Unexpected qualification profile.');
for(const [name,hash] of Object.entries(manifest.files)){if(!['ssh2.cjs','preload.cjs'].includes(name))throw Error('Invalid profile file.');const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex');if(actual!==hash)throw Error('Qualification artifact changed: '+name);}
if(process.env.HUB_MEMORY_SSH_PROFILE&&path.resolve(process.env.HUB_MEMORY_SSH_PROFILE)!==manifestPath)throw Error('Conflicting qualification profile.');
process.env.HUB_MEMORY_SSH_PROFILE=manifestPath;
registerHooks({resolve(specifier,context,nextResolve){if(specifier==='ssh2')return{url:pathToFileURL(path.join(__dirname,'ssh2.cjs')).href,shortCircuit:true};if(specifier.startsWith('ssh2/'))throw Error('SSH qualification uses the main bundled entry only.');return nextResolve(specifier,context);}});
`;
export async function prepareMemoryRuntime(root = process.cwd()) {
    assert.match(
        process.versions.node,
        /^24\./,
        'This qualification profile is reviewed for Node 24 only.',
    );
    assert.ok(
        !process.env.ESBUILD_BINARY_PATH,
        'An overridden bundler executable requires a separately reviewed profile.',
    );
    root = path.resolve(root);
    const lockBytes = await fs.readFile(path.join(root, 'package-lock.json')),
        lock = JSON.parse(lockBytes);
    const esbuild = require('esbuild');
    assert.equal(
        esbuild.version,
        lock.packages['node_modules/esbuild'].version,
        'Installed bundler differs from the source lock.',
    );
    const packageNames = [
        'ssh2',
        'asn1',
        'safer-buffer',
        'bcrypt-pbkdf',
        'tweetnacl',
        'tsx',
        'esbuild',
    ];
    const packages = [];
    for (const name of packageNames) {
        const manifestPath = require.resolve(name + '/package.json'),
            bytes = await fs.readFile(manifestPath),
            installed = JSON.parse(bytes);
        assert.equal(
            installed.version,
            lock.packages['node_modules/' + name].version,
            'Installed SSH JS dependency differs from lock: ' + name,
        );
        packages.push({
            name,
            version: installed.version,
            manifestPath,
            manifestSHA256: digest(bytes),
        });
    }
    const loaderInputs = [];
    for (const tool of packages.filter((item) => ['tsx', 'esbuild'].includes(item.name))) {
        const base = path.dirname(tool.manifestPath);
        const visit = async (directory) => {
            for (const item of await fs.readdir(directory, { withFileTypes: true })) {
                if (item.name === 'node_modules') continue;
                assert.ok(!item.isSymbolicLink(), 'Qualification tooling refuses aliases.');
                const file = path.join(directory, item.name);
                if (item.isDirectory()) await visit(file);
                else if (/\.(?:[cm]?js|json)$/.test(item.name))
                    loaderInputs.push({ path: file, sha256: digest(await fs.readFile(file)) });
            }
        };
        await visit(base);
    }
    loaderInputs.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const sshRoot = path.dirname(packages[0].manifestPath),
        entry = path.join(sshRoot, 'lib/index.js'),
        cryptoEntry = path.join(sshRoot, 'lib/protocol/crypto.js');
    const result = await esbuild.build({
        stdin: {
            contents: `const ssh=require(${JSON.stringify(entry)}); const crypto=require(${JSON.stringify(cryptoEntry)}); Object.defineProperty(ssh,'__memoryQualification',{value:Object.freeze({bindingAvailable:crypto.bindingAvailable,cipherNames:Object.keys(crypto.CIPHER_INFO).sort(),macNames:Object.keys(crypto.MAC_INFO).sort()})}); module.exports=ssh;`,
            resolveDir: root,
            sourcefile: 'memory-ssh-profile-entry.cjs',
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        write: false,
        metafile: true,
        legalComments: 'none',
        absWorkingDir: root,
        nodePaths: (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean),
        plugins: [optionalSshAccelerators()],
    });
    assert.equal(result.outputFiles.length, 1);
    const externalImports = [
        ...new Set(
            Object.values(result.metafile.outputs).flatMap((output) =>
                output.imports.filter((item) => item.external).map((item) => item.path),
            ),
        ),
    ].sort();
    assert.ok(
        externalImports.every(isBuiltin),
        'Qualification bundle has an external package/native import.',
    );
    const inputs = [];
    for (const name of Object.keys(result.metafile.inputs).sort()) {
        if (
            name.startsWith('excluded-ssh-accelerator:') ||
            name === 'memory-ssh-profile-entry.cjs'
        ) {
            inputs.push({ path: name, virtual: true });
            continue;
        }
        const absolute = path.resolve(root, name);
        assert.ok(!absolute.endsWith('.node'));
        inputs.push({ path: absolute, sha256: digest(await fs.readFile(absolute)) });
    }
    const bundle = result.outputFiles[0].contents;
    const files = { 'ssh2.cjs': digest(bundle), 'preload.cjs': digest(preload) };
    const core = {
        schema: 1,
        kind: 'ssh2-js-bundle',
        files,
        lockSHA256: digest(lockBytes),
        esbuild: esbuild.version,
        packages,
        inputs,
        loaderInputs,
        externalImports,
        excludedAccelerators: ['cpu-features', 'sshcrypto.node'],
    };
    const id = digest(JSON.stringify(core));
    const profileRoot = path.resolve(root, 'validation/memory-runtime', id);
    assert.ok(profileRoot.startsWith(path.resolve(root, 'validation/memory-runtime') + path.sep));
    let existing = false;
    try {
        await fs.mkdir(profileRoot, { recursive: false });
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(path.dirname(profileRoot), { recursive: true });
            await fs.mkdir(profileRoot);
        } else if (error.code === 'EEXIST') existing = true;
        else throw error;
    }
    const manifest = { ...core, id };
    if (existing) {
        assert.deepEqual(
            JSON.parse(await fs.readFile(path.join(profileRoot, 'manifest.json'), 'utf8')),
            manifest,
            'Existing qualification profile is incomplete or changed.',
        );
        for (const [name, expected] of Object.entries(files))
            assert.equal(digest(await fs.readFile(path.join(profileRoot, name))), expected);
    } else {
        await fs.writeFile(path.join(profileRoot, 'ssh2.cjs'), bundle, { flag: 'wx' });
        await fs.writeFile(path.join(profileRoot, 'preload.cjs'), preload, { flag: 'wx' });
        await fs.writeFile(
            path.join(profileRoot, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            { flag: 'wx' },
        );
    }
    return {
        manifestPath: path.join(profileRoot, 'manifest.json'),
        preloadPath: path.join(profileRoot, 'preload.cjs'),
        bundlePath: path.join(profileRoot, 'ssh2.cjs'),
        id,
    };
}
async function main() {
    const argument = process.argv.find((value) => value.startsWith('--entry='));
    const mode = argument?.slice(8);
    const entries = {
        fast: 'memory-resource-regression.ts',
        calibrate: 'memory-resource-calibrate.ts',
        negative: 'memory-resource-negative.ts',
        soak: 'memory-resource-soak.ts',
        'gateway-smoke': 'memory-resource-gateway-smoke.ts',
        self: 'memory-resource-adoption.test.ts',
        identity: 'memory-resource-invocation.ts',
        policy: 'memory-resource-invocation.ts',
    };
    assert.ok(
        mode && Object.hasOwn(entries, mode),
        'Use --entry=fast|calibrate|negative|soak|gateway-smoke|self|identity|policy.',
    );
    const profile = await prepareMemoryRuntime();
    const forwarded = process.argv.slice(2).filter((value) => value !== argument);
    if (forwarded.includes('--build-only=1')) {
        console.log(JSON.stringify(profile));
        return;
    }
    const metadata = mode === 'identity' || mode === 'policy';
    const soakMetadata =
        metadata &&
        (forwarded.includes('--identity-for=soak') || forwarded.includes('--policy-kind=soak'));
    const args = [
        '--require',
        profile.preloadPath,
        ...(mode === 'soak' || soakMetadata ? [] : ['--expose-gc']),
        '--import',
        require.resolve('tsx'),
        ...(mode === 'self' ? ['--test', '--test-concurrency=1'] : []),
        path.resolve('tests/fixtures', entries[mode]),
        ...(mode === 'fast' ? ['--profile=fast'] : []),
        ...forwarded,
        ...(metadata ? ['--operation=' + mode] : []),
    ];
    // --import requires a file URL on Windows.
    args[args.indexOf('--import') + 1] = (await import('node:url')).pathToFileURL(
        args[args.indexOf('--import') + 1],
    ).href;
    const child = spawn(process.execPath, args, {
        windowsHide: true,
        stdio: 'inherit',
        env: { ...process.env, HUB_MEMORY_SSH_PROFILE: profile.manifestPath },
    });
    const outcome = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (outcome.signal !== null || outcome.code !== 0) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

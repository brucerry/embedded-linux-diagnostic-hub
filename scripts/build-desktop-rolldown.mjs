import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { selectReviewedBinding } from './lib/desktop-compiler-binding.mjs';

// Compile only. Electron and the SSH runtime remain exogenous to this step.
const [mode, ...rest] = process.argv.slice(2);
assert.ok(rest.length === 0 && (mode === undefined || mode === '--gateway-review'),
    'Expected desktop mode or explicit Gateway compiler review.');
const gatewayReview = mode === '--gateway-review';
const cases = gatewayReview ? [['gateway/main.ts', 'main', ['ssh2']]] : [
    ['electron/main.ts', 'main', ['electron', 'ssh2']],
    ['electron/preload.ts', 'preload', ['electron']],
    ['scripts/linux-setup-review.cts', 'linux-setup-review', ['electron', 'ssh2']],
    ['scripts/linux-setup-install.cts', 'linux-setup-install', ['electron', 'ssh2']],
    ['scripts/linux-setup-bootstrap.cts', 'linux-setup-bootstrap', ['electron', 'ssh2', 'original-fs']],
];
const root = await realpath(process.cwd());
const json = async (p) => JSON.parse(await readFile(path.join(root,p),'utf8'));
const lock = await json('package-lock.json');
const wrapper = await json('node_modules/rolldown/package.json');
const selected = selectReviewedBinding({
    platform: process.platform,
    arch: process.arch,
    glibcVersion: process.platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime : undefined,
    env: process.env,
}, lock, wrapper);
const binding = path.join(root, 'node_modules', selected.name, selected.filename);
assert.ok((await lstat(binding)).isFile());
assert.equal(await realpath(binding), binding, 'Compiler binary must be local to the selected tree.');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const gatewayBefore = gatewayReview ? {
    lockSHA256: sha256(await readFile(path.join(root, 'package-lock.json'))),
    entrySHA256: sha256(await readFile(path.join(root, 'gateway', 'main.ts'))),
    bindingSHA256: sha256(await readFile(binding)),
} : undefined;
const { rolldown } = await import('rolldown');
const temporary = await mkdtemp(path.join(root, '.desktop-rolldown-'));
const dest = path.join(root, gatewayReview ? '.gateway-rolldown-review' : 'dist-electron');
try {
    for (const [input, name, external] of cases) {
        const warnings = [];
        const bundle = await rolldown({ input, external, platform: 'node', onwarn: (w) => warnings.push(w.message) });
        try {
            const { output } = await bundle.write({ file: path.join(temporary, name + '.cjs'),
                format: 'cjs', codeSplitting: false });
            assert.equal(output.length, 1);
            assert.equal(output[0].type, 'chunk');
            const filename = name + '.cjs';
            const direct = [...output[0].code.matchAll(/(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)];
            assert.ok(!direct.some((m) => [filename, './' + filename].includes(m[1])),
                'Compiler output directly imports itself.');
            const runtimeImports = [...output[0].imports, ...output[0].dynamicImports]
                .filter((entry) => entry !== filename);
            if (name === 'preload') {
                // The production renderer is sandboxed. Require review before expanding
                // this intentionally narrower list than Electron's sandbox API.
                for (const entry of [...runtimeImports, ...direct.map((match) => match[1])])
                    assert.ok(external.includes(entry), 'Unsupported sandboxed preload import: ' + entry);
            } else {
                for (const entry of runtimeImports)
                    assert.ok(isBuiltin(entry) || external.includes(entry),
                        'Unexpected external: ' + entry);
            }
            if (gatewayReview) {
                assert.ok(runtimeImports.includes('ssh2'), 'Gateway must retain the approved runtime boundary.');
                assert.ok(runtimeImports.every((id) => !id.startsWith('ssh2/')));
                assert.ok(output[0].moduleIds.every((id) => !/[\\/]node_modules[\\/]ssh2(?:[\\/]|$)/.test(id)),
                    'SSH runtime must never be inlined.');
            }
            if (gatewayReview) {
                const record = {
                    schemaVersion: 1,
                    kind: 'isolated-gateway-compiler-readback',
                    sourceEntry: input,
                    compiler: { wrapper: wrapper.version, binding: selected.name, node: process.versions.node },
                    ...gatewayBefore,
                    bundleSHA256: sha256(await readFile(path.join(temporary, filename))),
                    imports: [...new Set(runtimeImports)].sort(),
                    runtimeExecuted: false,
                    releaseAdmission: false,
                };
                assert.equal(sha256(await readFile(path.join(root, 'package-lock.json'))), record.lockSHA256);
                assert.equal(sha256(await readFile(path.join(root, input))), record.entrySHA256);
                assert.equal(sha256(await readFile(binding)), record.bindingSHA256);
                await writeFile(path.join(temporary, 'compiler-readback.json'),
                    JSON.stringify(record, null, 2) + '\n', {flag: 'wx'});
            }
            assert.deepEqual(warnings, [], 'Unexpected compiler warnings.');
        } finally {
            await bundle.close();
        }
    }
    await mkdir(dest, {recursive:true});
    for (const [,name] of cases) await rename(path.join(temporary,name+'.cjs'),path.join(dest,name+'.cjs'));
    if (gatewayReview)
        await rename(path.join(temporary, 'compiler-readback.json'), path.join(dest, 'compiler-readback.json'));
} finally {
    await rm(temporary, {recursive:true,force:true});
}

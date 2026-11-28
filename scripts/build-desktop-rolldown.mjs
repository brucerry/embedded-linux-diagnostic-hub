import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { selectReviewedBinding } from './lib/desktop-compiler-binding.mjs';

// Compile only. Electron and the SSH runtime remain exogenous to this step.
const cases = [
    ['electron/main.ts', 'main', ['electron', 'ssh2']],
    ['electron/preload.ts', 'preload', ['electron', 'ssh2']],
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
const { rolldown } = await import('rolldown');
const temporary = await mkdtemp(path.join(root, '.desktop-rolldown-'));
const dest = path.join(root, 'dist-electron');
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
            for (const entry of [...output[0].imports, ...output[0].dynamicImports])
                assert.ok(entry === filename || isBuiltin(entry) || external.includes(entry),
                    'Unexpected external: ' + entry);
            assert.deepEqual(warnings, [], 'Unexpected compiler warnings.');
        } finally {
            await bundle.close();
        }
    }
    await mkdir(dest, {recursive:true});
    for (const [,name] of cases) await rename(path.join(temporary,name+'.cjs'),path.join(dest,name+'.cjs'));
} finally {
    await rm(temporary, {recursive:true,force:true});
}

import { readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [tool, rev] = process.argv.slice(2);
const meta = JSON.parse(await readFile(join(tool, 'package.json'), 'utf8'));
assert.equal(meta.name, 'rolldown');
assert.equal(meta.version, '1.2.12');
const exp = meta.exports['.'];
const { rolldown } = await import(pathToFileURL(join(tool, typeof exp === 'string' ? exp : exp.import ?? exp.default)).href);
const root = await realpath('.');
const depPaths = Object.keys(JSON.parse(await readFile(new URL('./compile-deps.json', import.meta.url), 'utf8')));
const sha = data => createHash('sha256').update(data).digest('hex');
const cases = [
  ['electron/main.ts', 'main', ['electron', 'ssh2']],
  ['electron/preload.ts', 'preload', ['electron', 'ssh2']],
  ['scripts/linux-setup-review.cts', 'linux-setup-review', ['electron', 'ssh2']],
  ['scripts/linux-setup-install.cts', 'linux-setup-install', ['electron', 'ssh2']],
  ['scripts/linux-setup-bootstrap.cts', 'linux-setup-bootstrap', ['electron', 'ssh2', 'original-fs']],
  ['gateway/main.ts', 'gateway', ['ssh2']],
];
const outputs = [];
for (const [input, name, external] of cases) {
  const warnings = [];
  const bundle = await rolldown({input, external, platform: 'node', onwarn: w => warnings.push(w.message)});
  let output;
  try {
    const result = await bundle.write({file: 'out/' + name + '.cjs', format: 'cjs', codeSplitting: false});
    assert.equal(result.output.length, 1, 'unexpected assets or extra chunks');
    output = result.output[0];
    assert.equal(output.type, 'chunk');
  } finally {
    await bundle.close();
  }
  assert.deepEqual(warnings, []);
  const externals = [...new Set([...output.imports, ...output.dynamicImports])].filter(id => id !== name + '.cjs').sort();
  const directImports = [...output.code.matchAll(/(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)];
  assert.ok(!directImports.some(m => [name + '.cjs', './' + name + '.cjs'].includes(m[1])),
            'emitted entry directly imports itself');
  for (const specifier of externals) {
    assert.ok(isBuiltin(specifier) || external.includes(specifier), 'unexpected external: ' + specifier);
  }
  const modules = [];
  for (const id of Object.keys(output.modules).sort()) {
    if (id.startsWith('\0')) continue;
    const file = await realpath(isAbsolute(id) ? id : resolve(id));
    const rel = relative(root, file);
    assert.ok(rel && !rel.startsWith('..') && (!rel.split('/').includes('node_modules') || depPaths.some(prefix => rel.startsWith('node_modules/' + prefix + '/'))), id);
    modules.push([rel, sha(await readFile(file))]);
  }
  assert.ok(modules.some(([file]) => file === input), 'entry absent from compile graph');
  const file = 'out/' + name + '.cjs';
  const bytes = await readFile(file);
  const syntax = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  assert.equal(syntax.status, 0, syntax.stderr ?? String(syntax.error));
  outputs.push({ input, name, bytes: bytes.length, sha256: sha(bytes), externals, modules });
}
await writeFile('out/evidence/report.json', JSON.stringify({
  classification: 'compile_only_no_runtime', shippingApproval: false, source: rev, compiler: meta.version, outputs,
}, null, 2) + '\n');

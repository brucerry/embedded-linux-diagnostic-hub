import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { Script } from 'node:vm';
import { parseSync } from 'vite';
import { rolldown, VERSION } from 'rolldown';
const pin=JSON.parse(await readFile('package-lock.json','utf8')).packages['node_modules/rolldown'].version;
assert.equal(VERSION,pin);
const cases=[
 ['main','electron/main.ts',['electron','ssh2']],
 ['preload','electron/preload.ts',['electron','ssh2']],
 ['linux-setup-review','scripts/linux-setup-review.cts',['electron','ssh2']],
 ['linux-setup-install','scripts/linux-setup-install.cts',['electron','ssh2']],
 ['linux-setup-bootstrap','scripts/linux-setup-bootstrap.cts',['electron','ssh2','original-fs']],
 ['gateway','gateway/main.ts',['ssh2'],'main.cjs'],
];
for (const [name, entry, external, filename=name+'.cjs'] of cases) {
 test(name + ' emits one standalone CJS file with only the approved imports', async () => {
 let build;
 try {
 build=await rolldown({input:resolve(entry),platform:'node',external,onLog(level,info,handler){if(info.code==='UNRESOLVED_IMPORT')throw new Error(info.message);handler(level,info)}});
 const {output}=await build.generate({format:'cjs',entryFileNames:filename,codeSplitting:false});
 assert.equal(output.length,1);
 const [chunk]=output;
 assert.equal(chunk.type,'chunk');
 assert.equal(chunk.fileName,filename);
 assert.ok(chunk.code.length>100);
 new Script(chunk.code,{filename:chunk.fileName});
 assert.ok(chunk.dynamicImports.every(x=>x===chunk.fileName));
 assert.ok(chunk.imports.every(x=>isBuiltin(x)||external.includes(x)),JSON.stringify(chunk.imports));
 const parsed=parseSync(chunk.fileName,chunk.code);
 assert.equal(parsed.errors.length,0);
 assert.deepEqual(parsed.module.dynamicImports,[]);
 console.log(name,Buffer.byteLength(chunk.code), 'bytes; standalone CJS');
 } finally { await build?.close(); }
 });
}

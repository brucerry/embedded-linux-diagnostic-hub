'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=__dirname;
const compiler=path.join(root,'compiler/typescript.js');
assert.equal(createHash('sha256').update(fs.readFileSync(compiler)).digest('hex'),
    '795e49e46d497cc16e4b02916b50cbca257b4256d62cddc4cc504103f7961027');
const ts=require(compiler);
assert.equal(ts.version,'5.8.2');
for(const name of ['archive','ArchiveTarget']){
    const fileName=name+'.ts';
    const before=fs.readFileSync(path.join(root,'emit/before',name+'.js'),'utf8');
    const map=JSON.parse(fs.readFileSync(path.join(root,'emit/before',name+'.js.map'),'utf8'));
    function transpile(which) {
        const original=fs.readFileSync(path.join(root,'source',which,fileName),'utf8');
        const result=ts.transpileModule(original,{fileName,reportDiagnostics:true,compilerOptions:{
            target:ts.ScriptTarget.ES2019,module:ts.ModuleKind.CommonJS,esModuleInterop:false,
            allowSyntheticDefaultImports:true,experimentalDecorators:true,sourceMap:true,inlineSources:true,
            newLine:ts.NewLineKind.LineFeed,strict:true}});
        assert.deepEqual(result.diagnostics,[]);
        const derived=JSON.parse(result.sourceMapText);
        derived.sources=map.sources;
        return {js:result.outputText,map:JSON.stringify(derived)};
    }
    const baseline=transpile('before');
    assert.equal(baseline.js,before,name+' baseline JS');
    assert.equal(baseline.map,JSON.stringify(map),name+' baseline source map');
    const output=transpile('after');
    fs.writeFileSync(path.join(root,'emit/after',name+'.js'),output.js);
    fs.writeFileSync(path.join(root,'emit/after',name+'.js.map'),output.map);
    assert.notEqual(output.js,before);
}
console.log('Exact baseline JS+map parity for both files; emitted the changed TypeScript slice with TS 5.8.2.');

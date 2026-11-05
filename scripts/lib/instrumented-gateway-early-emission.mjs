import assert from 'node:assert/strict';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import ts from 'typescript';
import {observeSourceBridge,sourceDigest} from './committed-source-bridge.mjs';
import {assertInstrumentedProductionBridge} from './instrumented-gateway-source.mjs';
import {requireObservedClosure} from './owned-child.mjs';

export const EARLY_ENTRY='tests/fixtures/instrumented-gateway-preimport-entry.mjs';
const NATIVE='tests/fixtures/instrumented-gateway-preimport-native.mjs';
const MAX=32*1024**2;
const builtins=new Set(['assert/strict','path','util','crypto','url','module','inspector','fs/promises','perf_hooks','http','child_process','fs']);
const builtin=s=>typeof s==='string'&&s.startsWith('node:')&&builtins.has(s.slice(5));
function ast(file,bytes,json=false){
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=(json?4*1024**2:MAX));
    const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);assert.ok(Buffer.from(source).equals(bytes));
    const tree=json?ts.parseJsonText(file,source):ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    assert.equal(tree.parseDiagnostics.length,0);return tree;
}
function walk(node,visit){visit(node);ts.forEachChild(node,child=>{walk(child,visit);});}
function metadata(bytes){
    const tree=ast('metafile.json',bytes,true);
    walk(tree,node=>{if(ts.isObjectLiteralExpression(node)){const keys=new Set();for(const row of node.properties){assert.ok(ts.isPropertyAssignment(row)&&ts.isStringLiteral(row.name));assert.ok(!keys.has(row.name.text));keys.add(row.name.text);}}});
    return JSON.parse(bytes.toString('utf8'));
}
const relative=p=>assert.ok(typeof p==='string'&&!p.startsWith('/')&&path.posix.normalize(p)===p&&!p.split('/').includes('..')&&!/[\\\x00-\x20\x7f]/.test(p));
/** Checks the actual emitted JS in addition to the compiler's import/output census. Trust in
 * the pinned compiler's source-to-output transformation remains explicit, not service proof. */
export function inspectEarlyArtifact(bytes){
    const tree=ast('preimport.mjs',bytes),imports=[],exports=[],functions=new Set(),createRequireNames=new Set(),requireNames=new Set();let dynamicTargets=0,sessions=0,registries=0;
    for(const statement of tree.statements){
        if(ts.isFunctionDeclaration(statement)&&statement.name){assert.ok(!statement.modifiers?.some(row=>row.kind===ts.SyntaxKind.DefaultKeyword));functions.add(statement.name.text);if(statement.modifiers?.some(row=>row.kind===ts.SyntaxKind.ExportKeyword))exports.push(statement.name.text);}
        if(ts.isExportDeclaration(statement)){assert.ok(!statement.moduleSpecifier&&statement.exportClause&&ts.isNamedExports(statement.exportClause));for(const row of statement.exportClause.elements){assert.equal(row.name.text,'runPreimportCompatibilityFromFile');assert.equal((row.propertyName??row.name).text,'runPreimportCompatibilityFromFile');exports.push(row.name.text);}}
        if(ts.isImportDeclaration(statement)){assert.ok(ts.isStringLiteral(statement.moduleSpecifier)&&builtin(statement.moduleSpecifier.text));imports.push(statement.moduleSpecifier.text);
            if(statement.moduleSpecifier.text==='node:module')for(const row of statement.importClause?.namedBindings?.elements??[])if((row.propertyName?.text??row.name.text)==='createRequire')createRequireNames.add(row.name.text);
        }
    }
    walk(tree,node=>{
        if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)){
            if(node.name.text==='sourceObservers'){assert.ok(node.initializer&&ts.isNewExpression(node.initializer)&&node.initializer.expression.getText(tree)==='WeakMap');registries++;}
            const init=node.initializer;if(init&&ts.isCallExpression(init)&&ts.isIdentifier(init.expression)&&createRequireNames.has(init.expression.text)){assert.equal(init.arguments.length,1);assert.equal(init.arguments[0].getText(tree),'import.meta.url');requireNames.add(node.name.text);}
        }
    });
    walk(tree,node=>{
        if(ts.isCallExpression(node)){
            assert.notEqual(node.expression.kind,ts.SyntaxKind.ImportKeyword,'Early artifact has a dynamic module import.');
            if(ts.isIdentifier(node.expression)&&(/^(?:__)?require\d*$/.test(node.expression.text)||requireNames.has(node.expression.text))){
                if(node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])&&builtin(node.arguments[0].text))return;
                assert.ok(requireNames.has(node.expression.text)&&node.arguments.length===1&&ts.isIdentifier(node.arguments[0]));
                let method=node.parent;while(method&&!ts.isMethodDeclaration(method))method=method.parent;
                assert.ok(method&&method.name.getText(tree)==='importTarget'&&method.parameters.length===1&&method.body.statements.length===6);
                let parent=method.parent;while(parent&&!ts.isFunctionDeclaration(parent))parent=parent.parent;
                assert.equal(parent?.name?.text,'createNativePreimportPorts');
                const statements=method.body.statements.map(row=>row.getText(tree).replace(/\s+/g,''));
                assert.ok(statements[0].includes('.equal('+node.arguments[0].text+',root+"/ownership.cjs")')||statements[0].includes(".equal("+node.arguments[0].text+",root+'/ownership.cjs')"));
                assert.ok(statements[1].includes('.assertActive(root)'));
                assert.ok(statements[2].includes('assertPreimportCacheEmpty('+node.expression.text+'.cache,root)'));
                assert.ok(statements[3].includes(node.expression.text+'('+node.arguments[0].text+')'));dynamicTargets++;
            }
        }
        if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&/^Session\d*$/.test(node.expression.text)){
            let method=node.parent;while(method&&!ts.isMethodDeclaration(method))method=method.parent;
            assert.equal(method?.name?.getText(tree),'sessionFactory');sessions++;
        }
    });
    assert.deepEqual(exports,['runPreimportCompatibilityFromFile']);assert.ok(functions.has('runPreimportCompatibilityFromFile'));
    assert.equal(dynamicTargets,1);assert.equal(requireNames.size,1);assert.equal(sessions,1);assert.equal(registries,1);
    return{externalImports:[...new Set(imports)].sort(),singlePrivateSessionFactory:true,singleObserverRegistry:true,fixedGuardedTargetImport:true};
}

/** Future early compiler preparation only. No native defaults, installs, staging mutation or
 * launch. Actual executor/readback ports must supply acknowledgements and stable bounded reads.
 * Synthetic invocations prove these checks, never the existence of a real emitted artifact. */
export async function prepareEarlyArtifact(selected,ports){
    const {root,sourceCommit,sourceTree}=structuredClone(selected);
    assert.deepEqual(Object.keys(selected).sort(),['root','sourceCommit','sourceTree']);assert.ok(root.startsWith('/')&&path.posix.normalize(root)===root&&!/[\\\x00-\x20\x7f]/.test(root));
    for(const key of [sourceCommit,sourceTree])assert.match(key,/^[a-f0-9]{40}$/);
    for(const key of ['observeToolchain','execute','read','assertFilesSettled'])assert.equal(typeof ports[key],'function');ports=Object.freeze({...ports});
    const source={sourceCommit,sourceTree},bridge=await observeSourceBridge(source,ports.sourceProvider);assertInstrumentedProductionBridge(bridge);
    const rows=new Map(bridge.inventory.map(row=>[row.path,row])),files=new Map(),edges=new Map();let total=0;
    async function load(file){
        relative(file);assert.ok(file.startsWith('scripts/lib/')||[EARLY_ENTRY,NATIVE].includes(file),'Product/unadmitted early input.');if(files.has(file))return;
        assert.ok(files.size<128);const row=rows.get(file);assert.ok(row);const actual=await ports.sourceProvider.file(file),bytes=Buffer.from(actual.bytes);
        assert.equal(actual.mode,row.mode);assert.equal(bytes.length,row.bytes);assert.equal(sourceDigest(bytes),row.sha256);total+=bytes.length;assert.ok(total<=4*1024**2);files.set(file,bytes);
        const tree=ast(file,bytes),imports=[];
        for(const statement of tree.statements)if((ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))&&statement.moduleSpecifier){
            assert.ok(ts.isStringLiteral(statement.moduleSpecifier));const request=statement.moduleSpecifier.text;
            if(builtin(request)){imports.push({path:request,external:true,kind:'import-statement'});continue;}
            assert.ok(request.startsWith('.'));const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),request));relative(target);imports.push({path:target,external:false,kind:'import-statement'});await load(target);
        }
        walk(tree,node=>{
            if(ts.isCallExpression(node)){
                assert.notEqual(node.expression.kind,ts.SyntaxKind.ImportKeyword,'Dynamic source import unsupported.');
                if(ts.isIdentifier(node.expression)&&node.expression.text==='require')assert.ok(file===NATIVE&&node.arguments.length===1&&node.arguments[0].getText(tree)==='file','Unexpected source require.');
            }
        });edges.set(file,imports);
    }
    await load(EARLY_ENTRY);
    async function toolIdentity(){
        const raw=await ports.observeToolchain();assert.deepEqual(Object.keys(raw).sort(),['esbuildEntryBytes','esbuildEntryFormat','esbuildPath','esbuildSHA256','nodePath','nodeSHA256']);
        for(const key of ['nodeSHA256','esbuildSHA256'])assert.match(raw[key],/^[a-f0-9]{64}$/);
        assert.equal(raw.esbuildPath,root+'/node_modules/esbuild/bin/esbuild');assert.ok(raw.nodePath.startsWith('/')&&path.posix.normalize(raw.nodePath)===raw.nodePath&&!/[\\\x00-\x20\x7f]/.test(raw.nodePath));
        assert.equal(raw.esbuildEntryFormat,'node-script');const entry=raw.esbuildEntryBytes;assert.ok(Buffer.isBuffer(entry)&&entry.length>0&&entry.length<=65536);assert.equal(sourceDigest(entry),raw.esbuildSHA256);
        assert.ok(['#!/usr/bin/env node\n','#!/usr/bin/env node\r\n','#!/usr/bin/node\n','#!/usr/bin/node\r\n'].some(prefix=>entry.subarray(0,Buffer.byteLength(prefix)).equals(Buffer.from(prefix))));
        const {esbuildEntryBytes:_bytes,...observed}=raw;return structuredClone(observed);
    }
    const before=await toolIdentity();
    const output='validation/gateway-ownership/instrumented/preimport.mjs',meta='validation/gateway-ownership/preimport-meta.json';
    const plan=Object.freeze({owner:randomBytes(16).toString('hex'),id:1,role:'build',cwd:root,command:Object.freeze([before.nodePath,before.esbuildPath,root+'/'+EARLY_ENTRY,'--bundle','--platform=node','--format=esm','--tree-shaking=false','--outfile='+root+'/'+output,'--metafile='+root+'/'+meta])});
    const acknowledgement=structuredClone(await ports.execute(plan));
    assert.deepEqual(Object.keys(acknowledgement).sort(),['command','cwd','id','lifecycle','owner','role']);for(const key of ['owner','id','role','cwd','command'])assert.deepEqual(acknowledgement[key],plan[key]);
    requireObservedClosure(acknowledgement.lifecycle);const life=acknowledgement.lifecycle;for(const key of ['spawnObserved','exitObserved','closeObserved'])assert.equal(life[key],true);
    assert.equal(life.code,0);assert.equal(life.closeCode,0);assert.equal(life.error,null);assert.equal(life.timedOut,false);assert.equal(life.terminationRequested,false);assert.deepEqual(life.killErrors,[]);assert.ok(Number.isFinite(life.elapsedMs)&&life.elapsedMs>=0&&life.elapsedMs<=480000);
    assert.deepEqual(await observeSourceBridge(source,ports.sourceProvider),bridge);assert.deepEqual(await toolIdentity(),before);
    const bytes=Buffer.from(await ports.read(root+'/'+output,MAX)),metaBytes=Buffer.from(await ports.read(root+'/'+meta,4*1024**2)),parsed=metadata(metaBytes);
    assert.deepEqual(Object.keys(parsed).sort(),['inputs','outputs']);assert.deepEqual(Object.keys(parsed.inputs).sort(),[...files.keys()].sort());assert.deepEqual(Object.keys(parsed.outputs),[output]);
    for(const [file,row]of Object.entries(parsed.inputs)){
        assert.equal(row.bytes,files.get(file).length);assert.deepEqual(row.imports.map(item=>({path:item.path,external:item.external===true,kind:item.kind})),edges.get(file));
    }
    const emitted=parsed.outputs[output];assert.equal(emitted.entryPoint,EARLY_ENTRY);assert.deepEqual(emitted.exports,['runPreimportCompatibilityFromFile']);assert.equal(emitted.bytes,bytes.length);assert.deepEqual(Object.keys(emitted.inputs).sort(),[...files.keys()].sort());
    for(const row of Object.values(emitted.inputs))assert.ok(Number.isSafeInteger(row.bytesInOutput)&&row.bytesInOutput>0&&row.bytesInOutput<=bytes.length);
    const inspected=inspectEarlyArtifact(bytes);for(const row of emitted.imports)assert.ok(row.external===true&&row.kind==='import-statement'&&builtin(row.path));assert.deepEqual([...new Set(emitted.imports.map(row=>row.path))].sort(),inspected.externalImports);
    assert.deepEqual(await observeSourceBridge(source,ports.sourceProvider),bridge);assert.deepEqual(await toolIdentity(),before);assert.equal(ports.assertFilesSettled(),undefined);
    const graph=[...files].map(([file,b])=>({path:file,bytes:b.length,sha256:sourceDigest(b)})).sort((a,b)=>a.path.localeCompare(b.path));
    return Object.freeze({schema:'source-acknowledged-preimport-early-artifact-v1',source,sourceBridgeSHA256:sourceDigest(JSON.stringify(bridge)+'\n'),artifactSHA256:sourceDigest(bytes),metafileSHA256:sourceDigest(metaBytes),graphSHA256:sourceDigest(JSON.stringify(graph)),graph,toolchain:before,commandAcknowledgementSHA256:sourceDigest(JSON.stringify(acknowledgement)),...inspected,
        compilerTrust:'pinned-acknowledged-compiler-transformation-not-independent-uploader-proof',actualRuntime:null,wholeGroupRetirement:null,releaseAcceptance:false});
}

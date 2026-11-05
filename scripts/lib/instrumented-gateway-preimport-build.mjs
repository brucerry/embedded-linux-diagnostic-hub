import assert from 'node:assert/strict';
import path from 'node:path';
import {types} from 'node:util';
import {randomBytes} from 'node:crypto';
import {isBuiltin} from 'node:module';
import ts from 'typescript';
import {observeSourceBridge,sourceDigest} from './committed-source-bridge.mjs';
import {assertInstrumentedProductionBridge,RAW_CLI_REFERENCE} from './instrumented-gateway-source.mjs';
import {projectGatewayLock,validatePreparedGatewayLock} from './gateway-lock-plan.mjs';
import {requireObservedClosure} from './owned-child.mjs';
import {prepareEarlyArtifact,instrumentedCompilerIdentity,readInstrumentedMetafile,EARLY_ENTRY} from './instrumented-gateway-early-emission.mjs';
import {censusInstrumentedGateway} from './instrumented-gateway-census.mjs';
import {deriveSshReadinessPlan} from './instrumented-gateway-ssh-readiness.mjs';
import {deriveInstrumentedGeneratedInventory} from './instrumented-gateway-generated.mjs';
import {snapshotPreparedInstrumentedGateway} from './instrumented-gateway-snapshot.mjs';

export const PREIMPORT_TARGET_ENTRY='tests/fixtures/instrumented-gateway-preimport-target.ts';
export const PREIMPORT_ACTIVATION='tests/fixtures/instrumented-gateway-preimport-activate.cjs';
const GUARD='tests/fixtures/instrumented-gateway-resolution-guard.cjs',OBSERVER='scripts/lib/instrumented-gateway-observer.mjs';
const preparedBuilds=new WeakMap(),retained=new Set(),failures=new WeakMap();
export const preimportBuildFailure=error=>structuredClone(failures.get(error)??null);
const absolute=p=>assert.ok(typeof p==='string'&&p.startsWith('/')&&path.posix.normalize(p)===p&&Buffer.byteLength(p)<=4096&&!/[\\\x00-\x20\x7f]/.test(p));
function acknowledgement(plan,value){
    const ack=structuredClone(value);assert.deepEqual(Object.keys(ack).sort(),['command','cwd','id','lifecycle','owner','role']);
    for(const key of ['command','cwd','id','owner','role'])assert.deepEqual(ack[key],plan[key]);requireObservedClosure(ack.lifecycle);
    for(const key of ['spawnObserved','exitObserved','closeObserved'])assert.equal(ack.lifecycle[key],true);
    assert.equal(ack.lifecycle.code,0);assert.equal(ack.lifecycle.closeCode,0);assert.equal(ack.lifecycle.terminationRequested,false);assert.deepEqual(ack.lifecycle.killErrors,[]);assert.ok(Number.isFinite(ack.lifecycle.elapsedMs)&&ack.lifecycle.elapsedMs>=0&&ack.lifecycle.elapsedMs<=480000);return ack;
}
export function inspectPreimportTarget(bytes){
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=32*1024**2);
    const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);assert.ok(Buffer.from(source).equals(bytes));
    const tree=ts.createSourceFile('ownership.cjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(tree.parseDiagnostics.length,0);
    const imports=[],exportTables=new Set(),exportAssignments=[];let factory=0;
    const top=node=>{for(let p=node.parent;p&&p!==tree;p=p.parent)if(ts.isFunctionLike(p))return false;return true;};
    const factoryProperty=prop=>((ts.isShorthandPropertyAssignment(prop)&&prop.name.text==='createGateway')||(ts.isPropertyAssignment(prop)&&prop.name.getText(tree)==='createGateway'&&ts.isIdentifier(prop.initializer)&&prop.initializer.text==='createGateway'));
    function walk(node){
        if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))assert.fail('Target must be standalone CommonJS.');
        if(ts.isFunctionDeclaration(node)&&node.name?.text==='createGateway')factory++;
        if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(tree)==='module.exports'&&top(node)){
            const paren=node.parent,guard=paren?.parent;const annotation=ts.isParenthesizedExpression(paren)&&ts.isBinaryExpression(guard)&&guard.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken&&ts.isNumericLiteral(guard.left)&&guard.left.text==='0'&&guard.right===paren&&ts.isObjectLiteralExpression(node.right)&&node.right.properties.length===1&&factoryProperty(node.right.properties[0]);
            if(!annotation)exportAssignments.push(node.right);
        }
        if(ts.isCallExpression(node)){
            if(ts.isIdentifier(node.expression)&&/^__export\d*$/.test(node.expression.text)&&top(node)&&node.arguments.length===2&&ts.isIdentifier(node.arguments[0])&&ts.isObjectLiteralExpression(node.arguments[1])){
                const props=node.arguments[1].properties;assert.equal(props.length,1);const prop=props[0];assert.ok(ts.isPropertyAssignment(prop)&&prop.name.getText(tree)==='createGateway'&&ts.isArrowFunction(prop.initializer)&&ts.isIdentifier(prop.initializer.body)&&prop.initializer.body.text==='createGateway');exportTables.add(node.arguments[0].text);
            }
            assert.notEqual(node.expression.kind,ts.SyntaxKind.ImportKeyword);
            if(ts.isIdentifier(node.expression)&&/^(?:__)?require\d*$/.test(node.expression.text)){
                assert.ok(node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]));const spec=node.arguments[0].text;
                assert.ok(spec==='ssh2'||(spec.startsWith('node:')&&isBuiltin(spec)&&spec!=='node:inspector'));imports.push(spec);
            }
            if(ts.isIdentifier(node.expression)&&node.expression.text==='createGateway')assert.fail('Compatibility target cannot call the Gateway factory.');
        }
        ts.forEachChild(node,child=>{walk(child);});
    }
    walk(tree);assert.equal(factory,1);assert.equal(exportAssignments.length,1);const exported=exportAssignments[0];assert.ok((ts.isObjectLiteralExpression(exported)&&exported.properties.length===1&&factoryProperty(exported.properties[0]))||(ts.isCallExpression(exported)&&ts.isIdentifier(exported.expression)&&/^__toCommonJS\d*$/.test(exported.expression.text)&&exported.arguments.length===1&&ts.isIdentifier(exported.arguments[0])&&exportTables.has(exported.arguments[0].text)),'Missing callable target export mapping.');assert.ok(imports.includes('ssh2'));return [...new Set(imports)].sort();
}

export async function preimportTargetGraph(sourceFile,hasFile){
    const files=new Map(),edges=new Map();let total=0;
    const permitted=file=>file===PREIMPORT_TARGET_ENTRY||file==='package.json'||file==='src/features/automation/serial-completion.ts'||['gateway/','backend/','shared/'].some(prefix=>file.startsWith(prefix));
    async function load(file){
        assert.ok(permitted(file),'Unreviewed target dependency.');if(files.has(file))return;assert.ok(files.size<128);const bytes=await sourceFile(file);assert.ok(Buffer.isBuffer(bytes)&&bytes.length<=16*1024**2);total+=bytes.length;assert.ok(total<=4*1024**2);files.set(file,Buffer.from(bytes));
        if(file==='package.json'){JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));edges.set(file,[]);return;}
        // Strip type-only syntax using the pinned local parser/compiler. A real esbuild census
        // must agree; disagreement is unsupported and fails closed, never silently refreshed.
        const emitted=ts.transpileModule(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{fileName:file,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,verbatimModuleSyntax:false}});assert.ok(!emitted.diagnostics.some(d=>d.category===ts.DiagnosticCategory.Error));
        const tree=ts.createSourceFile(file+'.js',emitted.outputText,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),imports=[];
        function edge(request,kind){
            if(request==='ssh2'||(request.startsWith('node:')&&isBuiltin(request)&&request!=='node:inspector')){imports.push({path:request,kind,external:true});return;}
            assert.ok(request.startsWith('.'));const base=path.posix.normalize(path.posix.join(path.posix.dirname(file),request));assert.ok(!base.startsWith('/')&&!base.split('/').includes('..'));
            const target=[base,base+'.ts',base+'.tsx',base+'.mjs',base+'.js',base+'/index.ts'].find(hasFile);assert.ok(target);imports.push({path:target,kind,external:false});
        }
        for(const statement of tree.statements)if((ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))&&statement.moduleSpecifier){assert.ok(ts.isStringLiteral(statement.moduleSpecifier));edge(statement.moduleSpecifier.text,'import-statement');}
        function walk(node){if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require'))){assert.ok(node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]));edge(node.arguments[0].text,node.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require-call');}ts.forEachChild(node,child=>{walk(child);});}walk(tree);
        edges.set(file,imports);for(const item of imports)if(!item.external)await load(item.path);
    }
    await load(PREIMPORT_TARGET_ENTRY);return{files,edges};
}
const normalizedEdges=rows=>[...new Set(rows.map(v=>{assert.ok(v&&typeof v.path==='string'&&['import-statement','require-call','dynamic-import'].includes(v.kind));assert.ok(v.external===undefined||typeof v.external==='boolean');return JSON.stringify({path:v.path,kind:v.kind,external:v.external===true});}))].sort();

/** Failure-only bounded data projection. Hashes never authorize a path read or an edge.
 * The original strict normalized comparison remains the admission boundary below. */
export function preimportEdgeDisagreement(file,files,expectedRows,observedRows){
    assert.ok(files instanceof Map&&files.has(file)&&Buffer.isBuffer(files.get(file)));const source=files.get(file);
    /** @typedef {{pathSHA256:string,sourceSHA256:string|null,knownSource:boolean,kind:string,external:boolean}} EdgeFingerprint */
    const base={schema:'preimport-edge-disagreement-v1',inputPathSHA256:sourceDigest(file),inputSourceSHA256:sourceDigest(source),shape:'invalid',expectedCount:null,observedCount:null,expectedSHA256:null,observedSHA256:null,missingCount:null,unexpectedCount:null,overflow:false,missing:/** @type {EdgeFingerprint[]} */([]),unexpected:/** @type {EdgeFingerprint[]} */([])};
    const bounded=rows=>Array.isArray(rows)&&rows.length<=256&&rows.every(row=>row&&typeof row==='object'&&typeof row.path==='string'&&Buffer.byteLength(row.path)<=4096&&['import-statement','require-call','dynamic-import'].includes(row.kind)&&(row.external===undefined||typeof row.external==='boolean'));
    if(!bounded(expectedRows)||!bounded(observedRows)){base.overflow=(Array.isArray(expectedRows)&&expectedRows.length>256)||(Array.isArray(observedRows)&&observedRows.length>256);return base;}
    const expected=normalizedEdges(expectedRows),observed=normalizedEdges(observedRows);if(JSON.stringify(expected)===JSON.stringify(observed))return null;
    const a=new Set(expected),b=new Set(observed),missing=expected.filter(x=>!b.has(x)),unexpected=observed.filter(x=>!a.has(x));
    base.shape='valid';base.expectedCount=expected.length;base.observedCount=observed.length;base.expectedSHA256=sourceDigest(JSON.stringify(expected));base.observedSHA256=sourceDigest(JSON.stringify(observed));base.missingCount=missing.length;base.unexpectedCount=unexpected.length;base.overflow=missing.length+unexpected.length>8;
    const project=text=>{const row=JSON.parse(text),known=files.has(row.path);return{pathSHA256:sourceDigest(row.path),sourceSHA256:known?sourceDigest(files.get(row.path)):null,knownSource:known,kind:row.kind,external:row.external};};
    const take=Math.min(missing.length,8);base.missing=missing.slice(0,take).map(project);base.unexpected=unexpected.slice(0,8-take).map(project);return base;
}

/** Two acknowledged compiler commands, no installer, namespace adoption, launch or defaults.
 * The caller must already own the trusted staging/install namespace. Absence checks do not
 * defend against malicious same-privilege namespace mutation; no such guarantee is claimed. */
export async function preparePreimportCompatibilityBuild(input,ports){
    input=structuredClone(input);assert.deepEqual(Object.keys(input).sort(),['root','sourceCommit','sourceTree','uid']);absolute(input.root);assert.ok(Number.isSafeInteger(input.uid)&&input.uid>0);
    for(const key of ['sourceCommit','sourceTree'])assert.match(input[key],/^[a-f0-9]{40}$/);
    ports=Object.freeze({...ports,filesystem:Object.freeze({...ports.filesystem})});for(const key of ['observeToolchain','execute','read','assertFilesSettled','queryAbsence'])assert.equal(typeof ports[key],'function');
    const source={sourceCommit:input.sourceCommit,sourceTree:input.sourceTree},selected={root:input.root,...source},stage=input.root+'/validation/gateway-ownership',root=stage+'/instrumented';
    const owner={phase:'source',checkpoint:'source-admission',failed:false,pendingAbsence:0,targetAcknowledged:false,earlyPrepared:false,inputOrdinal:null,expectedInputs:null,observedInputs:null,edgeDisagreement:null};retained.add(owner);
    try{
        const bridge=await observeSourceBridge(source,ports.sourceProvider);assertInstrumentedProductionBridge(bridge);
        const row=p=>{const r=bridge.inventory.find(v=>v.path===p);assert.ok(r);return r;};
        const sourceFile=async p=>{const actual=await ports.sourceProvider.file(p),r=row(p);assert.equal(actual.mode,r.mode);assert.equal(actual.bytes.length,r.bytes);assert.equal(sourceDigest(actual.bytes),r.sha256);return Buffer.from(actual.bytes);};
        for(const p of [PREIMPORT_TARGET_ENTRY,PREIMPORT_ACTIVATION,EARLY_ENTRY,GUARD,OBSERVER])row(p);
        assert.equal((await sourceFile(PREIMPORT_TARGET_ENTRY)).toString().trim().split('\n').filter(line=>!line.startsWith('//')).join('\n').trim(),"export {createGateway} from '../../gateway/server';");
        const targetGraph=await preimportTargetGraph(sourceFile,p=>bridge.inventory.some(row=>row.path===p));
        const tools=async()=>instrumentedCompilerIdentity(await ports.observeToolchain(),input.root),toolchain=await tools();
        async function stable(){assert.deepEqual(await observeSourceBridge(source,ports.sourceProvider),bridge);assert.deepEqual(await tools(),toolchain);assert.equal(ports.assertFilesSettled(),undefined);}
        const absent=async file=>{owner.pendingAbsence++;let observed=false;try{const query=ports.queryAbsence(file);assert.ok(types.isPromise(query));try{await query;observed=true;}catch(error){observed=true;assert.equal(error?.code,'ENOENT');return;}assert.fail('Pre-existing build output cannot be replaced.');}finally{if(observed)owner.pendingAbsence--;}};
        owner.phase='absence';owner.checkpoint='output-absence';for(const file of [root+'/ownership.cjs',root+'/preimport.mjs',stage+'/target-meta.json',stage+'/preimport-meta.json'])await absent(file);
        await stable();owner.phase='target-build';owner.checkpoint='target-command';
        const command=Object.freeze([toolchain.nodePath,toolchain.esbuildPath,input.root+'/'+PREIMPORT_TARGET_ENTRY,'--bundle','--platform=node','--format=cjs','--tree-shaking=false','--outfile='+root+'/ownership.cjs','--metafile='+stage+'/target-meta.json','--external:ssh2']);
        const plan=Object.freeze({owner:randomBytes(16).toString('hex'),id:1,role:'build',cwd:input.root,command});const rawTargetAck=await ports.execute(plan);owner.checkpoint='target-acknowledgement';const targetAck=acknowledgement(plan,rawTargetAck);owner.targetAcknowledged=true;owner.checkpoint='target-post-source';await stable();
        owner.checkpoint='target-read-js';const target=Buffer.from(await ports.read(root+'/ownership.cjs',32*1024**2));owner.checkpoint='target-read-meta';const metaBytes=Buffer.from(await ports.read(stage+'/target-meta.json',4*1024**2));owner.checkpoint='target-parse-meta';const meta=readInstrumentedMetafile(metaBytes);
        owner.checkpoint='target-inspect-js';const external=inspectPreimportTarget(target);owner.checkpoint='target-external-imports';assert.deepEqual(external,[...new Set([...targetGraph.edges.values()].flat().filter(v=>v.external).map(v=>v.path))].sort());const output='validation/gateway-ownership/instrumented/ownership.cjs';
        owner.checkpoint='target-input-inventory';owner.expectedInputs=targetGraph.files.size;owner.observedInputs=meta.inputs&&typeof meta.inputs==='object'?Object.keys(meta.inputs).length:null;assert.deepEqual(Object.keys(meta).sort(),['inputs','outputs']);assert.deepEqual(Object.keys(meta.outputs),[output]);assert.deepEqual(Object.keys(meta.inputs).sort(),[...targetGraph.files.keys()].sort());
        let ordinal=0;for(const [file,v]of Object.entries(meta.inputs)){owner.inputOrdinal=++ordinal;owner.checkpoint='target-input-edges';
            assert.ok(targetGraph.files.has(file),'Unbound target input.');owner.edgeDisagreement=preimportEdgeDisagreement(file,targetGraph.files,targetGraph.edges.get(file),v.imports);assert.deepEqual(normalizedEdges(v.imports),normalizedEdges(targetGraph.edges.get(file)));owner.edgeDisagreement=null;
            owner.checkpoint='target-input-bytes';assert.equal(v.bytes,row(file).bytes);assert.ok(Array.isArray(v.imports));
            owner.checkpoint='target-input-members';for(const edge of v.imports){if(edge.external)assert.ok(edge.path==='ssh2'||(edge.path.startsWith('node:')&&isBuiltin(edge.path)&&edge.path!=='node:inspector'));else assert.ok(Object.hasOwn(meta.inputs,edge.path));}
        }
        owner.checkpoint='target-required-inputs';for(const file of [PREIMPORT_TARGET_ENTRY,'gateway/server.ts','backend/ssh/session.ts'])assert.ok(Object.hasOwn(meta.inputs,file));
        owner.checkpoint='target-output-identity';const result=meta.outputs[output];assert.equal(result.entryPoint,PREIMPORT_TARGET_ENTRY);assert.equal(result.bytes,target.length);assert.ok(Array.isArray(result.exports)&&(result.exports.length===0||JSON.stringify(result.exports)==='["createGateway"]'));
        owner.checkpoint='target-output-inputs';assert.deepEqual(Object.keys(result.inputs).sort(),Object.keys(meta.inputs).sort());for(const v of Object.values(result.inputs))assert.ok(Number.isSafeInteger(v.bytesInOutput)&&v.bytesInOutput>0&&v.bytesInOutput<=target.length);
        owner.checkpoint='target-output-imports';for(const edge of result.imports)assert.ok(edge.external===true&&edge.kind==='require-call'&&(edge.path==='ssh2'||(edge.path.startsWith('node:')&&isBuiltin(edge.path)&&edge.path!=='node:inspector')));
        assert.deepEqual([...new Set(result.imports.map(v=>v.path))].sort(),external);
        owner.phase='early-build';owner.checkpoint='early-preparation';await absent(root+'/preimport.mjs');await absent(stage+'/preimport-meta.json');let earlyExecutions=0;
        const early=await prepareEarlyArtifact(selected,{...ports,async execute(p){assert.equal(earlyExecutions++,0);assert.equal(p.command[2],input.root+'/'+EARLY_ENTRY);return ports.execute(p);}});assert.equal(earlyExecutions,1);owner.earlyPrepared=true;owner.checkpoint='early-post-source';await stable();
        owner.phase='census';owner.checkpoint='installation-census';const census=await censusInstrumentedGateway(root,input.uid,ports.filesystem,'preimport-v1');assert.ok(census.scripts.get(root+'/ownership.cjs').equals(target));assert.equal(sourceDigest(census.scripts.get(root+'/preimport.mjs')),early.artifactSHA256);
        assert.ok(census.scripts.get(root+'/activate.cjs').equals(await sourceFile(PREIMPORT_ACTIVATION)));assert.ok(census.scripts.get(root+'/resolution-guard.cjs').equals(await sourceFile(GUARD)));
        const pkg=JSON.parse((await sourceFile('package.json')).toString()),lock=JSON.parse((await sourceFile('package-lock.json')).toString()),projected=projectGatewayLock(pkg,lock);
        assert.deepEqual(JSON.parse(census.scripts.get(root+'/package.json').toString()),projected.manifest);validatePreparedGatewayLock(JSON.parse(census.scripts.get(root+'/package-lock.json').toString()),projected.manifest,lock);deriveSshReadinessPlan(census.scripts,root);
        const selection={...source,artifactPath:root+'/ownership.cjs',artifactSHA256:sourceDigest(target),observerSHA256:row(OBSERVER).sha256},generatedInventory=deriveInstrumentedGeneratedInventory(census.scripts,root);
        const binding={kind:'separate-preimport-gateway-build-byte-binding-v5',source,sourceBridgeSHA256:sourceDigest(JSON.stringify(bridge)+'\n'),rawCLIReference:{...RAW_CLI_REFERENCE},toolchain,
            entrySHA256:row(PREIMPORT_TARGET_ENTRY).sha256,observerSHA256:selection.observerSHA256,artifactPath:selection.artifactPath,artifactSHA256:selection.artifactSHA256,artifactBytes:target.length,
            guardSHA256:row(GUARD).sha256,activationSHA256:row(PREIMPORT_ACTIVATION).sha256,installationPackageSHA256:census.packageSHA256,installationLockSHA256:census.lockSHA256,
            generatedInventory,generatedInventorySHA256:sourceDigest(JSON.stringify(generatedInventory)),fileInventory:census.inventory,fileInventorySHA256:census.inventorySHA256,scriptInventory:census.scriptInventory,scriptInventorySHA256:census.scriptInventorySHA256,
            preimport:{schema:'source-acknowledged-preimport-pair-v1',earlyArtifactSHA256:early.artifactSHA256,earlyEntrySHA256:row(EARLY_ENTRY).sha256,earlyGraphSHA256:early.graphSHA256,earlyMetafileSHA256:early.metafileSHA256,earlyAcknowledgementSHA256:early.commandAcknowledgementSHA256,targetGraphSHA256:sourceDigest(JSON.stringify([...targetGraph.files].map(([p,b])=>({path:p,bytes:b.length,sha256:sourceDigest(b)})).sort((a,b)=>a.path.localeCompare(b.path)))),targetMetafileSHA256:sourceDigest(metaBytes),targetAcknowledgementSHA256:sourceDigest(JSON.stringify(targetAck))},
            provenance:'local-source-command-and-byte-consistency-not-service-attestation',buildProvenanceVerified:false,wholeGroupRetirement:null,releaseAcceptance:false};
        owner.checkpoint='final-binding';const copied=snapshotPreparedInstrumentedGateway({binding,selection,scripts:census.scripts});await stable();
        owner.phase='prepared';retained.delete(owner);const capability=Object.freeze({snapshot:()=>({source:{...source},targetSHA256:selection.artifactSHA256,earlySHA256:early.artifactSHA256,buildCommands:2,wholeGroupRetirement:null,releaseAcceptance:false})});
        preparedBuilds.set(capability,{prepared:copied,uid:input.uid,census:census.census,used:false});return capability;
    }catch(cause){owner.failed=true;const error=Object.assign(Error('Preimport pair preparation failed; no launch or retry.',{cause}),{owner});const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000?n:null;failures.set(error,{phase:owner.phase,checkpoint:owner.checkpoint,targetAcknowledged:owner.targetAcknowledged,earlyPrepared:owner.earlyPrepared,inputOrdinal:count(owner.inputOrdinal),expectedInputs:count(owner.expectedInputs),observedInputs:count(owner.observedInputs),edgeDisagreement:structuredClone(owner.edgeDisagreement)});throw error;}
}
export function claimPreimportCompatibilityBuild(value){const record=preparedBuilds.get(value);assert.ok(record&&!record.used,'Actual one-use two-artifact preparation required.');record.used=true;return{prepared:snapshotPreparedInstrumentedGateway(record.prepared),uid:record.uid,census:structuredClone(record.census)};}

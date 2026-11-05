import assert from 'node:assert/strict';
import { readFileSync, constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { localSourceProvider } from '../../scripts/lib/committed-source-provider.mjs';
import { memoryFilesystem, sourceFixture } from './gateway-producer-memory';
import { sourceDigest } from '../../scripts/lib/committed-source-bridge.mjs';
import { RAW_CLI_REFERENCE } from '../../scripts/lib/instrumented-gateway-source.mjs';
import { INSTRUMENTED_GATEWAY_BRANCH } from '../../scripts/lib/instrumented-gateway-policy.mjs';
const root='/project',installed=root+'/validation/gateway-ownership/instrumented';
const reference=JSON.parse(readFileSync(new URL('./gateway-ownership-production.json',import.meta.url),'utf8'));
const files=new Map<string,Buffer>(reference.inventory.map((v:any)=>[v.path,readFileSync(new URL('../../'+v.path,import.meta.url))]));
for(const p of ['tests/fixtures/instrumented-gateway-check-entry.ts','tests/fixtures/instrumented-gateway-activate.cjs','tests/fixtures/instrumented-gateway-entry.ts','scripts/lib/instrumented-gateway-observer.mjs','scripts/lib/instrumented-gateway-check.mjs','scripts/lib/instrumented-gateway-source.mjs'])files.set(p,readFileSync(new URL('../../'+p,import.meta.url)));
function receipt(input:any){
    const common={source:input.binding.source,bindingSHA256:sourceDigest(JSON.stringify(input.binding)+'\n'),artifactSHA256:input.selection.artifactSHA256,instrumented:true,compiledScripts:1,generatedScripts:[],elapsedMs:1,releaseAcceptance:false,wholeGroupRetirement:null,shippedCLIBehavior:null};
    if(input.mode==='compatibility')return{...common,schema:'instrumented-node-inspector-compatibility-v2',status:'exact-prelaunch-bytes-match-replayed-sources',builtinScripts:0,builtinIdentityVerified:false,observerRetired:true,productWorkload:null};
    const z={stopping:true,serverListening:false,cleanupTimers:0,requestTasks:0,httpSockets:0,httpResponses:0,httpBodyReaders:0,pendingConnections:0,sessions:0,inFlight:0,ownedSessions:0,retiringSessions:0,connectionAttempts:0,cancelledAttemptCache:0,sessionOwners:0,allSessionOwners:0};
    return{...common,schema:'separate-instrumented-gateway-ownership-check-v2',rawCLIReference:RAW_CLI_REFERENCE,evidenceSeparation:'this-instrumented-build-only-no-transfer-to-raw-CLI',before:{...z,stopping:false,serverListening:true,cleanupTimers:1},afterHealth:{...z,stopping:false,serverListening:true,cleanupTimers:1},afterClose:z,
        health:{role:'healthy',status:200,responseBytes:79,elapsedMs:1,requestRetired:true,responseRetired:true,socketRetired:true,wholeGroupRetirement:null,releaseAcceptance:false},observerRecordSHA256:'a'.repeat(64),productCloseAcknowledged:true,localObserverRetired:true,shippingGC:null,shippingPerformance:null};
}
export function driverMemory(options:any={}){
    const sourceFiles=new Map(files);if(options.actualGit)for(let i=0;i<850;i++)sourceFiles.set('tests/synthetic/record'+i+'.ts',Buffer.from('// synthetic distinct frozen source '+i+'; never executed\n'));if(options.productionChange)sourceFiles.set('gateway/server.ts',Buffer.from('changed production'));
    const source=sourceFixture(sourceFiles),f=memoryFilesystem(),controls:any={},children:any[]=[],calls:any[]=[],directories=new Set<any>(),timers:Function[]=[];
    f.records.delete('/project/validation');if(options.actualGit)for(const[name,bytes]of source.files)f.write('/project/'+name,bytes);
    const node=Buffer.from('synthetic Node, never executed'),git=Buffer.from('synthetic Git, never executed'),npm=Buffer.from('#!/usr/bin/env node\n// synthetic npm, never executed\n'),npmPackage=Buffer.from('{"name":"npm","version":"11.0.0","bin":{"npm":"bin/npm-cli.js"}}');
    f.write('/tools/bin/node',node);f.write('/usr/bin/git',git);f.write('/tools/lib/node_modules/npm/bin/npm-cli.js',npm);f.write('/tools/lib/node_modules/npm/package.json',npmPackage);
    const stat=async(p:string)=>({...await f.fs.lstat(p),uid:1000});
    const native:any={...f.fs,lstat:stat,async opendir(p:string){const rows=await f.fs.readdir(p);let at=0;const h={async read(){return rows[at++]??null;},async close(){directories.delete(h);}};directories.add(h);return h;},
        async open(p:string,flags:number){assert.ok(flags&constants.O_NOFOLLOW);if(flags&constants.O_DIRECTORY){const h={stat:()=>stat(p),async sync(){},async close(){directories.delete(h);}};directories.add(h);return h;}
            const writing=Boolean(flags&constants.O_EXCL),h=await f.fs.open(p,writing?'wx':'r');return{read:(...a:[Buffer,number,number])=>h.read(...a),async stat(){return{...await h.stat(),uid:1000};},sync:()=>h.sync(),close:()=>h.close(),
                async write(b:Buffer,offset:number,length:number,position:number){const n=Math.min(length,11),old=f.bytes(p),next=Buffer.alloc(Math.max(old.length,position+n));old.copy(next);b.copy(next,position,offset,offset+n);f.write(p,next);return{bytesWritten:n};}};}};
    const selection={context:{repository:'brucerry/embedded-linux-diagnostic-hub',private:false,ref:'refs/heads/'+INSTRUMENTED_GATEWAY_BRANCH,event:'push',job:'instrumented_gateway',attempt:'1',runner:'github-hosted',system:'Linux',arch:'X64',sha:source.context.sourceCommit,tree:source.context.sourceTree,run:'123',policy:'github-hosted-diagnostic-teardown-unproved-group-v1'},
        root,nodePath:'/tools/bin/node',gitPath:'/usr/bin/git',npmPath:'/tools/lib/node_modules/npm/bin/npm-cli.js',nodeSHA256:sourceDigest(node),gitSHA256:sourceDigest(git),npmSHA256:sourceDigest(npm),npmPackageSHA256:sourceDigest(npmPackage),
        runtime:{platform:'linux',arch:'x64',version:'v24.22.0',execPath:'/tools/bin/node',execArgv:[],uid:1000,nodeOptions:null,nodePathVariable:null}};
    const gitCalls:any[]=[];
    function gitLaunch(file:string,args:string[],opts:any){
        assert.equal(file,'/usr/bin/git');const tail=args.slice(6),batch=tail[0]==='cat-file';gitCalls.push({args:[...args],tail:[...tail]});
        const child:any=new EventEmitter();Object.assign(child,{pid:7000+gitCalls.length,exitCode:null,signalCode:null,stdout:new EventEmitter(),stderr:new EventEmitter(),stdin:batch?new EventEmitter():null});
        async function finish(input?:Buffer){const state=await source.provider.state();let output=Buffer.alloc(0),code=0;
            if(tail[0]==='rev-parse'){const value=tail[1]==='--show-toplevel'?'/project':tail[1]==='--show-object-format'?'sha1':tail[1]==='--show-prefix'?'':tail[2]==='HEAD'?state.sourceCommit:state.sourceTree;output=Buffer.from(value+'\n');}
            else if(tail[0]==='config')code=1;
            else if(tail[0]==='ls-files')output=Buffer.from(state.index.map(v=>v.mode+' '+v.oid+' '+v.stage+'\t'+v.path+'\0').join(''));
            else{assert.equal(tail[0],'cat-file');const ids=input!.toString().trim().split('\n'),objects=await source.provider.objects(ids);output=Buffer.concat(objects.map(v=>Buffer.concat([Buffer.from(v.oid+' '+v.type+' '+v.bytes.length+'\n'),...(tail[1]==='--batch'?[v.bytes,Buffer.from('\n')]:[])])));}
            if(output.length)child.stdout.emit('data',output);child.stdout.emit('close');child.stderr.emit('close');child.emit('exit',code,null);child.emit('close',code,null);
        }
        Promise.resolve().then(()=>{child.emit('spawn');if(!batch)void finish();});
        if(batch)child.stdin.end=(bytes:Buffer,cb:Function)=>{Promise.resolve().then(()=>{child.stdin.emit('finish');cb(null);child.stdin.emit('close');void finish(bytes);});return child.stdin;};return child;
    }
    const ports:any={filesystem:native,now:()=>0,setTimer(fn:Function,ms:number){assert.ok([180000,480000,60000,30000].includes(ms));timers.push(fn);return{fn};},clearTimer(){},sourceFactory:async(selectedRoot:string,cap:any)=>options.actualGit?localSourceProvider(selectedRoot,{filesystem:cap.filesystem,execute:cap.executeGit,environment:cap.gitEnvironment,asynchronous:true,platform:'linux'}):source.provider,
        launch(file:string,args:string[],opts:any){
            if(file==='/usr/bin/git')return gitLaunch(file,args,opts);
            assert.equal(file,selection.nodePath);assert.equal(opts.shell,false);assert.deepEqual(opts.stdio,['ignore','pipe','pipe']);
            const role=args[0]===selection.npmPath?(args.some(v=>v==='--prefix='+root)?'toolchain':'dependencies'):args[0].endsWith('/activate.cjs')?(children.some(v=>v.role==='compatibility')?'ownership':'compatibility'):'build';
            calls.push({file,args:[...args],options:structuredClone(opts),role});
            if(controls.unknownLaunch)return Promise.reject(Error('synthetic uncertain launch'));
            const child:any=new EventEmitter();Object.assign(child,{role,pid:3000+children.length,exitCode:null,signalCode:null,stdin:null,stdout:new EventEmitter(),stderr:new EventEmitter(),spawnfile:file,spawnargs:[file,...args]});children.push(child);
            if(controls.wrongSpawn===role)child.spawnargs=[file,'unapproved'];
            child.finish=(code=0)=>{child.emit('exit',code,null);child.emit('close',code,null);child.stdout.emit('close');child.stderr.emit('close');};
            Promise.resolve().then(()=>{
                child.emit('spawn');
                if(role==='toolchain')f.write(root+'/node_modules/esbuild/bin/esbuild',Buffer.from('#!/usr/bin/env node\n// synthetic compiler, never run\n'));
                if(role==='dependencies'){
                    const lock=JSON.parse(f.bytes(installed+'/package-lock.json').toString());
                    for(const [name,value]of Object.entries<any>(lock.packages)){if(!name||value.optional)continue;f.write(installed+'/'+name+'/package.json',Buffer.from(JSON.stringify({name:name.slice('node_modules/'.length),version:value.version})));f.write(installed+'/'+name+'/index.js',Buffer.from('module.exports={};\n'));}
                    if(controls.binary)f.write(installed+'/node_modules/ssh2/util/pagent.exe',Buffer.from([0x4d,0x5a,0xff]));
                    if(controls.badCensus){const rec=f.records.get(installed+'/node_modules/ssh2/package.json');assert.ok(rec);rec.nlink=2;}
                    if(controls.nested)f.write(installed+'/node_modules/ssh2/node_modules/evil/index.js',Buffer.from('not admitted'));
                }
                if(role==='build')f.write(installed+'/ownership.cjs',Buffer.from('// synthetic compiled artifact; never executed\n'));
                if(role==='compatibility'||role==='ownership'){
                    const bytes=f.bytes(args[1]),input=JSON.parse(bytes.toString()),r=receipt(input),e={schema:'owned-instrumented-gateway-child-result-v1',mode:input.mode,nonce:input.nonce,inputSHA256:sourceDigest(bytes),bindingSHA256:sourceDigest(JSON.stringify(input.binding)+'\n'),receipt:r,receiptSHA256:sourceDigest(JSON.stringify(r)+'\n')};
                    if(controls.badCompatibility&&role==='compatibility')e.nonce='0'.repeat(32);
                    child.stdout.emit('data',Buffer.from('HUB_INSTRUMENTED_GATEWAY_CHILD='+JSON.stringify(e)+'\n'));
                }
                if(controls.sourceChange===role){const original=source.provider.file;source.provider.file=async(p:string)=>p==='gateway/server.ts'?{mode:'100644',bytes:Buffer.from('changed')}:original(p);}
                if(controls.nodeChange===role)f.write(selection.nodePath,Buffer.from('changed Node'));
                if(controls.hold===role)return;
                child.finish(controls.fail===role?1:0);
            });return child;
        }};
    return{...f,source,controls,selection,ports,children,calls,gitCalls,directories,expire:()=>timers.at(-1)!()};
}

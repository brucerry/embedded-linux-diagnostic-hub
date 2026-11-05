import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {isBuiltin} from 'node:module';
import {pathToFileURL} from 'node:url';
import {preimportPairMemory} from './gateway-preimport-pair-memory';
import {sourceFixture} from './gateway-producer-memory';
import {parentPackageReference} from '../../scripts/lib/preimport-package-admission.mjs';
import {createPreimportExecution} from '../../scripts/lib/preimport-execution.mjs';
import {sourceDigest} from '../../scripts/lib/committed-source-bridge.mjs';
import {PREIMPORT_NATIVE_BRANCH} from '../../scripts/lib/preimport-native-policy.mjs';

// Fixed, hash-audited installed files read as data only. All filesystem/child effects below
// are authored memory ports; even the native esbuild bytes are never executed or loaded.
const packageBytes=new Map<string,Buffer>();
for(const pkg of parentPackageReference().packages)for(const file of pkg.files)packageBytes.set(pkg.name+'/'+file.path,readFileSync(new URL('../../node_modules/'+pkg.name+'/'+file.path,import.meta.url)));
export async function nativePreimportMemory(){
    const f=await preimportPairMemory(),installed=new Map([...f.records].filter(([p,row])=>p.startsWith(f.installed+'/node_modules/')&&row.kind==='file')),controls:any={},calls:any[]=[],commands:any[]=[],hooks:any[]=[],timers:any[]=[],facts={cacheChecks:0,loads:0};
    // Authored initial state: the bootstrap must create its own absent staging namespace.
    for(const key of [...f.records.keys()])if(key==='/project/validation'||key.startsWith('/project/validation/'))f.records.delete(key);
    const files=new Map(f.files);
    for(const name of ['preimport-native-bootstrap','preimport-package-admission','preimport-package-reference','preimport-native-policy','preimport-execution'])files.set('scripts/lib/'+name+'.mjs',readFileSync(new URL('../../scripts/lib/'+name+'.mjs',import.meta.url)));
    files.set('.github/preimport-native-entry.mjs',readFileSync(new URL('../../.github/preimport-native-entry.mjs',import.meta.url)));
    const source=sourceFixture(files),node=f.bytes('/tools/node');f.write('/tools/bin/node',node);f.write('/usr/bin/git',Buffer.from('synthetic git'));
    const npmPath='/tools/lib/node_modules/npm/bin/npm-cli.js',npm=Buffer.from('// synthetic npm'),npmPackage=Buffer.from('{"name":"npm","version":"11.0.0","bin":{"npm":"bin/npm-cli.js"}}');f.write(npmPath,npm);f.write('/tools/lib/node_modules/npm/package.json',npmPackage);
    const selection={root:'/project',context:{repository:'brucerry/embedded-linux-diagnostic-hub',private:false,ref:'refs/heads/'+PREIMPORT_NATIVE_BRANCH,event:'push',job:'preimport_compatibility',attempt:'1',runner:'github-hosted',system:'Linux',arch:'X64',sha:source.context.sourceCommit,tree:source.context.sourceTree,run:'123',policy:'github-hosted-diagnostic-teardown-unproved-group-v1'},nodePath:'/tools/bin/node',gitPath:'/usr/bin/git',npmPath,nodeSHA256:sourceDigest(node),gitSHA256:sourceDigest(f.bytes('/usr/bin/git')),npmSHA256:sourceDigest(npm),npmPackageSHA256:sourceDigest(npmPackage),runtime:{...f.host.runtime,execPath:'/tools/bin/node'}};
    function installPackages(){for(const [name,bytes]of packageBytes){const row=f.write('/project/node_modules/'+name,Buffer.alloc(0));row.bytes=bytes;}if(controls.packageChange)f.write('/project/node_modules/'+controls.packageChange,Buffer.from('wrong'));if(controls.omit)f.records.delete('/project/node_modules/'+controls.omit);}
    const ports:any={filesystem:f.host.filesystem,now:()=>0,setTimer(fn:Function,ms:number){assert.ok([180000,480000,60000].includes(ms));const value={fn,ms};timers.push(value);return value;},clearTimer(){},sourceFactory:async()=>{if(controls.badSource)source.provider.file=async()=>({mode:'100644',bytes:Buffer.from('wrong')});return source.provider;},isBuiltin,
        assertPackageCacheEmpty(){facts.cacheChecks++;if(controls.cache)throw Error('Preloaded package');},onLoaderFailure(){},
        registerHooks(h:any){hooks.push(h);if(controls.hookReturn)return controls.hookReturn;return{deregister(){throw Error('Hooks must remain until process exit');}};},
        async loadDriver(file:string){facts.loads++;if(controls.loadFailure)throw Error('Unknown import rejection');const parentURL=pathToFileURL('/project/scripts/lib/preimport-native-bootstrap.mjs').href;hooks[0].resolve(pathToFileURL(file).href,{parentURL},()=>({url:pathToFileURL(file).href,format:'module'}));
            for(const name of ['typescript','semver'])hooks[0].resolve(name,{parentURL:pathToFileURL(file).href},()=>{throw Error('Bare package ancestor resolution forbidden');});return{createPreimportExecution};},
        launch(file:string,args:string[],options:any){
            if(args[0]===f.installed+'/activate.cjs'){calls.push({role:'compatibility'});if(controls.postParentMutation){const original=source.provider.file;source.provider.file=async(p:string)=>p==='gateway/server.ts'?{mode:'100644',bytes:Buffer.from('post-parent changed source')}:original(p);}return f.host.launch(file,args,options);}
            const role=args[0]===npmPath?(args.includes('--prefix=/project')?'toolchain':'dependencies'):'build';calls.push({role,args,options});
            if(controls.unknown===role)return Promise.reject(Error('Unknown synthetic launch'));
            const child:any=new EventEmitter();Object.assign(child,{pid:2000+commands.length,spawnfile:file,spawnargs:[file,...args],exitCode:null,signalCode:null,stdin:null,stdout:new EventEmitter(),stderr:new EventEmitter()});commands.push(child);
            Promise.resolve().then(async()=>{child.emit('spawn');
                if(role==='toolchain')installPackages();
                if(role==='dependencies')for(const [p,row]of installed){const value=f.write(p,Buffer.alloc(0));value.bytes=row.bytes;}
                if(role==='build')await f.buildPorts.execute({role:'build',id:1,owner:'a'.repeat(32),cwd:'/project',command:[file,...args]});
                if(controls.mutate===role)f.write('/project/node_modules/semver/index.js',Buffer.from('wrong'));
                if(controls.hold===role)return;
                const code=controls.fail===role?1:0;child.stdout.emit('close');child.stderr.emit('close');child.emit('exit',code,null);child.emit('close',code,null);
            }).catch(error=>{child.emit('error',error);});return child;
        }};
    return{...f,source,selection,ports,controls,calls,commands,hooks,timers,facts,installPackages};
}

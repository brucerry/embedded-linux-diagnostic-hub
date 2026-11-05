import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import guardModule from './fixtures/instrumented-gateway-resolution-guard.cjs';
import { validateContainment } from '../scripts/lib/instrumented-gateway-containment.mjs';
const {createInstrumentedResolutionGuard}=guardModule;
const root='/checkout/validation/gateway-ownership/instrumented',caller=pathToFileURL(root+'/node_modules/ssh2/lib/protocol/constants.js').href;
function fixture(options:any={}){
    let resolve:Function=()=>{throw Error('not registered');},holds=0,violations=0,deregisters=0,exitCode:number|undefined;
    const handle={deregister(){deregisters++;throw Error('guard must remain registered for direct child lifetime');}};
    const ports={
        registerHooks(h:any){resolve=h.resolve;if(options.registrationThrow)throw Error('authored registration uncertainty');if(options.reentrant){try{resolve('node:fs',{},()=>({url:'node:fs'}));}catch{}}
            return Object.hasOwn(options,'registrationReturn')?options.registrationReturn:handle;},
        isBuiltin(s:string){if(options.builtinThrow)throw Error('authored unsupported builtin API');return Object.hasOwn(options,'builtinReturn')?options.builtinReturn:['node:fs','fs','node:path','path'].includes(s);},
        onViolation(){violations++;exitCode=1;if(options.notifyThrow)throw Error('notification failure');return options.notifyReturn;},
        onUncertain(){holds++;},
    };
    return{ports,raw:(s:string,context:any,next:Function)=>resolve(s,context,next),create:()=>createInstrumentedResolutionGuard(root,ports),call:(s:string,parent:string|undefined,next:Function)=>resolve(s,{parentURL:parent},next),get holds(){return holds;},get violations(){return violations;},get deregisters(){return deregisters;},get exitCode(){return exitCode;}};
}
test('guard preserves normal in-root and builtin resolution, then remains installed through close preparation',()=>{
    const f=fixture(),g=f.create(),file={url:pathToFileURL(root+'/owned.js').href,format:'commonjs',importAttributes:Object.create(null)};
    g.assertActive(root);assert.equal(f.call('./owned.js',pathToFileURL(root+'/activate.cjs').href,()=>file),file);
    assert.deepEqual(f.call('fs',undefined,()=>({url:'node:fs',format:'builtin'})),{url:'node:fs',format:'builtin'});
    const record=g.prepareClose(root);validateContainment(record,true);assert.equal(record.registered,true);assert.equal(record.closePrepared,true);g.assertClosePrepared(root);assert.equal(f.deregisters,0);assert.equal(f.holds,0);assert.equal(f.violations,0);
    f.call('node:path',undefined,()=>({url:'node:path',format:'builtin'}));g.assertClosePrepared(root);assert.equal(f.deregisters,0);
});
test('omitted optional CPU dependency cannot consult an injected ancestor or execute its native loader',()=>{
    const f=fixture(),g=f.create();let consulted=false;
    assert.throws(()=>f.call('cpu-features',caller,()=>{consulted=true;return{url:'file:///checkout/node_modules/cpu-features/lib/index.js',format:'commonjs'};}),(e:any)=>e.code==='MODULE_NOT_FOUND');
    assert.equal(consulted,false);assert.equal(g.snapshot().failed,false);assert.equal(g.snapshot().optionalCpuBlocked,1);assert.equal(f.violations,0);g.assertActive(root);validateContainment(g.prepareClose(root),true);
});
for(const kind of ['wrong-caller','repeat'])test('CPU exception cannot grant a new caller or repeated lookup: '+kind,()=>{
    const f=fixture(),g=f.create();let consulted=0;
    if(kind==='repeat')assert.throws(()=>f.call('cpu-features',caller,()=>{consulted++;return{};}));
    assert.throws(()=>f.call('cpu-features',kind==='wrong-caller'?'file:///outside/other.js':caller,()=>{consulted++;return{};}));assert.equal(consulted,0);assert.equal(f.exitCode,1);assert.equal(g.snapshot().failed,true);assert.throws(()=>g.assertActive(root));
});
for(const [name,url,format] of [['ancestor','file:///checkout/node_modules/injected/index.js','commonjs'],['outside-realpath','file:///outside/real.js','commonjs'],['native-inside',pathToFileURL(root+'/injected.node').href,'addon'],['native-outside','file:///outside/addon.node','addon'],['data','data:text/javascript,private','module'],['query',pathToFileURL(root+'/owned.js').href+'?private','commonjs'],['node-unknown','node:unknown','builtin']] as const)test('resolved code is rejected before load: '+name,()=>{
    const f=fixture(),g=f.create();try{f.call('injected',caller,()=>({url,format}));}catch{}
    assert.equal(g.snapshot().failed,true);assert.equal(f.exitCode,1);assert.throws(()=>g.assertActive(root));assert.equal(f.deregisters,0);
    assert.equal(JSON.stringify(g.snapshot()).includes('private'),true); // Only fixed schema includes private; no untrusted URL.
    assert.ok(!JSON.stringify(g.snapshot()).includes(url));
});
test('genuine default missing-module error is preserved and loads no substitute module',()=>{
    const f=fixture(),g=f.create(),original=Object.assign(Error('authored missing module'),{code:'MODULE_NOT_FOUND'});
    assert.throws(()=>f.call('./crypto/build/Release/sshcrypto.node',caller,()=>{throw original;}),(e:any)=>e===original);assert.equal(g.snapshot().missing,1);assert.equal(g.snapshot().failed,false);g.assertActive(root);
});
test('late nonbuiltin lookup cannot outlive an already captured success readiness snapshot',()=>{
    const f=fixture(),g=f.create();f.call('fs',caller,()=>({url:'node:fs',format:'builtin'}));const prior=g.prepareClose(root);validateContainment(prior,true);let delegated=false;
    try{f.call('./late.js',caller,()=>{delegated=true;return{url:pathToFileURL(root+'/late.js').href,format:'commonjs'};});}catch{}
    assert.equal(delegated,false);assert.equal(f.exitCode,1);assert.equal(g.snapshot().failed,true);assert.throws(()=>g.assertClosePrepared(root));g.assertClosePrepared(root,true);assert.equal(f.deregisters,0);
});
for(const kind of ['throw','missing','promise','thenable','proxy','reentrant'])test('unknown registration outcome owns a liveness fence before bundle load: '+kind,()=>{
    let touches=0;const options:any=kind==='throw'?{registrationThrow:true}:kind==='reentrant'?{reentrant:true}:{registrationReturn:kind==='missing'?null:kind==='promise'?Promise.resolve({}):kind==='proxy'?new Proxy({},{get(){touches++;throw Error('proxy touched');}}):{deregister(){},get then(){touches++;return()=>{};}}};
    const f=fixture(options);assert.throws(f.create,(e:any)=>{assert.equal(e.owner.snapshot().uncertain,true);return true;});assert.equal(f.holds,1);assert.equal(f.exitCode,1);assert.equal(touches,0);assert.equal(f.deregisters,0);
});
for(const kind of ['promise','thenable','proxy','accessor'])test('unsupported resolution return cannot be treated as synchronous completion: '+kind,()=>{
    let touched=0;const value:any=kind==='promise'?Promise.resolve({url:'file:///outside/late.js'}):kind==='proxy'?new Proxy({},{get(){touched++;throw Error('proxy touched');}}):kind==='accessor'?{get url(){touched++;return'file:///outside/late.js';}}:{then(){touched++;},url:'file:///outside/late.js'};
    const f=fixture(),g=f.create();assert.throws(()=>f.call('./bad',caller,()=>value));assert.equal(g.snapshot().failed,true);assert.equal(touched,0);assert.throws(()=>g.prepareClose(root));
    if(kind!=='accessor'){assert.equal(g.snapshot().uncertain,true);assert.equal(g.snapshot().inFlight,1);assert.equal(f.holds,1);}
});
for(const kind of ['builtin-throw','builtin-promise','notify-throw','notify-promise'])test('unknown supporting API acknowledgement keeps liveness: '+kind,()=>{
    const options:any=kind==='builtin-throw'?{builtinThrow:true}:kind==='builtin-promise'?{builtinReturn:Promise.reject(Error('authored API rejection'))}:kind==='notify-throw'?{notifyThrow:true}:{notifyReturn:Promise.reject(Error('authored notify rejection'))};
    const f=fixture(options),g=f.create();assert.throws(()=>f.call('./foreign',caller,()=>({url:'file:///outside/foreign.js',format:'commonjs'})));assert.equal(g.snapshot().uncertain,true);assert.equal(f.holds,1);assert.equal(f.exitCode,1);assert.throws(()=>g.prepareClose(root));
});
test('close preparation cannot race an active resolve callback',()=>{
    const f=fixture(),g=f.create();f.call('./owned',caller,()=>{assert.throws(()=>g.prepareClose(root));return{url:pathToFileURL(root+'/owned.js').href,format:'commonjs'};});validateContainment(g.prepareClose(root),true);assert.throws(()=>g.prepareClose(root));
});
test('readiness schema cannot be relabelled as retirement or accept unknown counters/flags',()=>{
    const f=fixture(),g=f.create();f.call('fs',caller,()=>({url:'node:fs',format:'builtin'}));const r=g.prepareClose(root);
    for(const mutate of [(v:any)=>v.hookRetired=true,(v:any)=>v.registered=false,(v:any)=>v.closePrepared=1,(v:any)=>v.inFlight=1,(v:any)=>v.optionalCpuBlocked=2,(v:any)=>v.policy='global-allow',(v:any)=>v.releaseAcceptance=true]){const v=structuredClone(r);mutate(v);assert.throws(()=>validateContainment(v,true));}
});
test('native activation installs guard before product require and never deregisters it',()=>{
    const s=readFileSync(new URL('./fixtures/instrumented-gateway-activate.cjs',import.meta.url),'utf8');
    const verify=(text:string)=>assert.ok(text.indexOf('createInstrumentedResolutionGuard(__dirname')>=0&&text.indexOf('createInstrumentedResolutionGuard(__dirname')<text.indexOf("require('./ownership.cjs')"));verify(s);assert.throws(()=>verify(s.replace('createInstrumentedResolutionGuard(__dirname','createLater(__dirname')));assert.ok(!s.includes('.deregister('));assert.ok(s.includes('uncertainHold ??= setInterval'));
});

for(const sealed of [false,true])test('builtin requests cannot return file-backed code, sealed='+sealed,()=>{
    const f=fixture(),g=f.create();if(sealed){f.call('fs',caller,()=>({url:'node:fs',format:'builtin'}));g.prepareClose(root);}
    assert.throws(()=>f.call('fs',caller,()=>({url:pathToFileURL(root+'/injected.js').href,format:'commonjs'})));assert.equal(g.snapshot().violationCode,'builtin-mismatch');assert.equal(f.exitCode,1);
});
test('unexpected caller accessors and builtin-missing contradictions cannot hide inside dependency catches',()=>{
    const f=fixture(),g=f.create();assert.throws(()=>f.call('fs',caller,()=>{throw Object.assign(Error('contradictory builtin absence'),{code:'MODULE_NOT_FOUND'});}));assert.equal(g.snapshot().failed,true);
});

test('CPU caller accessor is not invoked or treated as intentional omission',()=>{
    const f=fixture(),g=f.create();let touched=0;const context={get parentURL(){touched++;return caller;}};
    assert.throws(()=>f.raw('cpu-features',context,()=>({url:'file:///outside/cpu.js'})));assert.equal(touched,0);assert.equal(g.snapshot().failed,true);assert.equal(g.snapshot().optionalCpuBlocked,0);
});
for(const malformed of [false,true])test('actual activation catches unknown registration before product require, malformed='+malformed,()=>{
    const source=readFileSync(new URL('./fixtures/instrumented-gateway-activate.cjs',import.meta.url),'utf8');let holds=0,product=0;const module={},process:any={argv:['/tools/node',root+'/activate.cjs','/checkout/validation/gateway-ownership/child-input-compatibility.json'],platform:'linux',arch:'x64',version:'v24.22.0',env:{}};
    const require:any=(s:string)=>{if(s==='node:assert/strict')return assert;if(s==='node:path')return{join:(...a:string[])=>a.join('/').replace('/instrumented/..','')};if(s==='node:module')return{registerHooks(){if(malformed)return{};throw Error('authored registration throw');},isBuiltin:()=>false};if(s==='./resolution-guard.cjs')return guardModule;product++;throw Error('product must not load');};require.main=module;
    assert.doesNotThrow(()=>runInNewContext('process.execArgv=[];\n'+source,{module,process,require,__dirname:root,__filename:root+'/activate.cjs',setInterval(){holds++;return{owned:true};}},{timeout:1000}));assert.equal(holds,1);assert.equal(product,0);assert.equal(process.exitCode,1);
});

test('guard keeps its original native acknowledgement ports after caller replacement',()=>{
    const f=fixture(),g=f.create();f.ports.onViolation=()=>undefined;f.ports.onUncertain=()=>undefined;
    assert.throws(()=>f.call('./outside',caller,()=>({url:'file:///outside/replaced.js',format:'commonjs'})));assert.equal(f.exitCode,1);assert.equal(f.violations,1);assert.equal(g.snapshot().failed,true);
});

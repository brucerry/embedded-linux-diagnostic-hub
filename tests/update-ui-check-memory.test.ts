import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file="src/features/updates/UpdateModal.tsx";
const source=readFileSync(file,'utf8');
const readInfo=source.slice(source.indexOf('    const readInfo = async () => {'),source.indexOf('    const determinate ='));
const check=source.slice(source.indexOf('    async function check(include: boolean) {'),source.indexOf('    useEffect(() => {\n        void check(true);'));
assert.ok(readInfo.startsWith('    const readInfo =') && check.endsWith('    }\n'));
function fixture(){
 const state={busy:false,error:'',infoError:'',status:null as unknown,info:null as unknown,progress:null as unknown};
 let finish!:()=>void;const gate=new Promise<void>(yes=>finish=yes);let requests=0,infos=0;
 const bridge={readUpdateInfo:async()=>{infos++;return {currentVersion:'synthetic'};},checkUpdates:async(include:boolean)=>{requests++;if(requests>1)throw Error('An update operation is already running.');await gate;return {release:{version:include?'0.2.0':'0.3.0'}};}};
 const checking={current:false},infoRead={current:0};
 const fn= new Function('bridge','setBusy','setError','setInfo','setInfoError','setStatus','setProgress','message','checking','infoRead',readInfo+check.replace('include: boolean','include')+'return check;')(bridge,(v:boolean)=>state.busy=v,(v:string)=>state.error=v,(v:unknown)=>state.info=v,(v:string)=>state.infoError=v,(v:unknown)=>state.status=v,(v:unknown)=>state.progress=v,(e:Error)=>e.message,checking,infoRead) as (include:boolean)=>Promise<void>;
 return {state,fn,bridge,finish,get requests(){return requests;},get infos(){return infos;},checking};
}
async function turns(){for(let n=0;n<16;n++)await Promise.resolve();}
test('replayed pending release check keeps one owner and does not publish a duplicate error or stale result',async()=>{
 const f=fixture();const first=f.fn(true),second=f.fn(true),changed=f.fn(false);
 try{await turns();await Promise.all([second,changed]);assert.equal(f.requests,1);assert.equal(f.infos,1);assert.equal(f.state.busy,true);assert.equal(f.checking.current,true);assert.equal(f.state.error,'');assert.equal(f.state.status,null);}
 finally{f.finish();await first;}
 assert.equal(f.state.busy,false);assert.equal(f.checking.current,false);assert.deepEqual(f.state.status,{release:{version:'0.2.0'}});
});
test('failed check retains its diagnostic and permits a later explicit successful selection',async()=>{
 const f=fixture();f.bridge.checkUpdates=async()=>{throw Error('Original check failure');};
 await f.fn(true);assert.equal(f.state.error,'Original check failure');assert.equal(f.state.busy,false);assert.equal(f.checking.current,false);
 f.bridge.checkUpdates=async(include)=>({release:{version:include?'0.2.0':'0.3.0'}});
 await f.fn(false);assert.equal(f.state.error,'');assert.deepEqual(f.state.status,{release:{version:'0.3.0'}});assert.equal(f.checking.current,false);assert.equal(f.state.busy,false);
});
test('location-read failure remains separate and does not strand check admission',async()=>{
 const f=fixture();f.bridge.readUpdateInfo=async()=>{throw Error('Original location failure');};const pending=f.fn(true);
 try{await turns();assert.equal(f.state.busy,true);assert.equal(f.state.infoError,'Original location failure');assert.equal(f.state.error,'');assert.equal(f.requests,1);}
 finally{f.finish();await pending;}
 assert.equal(f.state.busy,false);assert.equal(f.checking.current,false);assert.equal(f.state.infoError,'Original location failure');assert.deepEqual(f.state.status,{release:{version:'0.2.0'}});
});

const marker='                        onClick={async () => {';
const begin=source.indexOf(marker),end=source.indexOf('                        }}',begin);
assert.ok(begin>0&&end>begin&&readInfo.startsWith('    const readInfo =')&&check.endsWith('    }\n'));
const startBody=source.slice(begin+marker.length,end);
function deferred(){let resolve!:(value:unknown)=>void;let reject!:(error:Error)=>void;const promise=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function snapshotFixture(){
 assert.match(source,/const infoRead = useRef\(0\);/);
 const state={busy:false,error:'',infoError:'',info:null as unknown,status:null as unknown,progress:null as unknown};
 const responses:(()=>Promise<unknown>)[]=[];let reads=0;
 const bridge={readUpdateInfo:async()=>{assert.ok(++reads<=4);const next=responses.shift();assert.ok(next);return next();},checkUpdates:async(include:boolean)=>({release:{version:include?'0.2.0':'0.3.0'}}),startUpdate:async()=>{throw Error('Original start failure');}};
 const checking={current:false},infoRead={current:0};
 const fn=new Function('bridge','setBusy','setError','setInfo','setInfoError','setStatus','setProgress','message','checking','infoRead','onStart','mode','snapshot',readInfo+check.replace('include: boolean','include')+'const start=async()=>{'+startBody+'};return {check,start,readInfo};')(bridge,(v:boolean)=>state.busy=v,(v:string)=>state.error=v,(v:unknown)=>state.info=v,(v:string)=>state.infoError=v,(v:unknown)=>state.status=v,(v:unknown)=>state.progress=v,(e:Error)=>e.message,checking,infoRead,()=>{},'clean',null) as {check(include:boolean):Promise<void>;start():Promise<void>;readInfo():Promise<void>};
 return {state,responses,fn,checking,infoRead,get reads(){return reads;}};
}
test('failed-start location refresh cannot overwrite a newer successful check snapshot',async()=>{
 const f=snapshotFixture(),old=deferred();f.responses.push(()=>old.promise,async()=>({source:'newer'}));const start=f.fn.start();let check:Promise<void>|undefined;
 try{await turns();assert.equal(f.state.busy,false);assert.equal(f.state.error,'Original start failure');check=f.fn.check(true);await check;assert.deepEqual(f.state.info,{source:'newer'});old.resolve({source:'older'});await start;assert.deepEqual(f.state.info,{source:'newer'});assert.equal(f.state.infoError,'');assert.equal(f.state.error,'');assert.equal(f.state.busy,false);assert.equal(f.checking.current,false);}
 finally{old.resolve({source:'older'});await Promise.allSettled([start,...(check?[check]:[])]);}
});
test('late older location error cannot replace a newer successful check snapshot or diagnostic',async()=>{
 const f=snapshotFixture(),old=deferred();f.responses.push(()=>old.promise,async()=>({source:'newer'}));const start=f.fn.start();let check:Promise<void>|undefined;
 try{await turns();check=f.fn.check(true);await check;old.reject(Error('Stale location failure'));await start;assert.deepEqual(f.state.info,{source:'newer'});assert.equal(f.state.infoError,'');assert.equal(f.state.error,'');assert.equal(f.state.busy,false);}
 finally{old.resolve({source:'older'});await Promise.allSettled([start,...(check?[check]:[])]);}
});
test('late older location success cannot clear the latest genuine location failure',async()=>{
 const f=snapshotFixture(),old=deferred();f.responses.push(()=>old.promise,async()=>{throw Error('Current location failure');});const start=f.fn.start();let check:Promise<void>|undefined;
 try{await turns();check=f.fn.check(false);await check;assert.equal(f.state.infoError,'Current location failure');old.resolve({source:'older'});await start;assert.equal(f.state.info,null);assert.equal(f.state.infoError,'Current location failure');assert.deepEqual(f.state.status,{release:{version:'0.3.0'}});assert.equal(f.state.error,'');assert.equal(f.state.busy,false);}
 finally{old.resolve({source:'older'});await Promise.allSettled([start,...(check?[check]:[])]);}
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { createLoopbackDiagnostics, sanitizeLoopbackDiagnostics } from './ui/fixtures/loopback-diagnostics';
import { installLoopbackPassiveObserver } from './ui/fixtures/loopback-passive-observer';

class Events {
    listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(name: string, fn: (...args: any[]) => void) { let set=this.listeners.get(name); if(!set)this.listeners.set(name,set=new Set());set.add(fn);return this; }
    off(name: string, fn: (...args: any[]) => void) {this.listeners.get(name)?.delete(fn);return this;}
    emit(name: string, value?: unknown) {for(const fn of [...this.listeners.get(name)??[]])fn(value);}
}
class FakeWorker extends Events {
    url() {return 'http://127.0.0.1:5200/src/services/history.worker.ts?worker_file&type=module';}
}
const gateway='http://127.0.0.1:8888',app='http://127.0.0.1:5200';
const response=(status=200,promise:Promise<null|Error>=Promise.resolve(null),url=gateway+'/api/sessions/'+'a'.repeat(32)+'/snapshot',method='POST')=>({
    url:()=>url,status:()=>status,request:()=>({method:()=>method}),finished:()=>promise,
    body:()=>{throw Error('SECRET_BODY_MUST_NOT_BE_READ');},headers:()=>{throw Error('SECRET_HEADERS_MUST_NOT_BE_READ');},
});
const pump=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('passive loopback metadata remains bounded, sanitized and fenced after detachment',async()=>{
    const checks:string[]=[];
    const make=()=>{const page=new Events(),diag=createLoopbackDiagnostics();const observer=installLoopbackPassiveObserver(page as unknown as Page,app,gateway,diag);return {page,diag,observer};};
    {
        const {page,diag,observer}=make();page.emit('response',response(200));await pump();observer.stop();
        const p=diag.snapshot().passive;assert.equal(p.counts['snapshot-status-2xx'],1);assert.equal(p.counts['snapshot-finished'],1);assert.equal(p.failed,false);assert.equal(p.stopped,true);
        checks.push('status class and completion without reading bodies or headers');
    }
    {
        const {page,diag,observer}=make();page.emit('response',response(503,Promise.resolve(Error('SECRET_ERROR'))));
        page.emit('response',response(404,Promise.reject(Error('SECRET_REJECTION'))));await pump();observer.stop();
        const p=diag.snapshot().passive;assert.equal(p.counts['snapshot-status-5xx'],1);assert.equal(p.counts['snapshot-status-4xx'],1);assert.equal(p.counts['snapshot-finish-failed'],2);
        assert.equal(JSON.stringify(diag.snapshot()).includes('SECRET'),false);
        checks.push('failure is a fixed counter, never error text');
    }
    {
        const {page,diag,observer}=make();
        for(const [url,method] of [[gateway+'/api/sessions/'+'b'.repeat(32)+'/snapshot?SECRET=query','POST'],[app+'/api/sessions/'+'a'.repeat(32)+'/snapshot','POST'],[gateway+'/api/sessions/'+'a'.repeat(32)+'/snapshot','GET'],[gateway+'/api/sessions/short/snapshot','POST']])page.emit('response',response(200,Promise.resolve(null),url,method));
        await pump();observer.stop();assert.equal(diag.snapshot().stages.length,0);
        checks.push('only exact owned POST snapshot responses are observed');
    }
    {
        const {page,diag,observer}=make(),worker=new FakeWorker();page.emit('worker',worker);page.emit('worker',worker);worker.emit('close');worker.emit('close');observer.stop();
        const p=diag.snapshot().passive;assert.equal(p.counts['history-worker-created'],1);assert.equal(p.counts['history-worker-closed'],1);
        assert.equal('validHistory' in p,false);assert.equal(JSON.stringify(p).includes('/src/'),false);
        checks.push('fixed worker identity only; close is not valid-history evidence');
    }
    {
        const {page,diag,observer}=make(),wrong=new FakeWorker();wrong.url=()=>app+'/SECRET_OTHER_WORKER';page.emit('worker',wrong);observer.stop();assert.equal(diag.snapshot().stages.length,0);
        checks.push('other workers and their URLs are omitted');
    }
    {
        const {page,diag,observer}=make();let resolve!:(value:null)=>void;
        const held=new Promise<null>(r=>{resolve=r;});page.emit('response',response(200,held));observer.stop();
        const before=diag.snapshot();assert.equal(before.passive.failed,true);resolve(null);await pump();assert.deepEqual(diag.snapshot(),before);
        checks.push('pending observation fails closed and late completion cannot mutate detached evidence');
    }
    {
        const page=new Events(),diag=createLoopbackDiagnostics(),worker=new FakeWorker(),foreign=()=>{};
        page.on('worker',foreign);page.on('response',foreign);worker.on('close',foreign);
        const observer=installLoopbackPassiveObserver(page as unknown as Page,app,gateway,diag);page.emit('worker',worker);observer.stop();observer.stop();
        assert.deepEqual([...page.listeners.get('worker')!],[foreign]);assert.deepEqual([...page.listeners.get('response')!],[foreign]);assert.deepEqual([...worker.listeners.get('close')!],[foreign]);
        checks.push('detaches only its listeners and preserves existing subscribers');
    }
    {
        const {page,diag,observer}=make();for(let i=0;i<33;i++)page.emit('worker',new FakeWorker());observer.stop();
        assert.equal(diag.snapshot().overflow,true);assert.equal(diag.snapshot().stages.length,32);
        assert.equal(diag.snapshot().passive.counts['history-worker-created'],32);
        checks.push('32 admissions and event cap refuse silent truncation');
    }
    {
        const {diag,observer}=make();observer.stop();const s=diag.snapshot();
        assert.deepEqual(sanitizeLoopbackDiagnostics({...s,passive:{...s.passive,SECRET:'discard'}}),s);
        assert.equal(sanitizeLoopbackDiagnostics({...s,passive:{...s.passive,failed:'false'}}),null);
        assert.equal(sanitizeLoopbackDiagnostics({...s,passive:{...s.passive,counts:{...s.passive.counts,'snapshot-finished':Infinity}}}),null);
        assert.ok(Buffer.byteLength(JSON.stringify(s))<8192);
        checks.push('receipt projection validates flags and counters and drops unknown fields');
    }
    const source=readFileSync(path.join(__dirname,'ui/loopback-console.spec.ts'),'utf8');
    assert.ok(source.indexOf('passive = installLoopbackPassiveObserver')<source.indexOf('await connect(page, gateway, owner)'));
    assert.ok(source.indexOf('await owner.close()')<source.indexOf('passive?.stop()'));
    assert.ok(source.indexOf('passive?.stop()')<source.indexOf("info.attach('loopback-owned-summary'"));
    checks.push('actual spec installs before Connect and detaches before final attachment');
    console.log(JSON.stringify({status:'passed',checks,count:checks.length,browserNetworkWorkers:false}));
});

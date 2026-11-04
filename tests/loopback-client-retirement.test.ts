import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClientRetirement, loopbackListening } from './ui/fixtures/loopback-client-retirement';

class Client {
    listeners: (()=>void)[]=[];
    once(_event:'close',listener:()=>void){this.listeners.push(listener);return this;}
    close(){const list=this.listeners.splice(0);for(const fn of list)fn();}
}
const checks:string[]=[];
const ledger=createClientRetirement(), a=new Client();
const first=ledger.track(a);assert.equal(ledger.track(a),first);assert.equal(ledger.pending,1);
checks.push('duplicate registration retains exact owner');
let settled=false;const join=ledger.join().then(()=>{settled=true;});
await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
checks.push('server callback or microtask progress cannot acknowledge client');
a.close();await join;assert.equal(settled,true);assert.equal(ledger.pending,0);
checks.push('actual client callback acknowledges retirement');
const b=new Client(),c=new Client();ledger.track(b);ledger.track(c);settled=false;
const both=ledger.join().then(()=>{settled=true;});b.close();await Promise.resolve();assert.equal(settled,false);
c.close();await both;assert.equal(ledger.pending,0);
checks.push('all admitted clients join without early release');
const reusable=new Client();ledger.track(reusable);const stale=reusable.listeners[0];reusable.close();
ledger.track(reusable);stale();assert.equal(ledger.pending,1);reusable.close();await ledger.join();
checks.push('stale callback cannot retire a different admission');
const broken={once(_event:'close',_callback:()=>void){throw Error('registration-failed');}};
const retained=createClientRetirement();assert.throws(()=>retained.track(broken),/registration-failed/);
assert.equal(retained.pending,1); // No fake acknowledgement or forced disposition.
checks.push('observer registration failure preserves unproved custody');
assert.equal(loopbackListening(),false);assert.equal(loopbackListening({address:()=>null}),false);
assert.equal(loopbackListening({address:()=>({address:'127.0.0.1',port:1234})}),true);
checks.push('listener evidence uses supported address API');
const fixture=readFileSync(new URL('./ui/fixtures/loopback-console-gateway.ts',import.meta.url),'utf8');
assert.ok(fixture.includes('clientRetirement.track(client);'));
assert.ok(fixture.indexOf('const results = await Promise.allSettled(tasks);') < fixture.indexOf('await clientRetirement.join();'));
assert.ok(fixture.indexOf('await clientRetirement.join();') < fixture.indexOf('if (clients.size || state.fileHandles'));
assert.ok(fixture.includes("diagnostics.cleanupFailure(snapshot(), ['retirement-rejected']);"));
assert.ok(fixture.includes('if (closeTask) return closeTask;'));
assert.ok(fixture.includes("throw new AggregateError(errors, 'Loopback fixture cleanup failed; no retry or forced disposition.')"));
checks.push('actual fixture joins after server acknowledgements and preserves error/failure gates');
console.log(JSON.stringify({status:'passed',checks,count:checks.length,realTimersOrSSH:false}));

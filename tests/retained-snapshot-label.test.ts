import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';
interface Context {snapshot:{username:string;endpoint:string;mode:'ssh'|'demo'}|null;connected:boolean;imported:boolean;bridge:object|null;activeDevice:{username:string;endpoint:string}|null;live:boolean;interval:number;}
const span="{!snapshot\n                                            ? connected\n                                                ? 'SSH connected \u00b7 current record cleared.'\n                                                : 'Connect your target device to collect diagnostics, or import a saved report.'\n                                            : imported\n                                              ? `Historical ${snapshot.mode === 'demo' ? 'sample' : 'SSH'} evidence opened locally. No device connection or upload.`\n                                              : `Retained snapshot: ${snapshot.username}@${snapshot.endpoint} \u00b7 ${connected ? `${bridge ? 'Direct' : 'Gateway'} SSH connected to ${activeDevice ? `${activeDevice.username}@${activeDevice.endpoint}` : 'the current target'}. ${live ? `Live updates every ${interval}s after collection.` : 'Live updates paused.'}` : 'SSH disconnected. Showing the last accepted snapshot.'}`}";
const source=readFileSync('src/app/App.tsx','utf8');assert.ok(source.includes(span));assert.ok(readFileSync('src/pages/OverviewPage.tsx','utf8').includes("<span>Snapshot: {snapshot?.endpoint ?? '—'}</span>"));
function label({snapshot,connected,imported,bridge,activeDevice,live,interval}:Context){return !snapshot
                                            ? connected
                                                ? 'SSH connected · current record cleared.'
                                                : 'Connect your target device to collect diagnostics, or import a saved report.'
                                            : imported
                                              ? `Historical ${snapshot.mode === 'demo' ? 'sample' : 'SSH'} evidence opened locally. No device connection or upload.`
                                              : `Retained snapshot: ${snapshot.username}@${snapshot.endpoint} · ${connected ? `${bridge ? 'Direct' : 'Gateway'} SSH connected to ${activeDevice ? `${activeDevice.username}@${activeDevice.endpoint}` : 'the current target'}. ${live ? `Live updates every ${interval}s after collection.` : 'Live updates paused.'}` : 'SSH disconnected. Showing the last accepted snapshot.'}`;}
test('actual banner expression separates retained evidence and current target across supported contexts',()=>{
 const a={username:'snapshot-user',endpoint:'A.invalid:22',mode:'ssh' as const};const b={username:'connected-user',endpoint:'B.invalid:2222'};
 const base:Context={snapshot:a,connected:true,imported:false,bridge:{},activeDevice:b,live:false,interval:30};const before=JSON.stringify(base);
 assert.equal(label(base),'Retained snapshot: snapshot-user@A.invalid:22 · Direct SSH connected to connected-user@B.invalid:2222. Live updates paused.');
 assert.equal(label({...base,activeDevice:{username:a.username,endpoint:a.endpoint},live:true}),'Retained snapshot: snapshot-user@A.invalid:22 · Direct SSH connected to snapshot-user@A.invalid:22. Live updates every 30s after collection.');
 assert.equal(label({...base,connected:false}),'Retained snapshot: snapshot-user@A.invalid:22 · SSH disconnected. Showing the last accepted snapshot.');
 assert.equal(label({...base,bridge:null}),'Retained snapshot: snapshot-user@A.invalid:22 · Gateway SSH connected to connected-user@B.invalid:2222. Live updates paused.');
 assert.equal(label({...base,activeDevice:null}),'Retained snapshot: snapshot-user@A.invalid:22 · Direct SSH connected to the current target. Live updates paused.');
 assert.equal(label({...base,imported:true}),'Historical SSH evidence opened locally. No device connection or upload.');
 assert.equal(label({...base,snapshot:null}),'SSH connected · current record cleared.');assert.equal(label({...base,snapshot:null,connected:false}),'Connect your target device to collect diagnostics, or import a saved report.');assert.equal(JSON.stringify(base),before);
});

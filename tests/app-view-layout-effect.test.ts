import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFileSync} from 'node:fs';
import {currentLayoutEffect,beforeLayoutEffect,currentSpan,guardInitializer,type EffectContext} from './fixtures/app-view-layout-effect';
import {createLaunchTimingRecorder} from '../shared/launch-timing';
const source=readFileSync('src/app/App.tsx','utf8');
assert.equal(source.includes(currentSpan),true,'Verbatim effect drifted; regenerate only after source review.');
assert.equal(source.includes(guardInitializer),true,'Guard must start from the actual initial view, not a first-effect boolean.');
const keys=['setTimeout','clearTimeout','setInterval','clearInterval'] as const;
const timers=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
after(()=>keys.forEach((k,i)=>assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,k),timers[i])));
function fixture(initialAnimation=''){
 let animation=initialAnimation,reads=0,samples=0,markerCalls=0;
 const events:string[]=[];const recorder=createLaunchTimingRecorder('renderer-navigation',()=>++samples,0);
 const context:EffectContext={view:'overview',lastTransitionView:{current:'overview'},workspaceMain:{current:{style:{get animation(){return animation;},set animation(v:string){events.push('animation:'+v);animation=v;}},get offsetWidth(){reads++;events.push('geometry');assert.equal(animation,'none');return 100;}}},markRendererAppLayoutEffect(){markerCalls++;events.push('marker');recorder.mark('renderer-app-layout-effect');}};
 return{context,events,recorder,get animation(){return animation;},get reads(){return reads;},get markerCalls(){return markerCalls;},get samples(){return samples;}};
}
test('initial and same-view App effect replay skip geometry/style work while retaining the marker',()=>{
 // An existing inline animation value is also left alone; this is not CSS media-query simulation.
 for(const initial of ['', 'none']){
  const before=fixture(initial);beforeLayoutEffect(before.context);beforeLayoutEffect(before.context);assert.equal(before.reads,2);assert.equal(before.events.filter(e=>e.startsWith('animation:')).length,4);
  const current=fixture(initial);currentLayoutEffect(current.context);currentLayoutEffect(current.context);
  assert.equal(current.reads,0);assert.deepEqual(current.events,['marker','marker']);assert.equal(current.animation,initial);assert.equal(current.markerCalls,2);assert.equal(current.samples,1);
  assert.deepEqual(current.recorder.snapshot(),before.recorder.snapshot());assert.equal(current.context.lastTransitionView.current,'overview');
 }
});
test('real committed view changes retain one animation replay without duplicate same-view reads',()=>{
 const f=fixture();currentLayoutEffect(f.context);f.events.length=0;
 for(const view of ['serial','overview'] as const){
  f.context.view=view;currentLayoutEffect(f.context);assert.equal(f.context.lastTransitionView.current,view);
  assert.deepEqual(f.events,['marker','animation:none','geometry','animation:']);f.events.length=0;
  currentLayoutEffect(f.context);assert.deepEqual(f.events,['marker']);f.events.length=0;
 }
 assert.equal(f.reads,2);assert.equal(f.animation,'');assert.equal(f.markerCalls,5);assert.equal(f.recorder.snapshot().milestones.length,1);
});

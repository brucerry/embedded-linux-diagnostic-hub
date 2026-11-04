import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { NetworkCollector } from '../backend/ssh/network';
import { probes } from '../shared/diagnostics/probes';
import { demoSnapshot } from './fixtures/snapshots';
import { consoleFixture } from './fixtures/ssh-console';

// Same finite snapshot loop and fixture selector; no generated command is executed.
test('one loopback diagnostic snapshot has a finite 36-primary and 16-auxiliary fan-out', async () => {
    const data=demoSnapshot(), collector=new NetworkCollector(), model=consoleFixture({fragment:4});
    const calls:{id:string;primary:boolean}[]=[];
    const fakeChannel=new Proxy({}, {get(){throw Error('Probe must not enter the console command implementation.');}});
    const fixture=readFileSync(path.join(__dirname,'ui/fixtures/loopback-console-gateway.ts'),'utf8');
    assert.ok(fixture.includes('const probe = probes.find((item) => info.command.endsWith(item.command));'));
    assert.ok(fixture.includes('const result = data.results.find((item) => item.id === probe?.id);'));
    const execute=async(id:string,command:string) => {
        const prefixed='export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; '+command;
        assert.equal(model.exec(prefixed,fakeChannel as never),false);
        const probe=probes.find(item=>prefixed.endsWith(item.command));
        const result=data.results.find(item=>item.id===probe?.id);
        calls.push({id,primary:probes.some(item=>item.id===id)});
        return {id,command:prefixed,stdout:result?.stdout??'',stderr:result?.stderr??'',
            status:result ? result.status : 'unavailable' as const,exitCode:result?.exitCode??127,
            durationMs:0,collectedAt:data.capturedAt,truncated:false};
    };
    const results=[];
    for(let index=0;index<probes.length;index+=3)
        results.push(...await Promise.all(probes.slice(index,index+3).map(probe=>collector.collect(probe,execute))));
    assert.equal(results.length,probes.length);assert.equal(calls.filter(x=>x.primary).length,probes.length);
    assert.equal(calls.length,52);
    assert.equal(model.state.execs.length,0);
    console.log(JSON.stringify({status:'passed',primaryResults:results.length,totalExecutions:calls.length,
        auxiliaryExecutions:calls.length-probes.length,complete:true,generatedCommandsExecuted:false,
        limits:'Immediate fake exec acknowledgements only; not SSH timing or renderer/history-worker completion.'}));
});

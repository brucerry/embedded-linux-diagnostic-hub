import test from 'node:test';import assert from 'node:assert/strict';
import { parseReport } from '../shared/report';import { lanSummary } from '../shared/diagnostics/network/lan';
const at='2028-02-29T12:00:00Z',huge='9'.repeat(400);
function fixture(index:unknown,text=false){
 const probe=(id:string,stdout='')=>({id,stdout,stderr:'',exitCode:0,status:'collected',durationMs:1,collectedAt:at,truncated:false});
 const section=(id:string,operation:string,stdout:string)=>({...probe(id,stdout),operation,scope:'all',source:'live',command:'synthetic'});
 return parseReport(JSON.stringify({schemaVersion:1,mode:'demo',endpoint:'synthetic.invalid',username:'fixture',capturedAt:at,results:[{...probe('ethernet'),networkEvidence:{version:1,sections:[section('links',text?'ip-link-text':'ip-link-json',text?String(index)+': eth0: <UP> mtu 1500 state UP\n':JSON.stringify([{ifname:'eth0',ifindex:7,flags:['UP'],mtu:1500}]))],omissions:[]}},{...probe('interfaces'),networkEvidence:{version:1,sections:text?[]:[section('addresses','ip-address-json',JSON.stringify([{ifname:'eth0',ifindex:index,addr_info:[{local:'192.0.2.99',family:'inet',prefixlen:24}]}]))],omissions:[]}}]}));
}
test('invalid explicit LAN indices cannot create identities or attach addresses to a valid sibling',()=>{
 for(const value of [huge,'9007199254740993','-7','+7','1e309','7junk',null,[],{},1.5]) {
  const snapshot=fixture(value),before=JSON.stringify(snapshot),model=lanSummary(snapshot);
  const iface=model.interfaces.find(i=>i.ifindex===7)!;assert.ok(iface);
  assert.equal(iface.groups.some(g=>g.fields.some(f=>f.value==='192.0.2.99/24')),false);
  assert.ok(model.warnings.some(w=>w.includes('interface index could not be interpreted')));
  assert.equal(JSON.stringify(snapshot),before);
  const legacy=fixture(7);legacy.results.find(r=>r.id==='interfaces')!.networkEvidence!.sections=[];
  legacy.results.find(r=>r.id==='interfaces')!.stdout=String(value)+': eth0: <UP> mtu 1500 state UP\n    inet 192.0.2.99/24\n';
  assert.equal(lanSummary(legacy).interfaces[0].groups.some(g=>g.fields.some(f=>f.value.includes('192.0.2.99'))),false);
 }
});
test('text link indices reject oversized or malformed whole tokens without consuming another interface details',()=>{
 for(const value of [huge,'9007199254740993','-7','+7','1e309','7junk']) {
  const snapshot=fixture(value,true),before=JSON.stringify(snapshot),model=lanSummary(snapshot);
  assert.equal(model.interfaces.length,0);assert.ok(model.warnings.length>0);assert.equal(JSON.stringify(snapshot),before);
 }
 const snapshot=fixture('7',true);const result=snapshot.results.find(r=>r.id==='ethernet')!;
 result.networkEvidence!.sections[0].stdout += 'bad: eth1: <UP> mtu 9000 state UP\n  forbidden detail\n';
 const model=lanSummary(snapshot);assert.equal(model.interfaces.length,1);assert.equal(model.interfaces[0].ifindex,7);
 assert.equal(model.interfaces[0].groups.some(g=>g.fields.some(f=>f.value.includes('forbidden detail'))),false);
});
test('ordinary ip identity and raw ethtool/MTU/counter formats retain their separate contracts',()=>{
 const snapshot=fixture(7),result=snapshot.results.find(r=>r.id==='ethernet')!;
 const section=result.networkEvidence!.sections[0];section.stdout=section.stdout.replace('"mtu":1500','"mtu":1500,"stats64":{"rx":{"bytes":18446744073709551615}}');
 result.networkEvidence!.sections.push({...section,id:'speed',operation:'ethtool',scope:'eth0',stdout:'Speed: 1000Mb/s\nDuplex: Full\n'});
 const before=JSON.stringify(snapshot),model=lanSummary(snapshot),iface=model.interfaces[0];
 assert.equal(iface.ifindex,7);assert.equal(iface.mtu,'1500');assert.deepEqual(model.warnings,[]);
 const fields=iface.groups.flatMap(g=>g.fields);assert.ok(fields.some(f=>f.value==='18446744073709551615'));assert.ok(fields.some(f=>f.value==='1000Mb/s'));assert.ok(fields.some(f=>f.value==='192.0.2.99/24'));
 assert.equal(JSON.stringify(snapshot),before);
 const text=lanSummary(fixture('7',true)).interfaces[0];assert.equal(text.ifindex,7);assert.equal(text.admin,'Enabled');assert.equal(text.mtu,'1500');
});

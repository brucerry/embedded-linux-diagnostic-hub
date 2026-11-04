import assert from 'node:assert/strict';
import { createLoopbackDiagnostics, sanitizeLoopbackDiagnostics } from './ui/fixtures/loopback-diagnostics';

const checks: string[] = [];
const owner = createLoopbackDiagnostics();
owner.stage('allocated'); owner.stage('connect-requested');
assert.deepEqual(owner.snapshot().stages, ['allocated', 'connect-requested']);
checks.push('fixed stage order');
for (let i=0;i<40;i++) owner.stage('page-ready');
assert.equal(owner.snapshot().stages.length,32); assert.equal(owner.snapshot().overflow,true);
checks.push('32 stage cap');
const failure = createLoopbackDiagnostics();
failure.caseFailure({sshClients:2,acceptedClients:2,readyClients:1,probeExecutions:7,gateway:{sessions:1},password:'SECRET_SENTINEL'});
failure.caseFailure({sshClients:0,probeExecutions:0});
assert.equal(failure.snapshot().firstCaseFailure.owner.probeExecutions,7);
failure.cleanupFailure({sshClients:1,readyClients:0,acceptedClients:2,probeExecutions:5,
    fileHandles:0,failedFileCloses:0,sshListening:false,sshCloseAcknowledged:true,
    gatewayCloseAcknowledged:true,journalFailed:false,gateway:{httpSockets:3},
    password:'SECRET_SENTINEL', transcript:'SECRET_SENTINEL'}, ['resource-unacknowledged','SECRET_SENTINEL']);
const first = failure.snapshot();
failure.cleanupFailure({sshClients:0,gateway:{httpSockets:0}}, []);
assert.deepEqual(failure.snapshot(), first);
checks.push('first failure survives later zero counters');
first.firstCleanupFailure.owner.sshClients = 0; first.stages.length=0;
assert.equal(failure.snapshot().firstCleanupFailure.owner.sshClients,1);
checks.push('returned snapshot cannot erase custody');
const text=JSON.stringify(failure.snapshot());
assert.equal(text.includes('SECRET_SENTINEL'),false); assert.equal(text.includes('password'),false);
assert.ok(Buffer.byteLength(text)<8192);
checks.push('allowlisted projection and byte bound');
const malformed=createLoopbackDiagnostics();
malformed.cleanupFailure({sshClients:Infinity,acceptedClients:1e10,probeExecutions:-1,fileHandles:'1',gateway:{sessions:NaN}},[]);
const counts=malformed.snapshot().firstCleanupFailure;
assert.equal(counts.owner.sshClients,null); assert.equal(counts.owner.acceptedClients,65535);
assert.equal(counts.owner.probeExecutions,null); assert.equal(counts.owner.fileHandles,null);
assert.equal(counts.gateway.sessions,null);
checks.push('finite integral counters and saturation');
failure.modalState(true,true);
const projected=sanitizeLoopbackDiagnostics({...failure.snapshot(),password:'SECRET_SENTINEL'});
assert.deepEqual(projected,failure.snapshot());
assert.equal(JSON.stringify(projected).includes('SECRET_SENTINEL'),false);
checks.push('receipt projection keeps sanitized first failure and modal flags');
assert.equal(sanitizeLoopbackDiagnostics({schema:1,stages:['SECRET_SENTINEL']}),null);
assert.equal(sanitizeLoopbackDiagnostics({schema:1,stages:Array(33).fill('allocated')}),null);
assert.equal(sanitizeLoopbackDiagnostics({schema:1,stages:[],firstCleanupFailure:{codes:['SECRET_SENTINEL']}}),null);
checks.push('invalid stage and failure-code refusal');
console.log(JSON.stringify({status:'passed',checks,count:checks.length,browserOrSSHExecuted:false}));

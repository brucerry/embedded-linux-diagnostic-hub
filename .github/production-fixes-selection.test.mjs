import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SOURCE, TITLES } from './production-fixes-log-receipt.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8'),hash=b=>createHash('sha256').update(b).digest('hex');
const c=read('./production-fixes-candidate.config.ts'),w=read('./workflows/production-fixes-candidate.yml');
const grep=new RegExp(c.match(/^    grep: \/(.*)\/,[ ]*$/m)[1]);let yes=0,no=0;
for(const[file,titles]of Object.entries(TITLES))for(const title of titles){for(const prefix of['','  ','chromium ']){assert(grep.test(prefix+file+' '+title));yes++;}for(const v of[title,file+' extra '+title,file+' '+title+' extra','automation.spec.ts '+title,'ssh-console-gateway.spec.ts '+title,'stored-console-results.spec.ts '+title,'reset.spec.ts '+title]){assert(!grep.test(v));no++;}}
for(const f of readdirSync(new URL('../tests/ui/',import.meta.url)).filter(n=>n.endsWith('.spec.ts'))){for(const m of read('../tests/ui/'+f).matchAll(/\btest\(\s*['"]([^'"\n]+)/g)){const selected=(TITLES[f]??[]).includes(m[1]);assert.equal(grep.test(f+' '+m[1]),selected);if(!selected)no++;}}
const evidence=read('../tests/ui/production-evidence.spec.ts'),ssh=read('../tests/ui/ssh-cleanup-fault.spec.ts'),fixture=read('../tests/ui/fixtures/ssh-cleanup-fault.ts');
assert(evidence.includes("expect(await dialog.locator('.evidence-output').textContent()).toBe(RAW)"));assert.equal(evidence.split("textContent()).toBe(RAW)").length-1,2);
assert(ssh.includes("for (const mode of ['rejected-finalize', 'lost-finalize'] as const)"));assert(ssh.includes('test(`SSH ${mode} requires explicit acknowledged cleanup without command replay`'));assert(ssh.includes("test('SSH uncertain start remains blocked and incomplete without replay or fabricated cleanup'"));
for(const fact of["toContainText('SSH cleanup remains pending')",'pendingRetry','releaseRetry()',"toContainText('SSH cleanup acknowledged')",'toBeDisabled()',"toEqual(['one'])",'toBe(retained)',"toContainText('start outcome is uncertain')"])assert(ssh.includes(fact),fact);
for(const fact of['await original(request); receipt = key','receipt !== key','state.finalizes !== 2','Synthetic start reply lost after admission'])assert(fixture.includes(fact),fact);
for(const bad of['waitForTimeout(','dispatchEvent(','screenshot(','.saveAs(','page.request.','page.clock.'])for(const src of[evidence,ssh,fixture])assert(!src.includes(bad),bad);
const pins=JSON.parse(w.match(/const pins = (\{[^\r\n]+\});/)[1]);assert.equal(Object.keys(pins).length,22);for(const[p,h]of Object.entries(pins)){assert(!p.split('/').includes('..'));assert.equal(hash(read('../'+p)),h,p);}
assert.equal(hash(c),w.match(/if \(hash\(config\) !== '([a-f0-9]{64})'\)/)[1]);assert.equal(hash(read('./production-fixes-log-receipt.mjs')),w.match(/if \(createHash\('sha256'\).update\(fs.readFileSync\(helper\)\).digest\('hex'\) !== '([a-f0-9]{64})'/)[1]);
for(const fact of['chromiumSandbox: true','workers: 1','retries: 0','repeatEach: 1','maxFailures: 1','timeout: 45_000','globalTimeout: 240_000',"trace: 'off'","screenshot: 'off'","video: 'off'",'reuseExistingServer: false','--host 127.0.0.1 --port 5200 --strictPort','gracefulShutdown:'])assert(c.includes(fact),fact);
for(const fact of['branches: [ci/production-fixes255-20261104]','timeout-minutes: 15','contents: read','receipt-only:','timeout-minutes: 2','permissions: {}','RECEIPT_BYTES > 32768','HUB_FIXES255_V1','sdk_exit=$?','exit "$sdk_exit"','SDK_STEP_OUTCOME: ${{ steps.sdk.outcome }}','socket_bytes > 107'])assert(w.includes(fact),fact);
for(const bad of['workflow_dispatch:','workflow_call:','secrets.','--no-sandbox','sudo ','rm -','kill ','continue-on-error:','actions/upload-artifact','actions/cache'])assert(!w.includes(bad),bad);
assert.equal((w.match(/node node_modules\/playwright\/cli\.js test/g)??[]).length,1);assert.deepEqual([...w.matchAll(/^                  ref: (.+)$/gm)].map(m=>m[1]),['${{ github.sha }}',SOURCE]);assert(w.includes('test "$(git -C tooling rev-parse HEAD^)" = '+SOURCE));
console.log(JSON.stringify({positiveFullNames:yes,negativeControls:no,selectedCases:4,sourcePins:Object.keys(pins).length,mountedOrSDKDiscoveryExecuted:false}));

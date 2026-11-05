// Pure prelaunch snapshot, split from build-only dependency/semver producers.
import assert from 'node:assert/strict';
import path from 'node:path';
import {sourceDigest} from './committed-source-bridge.mjs';
import {deriveInstrumentedGeneratedInventory} from './instrumented-gateway-generated.mjs';
import {RAW_CLI_REFERENCE} from './instrumented-gateway-source.mjs';
import {isExactInstrumentedText} from './instrumented-gateway-files.mjs';
const absolute=p=>assert.ok(typeof p==='string'&&p.length<=4096&&Buffer.byteLength(p)<=4096&&p.startsWith('/')&&path.posix.normalize(p)===p&&!/[\\\x00-\x20\x7f]/.test(p));
export function snapshotPreparedInstrumentedGateway(prepared) {
    const binding = structuredClone(prepared.binding), selection = { ...prepared.selection }, scripts = new Map();
    assert.ok(['separate-instrumented-gateway-build-byte-binding-v4','separate-preimport-gateway-build-byte-binding-v5'].includes(binding.kind));
    if(binding.kind==='separate-preimport-gateway-build-byte-binding-v5'){
        const p=binding.preimport;assert.deepEqual(Object.keys(p).sort(),['schema','earlyArtifactSHA256','earlyEntrySHA256','earlyGraphSHA256','earlyMetafileSHA256','earlyAcknowledgementSHA256','targetGraphSHA256','targetMetafileSHA256','targetAcknowledgementSHA256'].sort());assert.equal(p.schema,'source-acknowledged-preimport-pair-v1');for(const key of Object.keys(p).filter(k=>k!=='schema'))assert.match(p[key],/^[a-f0-9]{64}$/);
        assert.equal(sourceDigest(prepared.scripts.get(path.dirname(selection.artifactPath)+'/preimport.mjs')),p.earlyArtifactSHA256);
    }
    assert.deepEqual(selection, { ...binding.source, artifactPath: binding.artifactPath, artifactSHA256: binding.artifactSHA256, observerSHA256: binding.observerSHA256 });
    assert.equal(binding.releaseAcceptance, false); assert.equal(binding.buildProvenanceVerified, false);
    assert.deepEqual(binding.rawCLIReference, RAW_CLI_REFERENCE);
    assert.equal(sourceDigest(JSON.stringify(binding.scriptInventory)), binding.scriptInventorySHA256);
    assert.ok(Array.isArray(binding.scriptInventory) && binding.scriptInventory.length>0 && binding.scriptInventory.length<=512);
    assert.equal(sourceDigest(JSON.stringify(binding.fileInventory)),binding.fileInventorySHA256);
    assert.ok(Array.isArray(binding.fileInventory)&&binding.fileInventory.length>0&&binding.fileInventory.length<=512);
    const all=new Map();let fileTotal=0;
    for(const row of binding.fileInventory){
        assert.deepEqual(Object.keys(row).sort(),['bytes','path','sha256']);absolute(row.path);assert.ok(row.path.startsWith(path.dirname(selection.artifactPath)+'/')&&!all.has(row.path));
        assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=32*1024**2);fileTotal+=row.bytes;assert.ok(fileTotal<=64*1024**2);assert.match(row.sha256,/^[a-f0-9]{64}$/);all.set(row.path,row);
    }
    assert.deepEqual(binding.fileInventory.map(r=>r.path),[...all.keys()].sort());
    const seen=new Set();let total=0;
    for (const row of binding.scriptInventory) {
        assert.deepEqual(Object.keys(row).sort(),['bytes','path','sha256']);absolute(row.path);assert.ok(row.path.startsWith(path.dirname(selection.artifactPath)+'/')&&!seen.has(row.path));seen.add(row.path);
        assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=32*1024**2);total+=row.bytes;assert.ok(total<=64*1024**2);assert.match(row.sha256,/^[a-f0-9]{64}$/);
        assert.deepEqual(row,all.get(row.path));
        const b = prepared.scripts.get(row.path); assert.ok(Buffer.isBuffer(b) && b.length === row.bytes && sourceDigest(b) === row.sha256);
        assert.ok(isExactInstrumentedText(b));scripts.set(row.path, Buffer.from(b));
    }
    assert.deepEqual(binding.scriptInventory.map(r=>r.path),[...seen].sort());
    assert.equal(sourceDigest(scripts.get(path.dirname(selection.artifactPath)+'/resolution-guard.cjs')),binding.guardSHA256);
    assert.equal(scripts.size, prepared.scripts.size); assert.equal(sourceDigest(scripts.get(selection.artifactPath)), selection.artifactSHA256);
    assert.deepEqual(binding.generatedInventory,deriveInstrumentedGeneratedInventory(scripts,path.dirname(selection.artifactPath)));
    assert.equal(binding.generatedInventorySHA256,sourceDigest(JSON.stringify(binding.generatedInventory)));
    return { binding, selection, scripts };
}

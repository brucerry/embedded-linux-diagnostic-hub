// @ts-nocheck
// Inert real-loader/IPC entry. Imports the native host but never calls its factory or payloads.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as esm from '../../scripts/lib/startup-identity-report.mjs';
import { runtimeDiagnostics } from '../../scripts/lib/pilot-runtime-startup.mjs';
import { stageChannel } from './pilot-stage-channel';
const req = createRequire(import.meta.url),
    raw = JSON.parse(process.argv[2]);
const profile = JSON.parse(fs.readFileSync(raw.profile, 'utf8'));
const hash = (b) => createHash('sha256').update(b).digest('hex');
assert.equal(profile.lockSHA256, hash(fs.readFileSync('package-lock.json')));
for (const name of ['preload.cjs', 'ssh2.cjs'])
    assert.equal(
        hash(fs.readFileSync(path.join(path.dirname(raw.profile), name))),
        profile.files[name],
    );
process.env.HUB_MEMORY_SSH_PROFILE = raw.profile;
const preload = path.join(path.dirname(raw.profile), 'preload.cjs');
req(preload);
process.execArgv.push('--require', preload);
const nativeHost = await import('./memory-product-native-host');
assert.equal(typeof nativeHost.createProductNative, 'function');
const { publishFromTs, makeFromTs, checkFromTs, sourceURL } =
    await import('./pilot-plan-boundary-caller');
const hostId = req.resolve('./memory-product-native-host.ts'),
    reportId = req.resolve('../../scripts/lib/startup-identity-report.mjs');
const actualHostReporter = req.cache[hostId].children.find((m) => m.id === reportId);
assert(actualHostReporter);
assert.equal(actualHostReporter.exports.planStartupIdentity, makeFromTs);
const reply = (value) =>
    new Promise((resolve, reject) => process.send(value, (e) => (e ? reject(e) : resolve())));
const local = makeFromTs('actual-native-product', { safe: true });
checkFromTs(local);
let foreignPlanError;
try {
    esm.requireIdentityPlan(local);
} catch (error) {
    foreignPlanError = String(error);
}
assert(foreignPlanError?.includes('validated plan'));
let frames = 0,
    result,
    error,
    reportingFailure,
    guardHold;
const send = stageChannel(raw.nonce, raw.binding, new AbortController().signal, {
    deadline: Number(process.hrtime.bigint() / 1000000n) + 5000,
});
const diagnostics = runtimeDiagnostics(
    async (stage, data) => {
        frames++;
        return send(stage, data);
    },
    (error) => {
        guardHold = String(error);
    },
);
try {
    if (raw.mode === 'serialized') {
        const incoming = new Promise((resolve) =>
            process.once('message', (message) => resolve(message.plan)),
        );
        await reply({ kind: 'foreign-plan-ready' });
        esm.requireIdentityPlan(await incoming);
    } else if (raw.mode === 'forged')
        esm.requireIdentityPlan({ manifest: {}, budget: {}, frames() {} });
    else if (raw.mode === 'old-plan-api') await diagnostics.emit.publishIdentity(local);
    else {
        const stage = raw.mode === 'invalid-stage' ? 'stage-final' : 'actual-native-product';
        const data = {
            marker: 'before',
            payload: raw.mode === 'overbudget' ? 'x'.repeat(4194304) : '界'.repeat(25000),
            artifactSHA256: 'c'.repeat(64),
        };
        const task =
            raw.mode === 'esm'
                ? esm.reportStartupIdentity(diagnostics.emit, stage, data)
                : publishFromTs(diagnostics.emit, stage, data);
        data.marker = 'after';
        // Queue a later diagnostic before awaiting the report: the complete batch must remain atomic.
        const later = raw.expectedSuccess
            ? diagnostics.emit('after-publication', { complete: true })
            : null;
        await task;
        if (later) await later;
        await diagnostics.drain();
        result = 'published';
    }
} catch (failure) {
    error = String(failure);
    reportingFailure = failure.reportingFailure;
} finally {
    await reply({
        kind: 'plan-boundary-result',
        pid: process.pid,
        node: process.version,
        tsx: req('tsx/package.json').version,
        sourceURL,
        nativeHostCJSReporterMatchesTypedCarrier: true,
        nativeHostFunctionNotCalled: true,
        profileID: profile.id,
        preloadSHA256: profile.files['preload.cjs'],
        execArgvAfterStageStylePreload: [...process.execArgv],
        packageTypeAbsent: !Object.hasOwn(
            JSON.parse(fs.readFileSync('package.json', 'utf8')),
            'type',
        ),
        sameMaker: esm.planStartupIdentity === makeFromTs,
        sameValidator: esm.requireIdentityPlan === checkFromTs,
        CJSOwnPlanAccepted: true,
        foreignPlanError,
        mode: raw.mode,
        frames,
        result,
        error,
        reportingFailure,
        guardHold,
        moduleSHA256: hash(fs.readFileSync('scripts/lib/startup-identity-report.mjs')),
        loader: req.resolve('tsx'),
    });
    req('esbuild').stop();
    if (process.connected) process.disconnect();
}

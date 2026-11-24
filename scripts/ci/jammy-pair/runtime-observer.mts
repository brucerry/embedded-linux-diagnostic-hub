import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, realpath, open, statfs } from 'node:fs/promises';
import os from 'node:os';
import { constants } from 'node:fs';
import path from 'node:path';
import { readWindow } from './browser-frame-evidence.mjs';
import { mapOverview, observeSession, stableProcess, verifyFrameFence } from './runtime-observation.mjs';
import { appimageLaunch, observeAppImage, privateExtraction, requireAppImageRetired, ASSET }
    from './appimage-observer.mjs';

const executable = process.env.HUB_TEST_EXECUTABLE;
const destination = process.env.HUB_STAGED_IDENTITY;
assert.ok(
    executable && path.isAbsolute(executable),
    'An actual staged executable is required; no development fallback.',
);
assert.ok(destination && path.isAbsolute(destination));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-staged-profile-')));
const pathPin=process.env.HUB_RT_BINDING;
const runtimeTmp=process.env.HUB_APPIMAGE_TMP;
assert.ok(pathPin && path.isAbsolute(pathPin) && await realpath(pathPin)===pathPin);
assert.ok(runtimeTmp && path.isAbsolute(runtimeTmp));
const control = await open(pathPin,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
let binding;
try {
    const before=await control.stat();
    assert.ok(before.isFile() && before.nlink===1 && before.uid===0 && before.gid===0 &&
              (before.mode&0o777)===0o444 && before.size>0 && before.size<=4096);
    const raw=await control.readFile('utf8');
    const after=await control.stat();
    assert.ok(raw.length===before.size && before.ctimeMs===after.ctimeMs && before.ino===after.ino);
    binding=JSON.parse(raw);
} finally {
    await control.close();
}
assert.equal(binding.asset,ASSET);
assert.equal(binding.archive.path,executable);
const extraction=await privateExtraction(runtimeTmp, process.getuid!());
const {args,env}=appimageLaunch(profile,extraction,process.env);
async function checkSpace() {
    const data=await statfs(runtimeTmp,{bigint:true});
    assert.ok(data.bavail*data.bsize>=4294967296n && data.ffree>=12000n);
}
// Pinned Playwright can reject its still-unawaited debugger promises when
// the launched child exits before the handshake. Keep the failure attributable;
// every unhandled rejection still forces a failing exit if it arrives late.
let unhandled = false;
process.on('unhandledRejection', () => {
    unhandled = true;
    process.exitCode = 78;
});
let lifecycle = {quit:'unreached',extraction:'unreached'};
const result = await observeSession({
    observeRetirement: (value) => { lifecycle=value; },
    rejected: () => unhandled,
    launch: () => electron.launch({
        executablePath: executable,
        args,
        env,
        chromiumSandbox: true,
        timeout: 30000,
    }),
    mapWindow: (application) => mapOverview(application, (heading) => expect(heading).toBeVisible()),
    async verify(application, childPid) {
        const identity = await application.evaluate(
            readWindow,'__stagedQualification_'+randomUUID().replaceAll('-',''));
        const rereadFrame=async()=>(await application.evaluate(readWindow,null)).frameIdentity;
        verifyFrameFence(identity.frameIdentity,await rereadFrame(),identity.rendererPID);
        const renderer=await stableProcess('/proc',identity.rendererPID);
        identity.osSandboxed=renderer.fields.NoNewPrivs.length===1 && renderer.fields.NoNewPrivs[0]==='1' &&
                             renderer.fields.Seccomp.length===1 && renderer.fields.Seccomp[0]==='2';
        identity.sandbox=identity.sandbox && identity.osSandboxed;
        assert.equal(identity.packaged, true);
        assert.equal(identity.version, version);
        assert.equal(identity.platform, process.platform);
        assert.equal(identity.arch, process.arch);
        assert.equal(identity.sandbox, true);
        assert.equal(path.basename(identity.asar), 'app.asar');
        const freshRenderer=await observeAppImage({identity,archive:binding.archive,
            extraction,wrapperPid:childPid,baselinePid:process.pid,rolePins:binding.roles,checkSpace,recheckFrame:rereadFrame,initialRenderer:renderer});
        return {asset:ASSET,artifactSHA256:binding.archive.sha256,freshRenderer,extractionRetired:true};
    },
    async retire() {
        await requireAppImageRetired(extraction);
        await checkSpace();
    },
    async commit(identity) {
        await writeFile(destination, JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' });
    },
});
process.stdout.write('HUB_OBSERVER '+result+' '+lifecycle.quit+' '+lifecycle.extraction+'\n');
if (result !== 'pass') process.exitCode = 78;

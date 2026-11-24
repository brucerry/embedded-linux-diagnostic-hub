import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, realpath, open, statfs } from 'node:fs/promises';
import os from 'node:os';
import { constants } from 'node:fs';
import path from 'node:path';
import { mapOverview, observeSession } from './runtime-observation.mjs';
import { appimageLaunch, observeOriginalFiles, privateExtraction, requireAppImageRetired, ASSET }
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
// This receipt covers the packaged application and its lifecycle only.
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
    verificationStage: 'identity',
    async verify(application) {
        const identity = await application.evaluate(({ app }) => ({
            packaged: app.isPackaged,
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            asar: app.getAppPath(),
            executable: process.execPath,
            asset: process.env.HUB_STAGED_ASSET,
            original: process.env.APPIMAGE,
            extractionRoot: process.env.APPDIR,
            runtimeTmp: process.env.TMPDIR,
            extractAndRun: process.env.APPIMAGE_EXTRACT_AND_RUN,
        }));
        assert.equal(identity.packaged, true);
        assert.equal(identity.version, version);
        assert.equal(identity.platform, process.platform);
        assert.equal(identity.arch, process.arch);
        const {root} = await observeOriginalFiles({
            identity, archive: binding.archive, extraction, rolePins: binding.roles,
        });
        assert.equal(identity.executable, path.join(root, 'diagnostic-hub'));
        assert.equal(identity.asar, path.join(root, 'resources', 'app.asar'));
        await checkSpace();
        return {asset:ASSET,artifactSHA256:binding.archive.sha256,
                window:'portable-overview',extractionRetired:true};
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

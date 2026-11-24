import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, realpath, open, statfs } from 'node:fs/promises';
import os from 'node:os';
import { constants } from 'node:fs';
import path from 'node:path';
import { hashOriginalMember, mapOverview, observeSession } from './runtime-observation.mjs';

const ASSET = 'Diagnostic-Hub-linux-x64.tar.gz';
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
assert.ok(pathPin && path.isAbsolute(pathPin) && await realpath(pathPin)===pathPin);
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
assert.equal(binding.asset, ASSET);
assert.ok(path.isAbsolute(binding.root) && await realpath(binding.root) === binding.root);
assert.equal(executable, path.join(binding.root, 'AppRun'));
assert.equal(await realpath(executable), executable);
assert.equal(await hashOriginalMember(executable), binding.appRunSHA256);
const env = Object.fromEntries(
    ['PATH', 'LC_ALL', 'HOME', 'DISPLAY', 'XAUTHORITY', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
        'HUB_STAGED_ASSET'].map((key) => [key, process.env[key]]),
);
assert.ok(Object.values(env).every((value) => typeof value === 'string' && value.length > 0));
const args = ['--user-data-dir=' + profile];

async function checkSpace() {
    const data = await statfs(binding.root, { bigint: true });
    assert.ok(data.bavail * data.bsize >= 4294967296n && data.ffree >= 12000n);
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
let lifecycle = {quit:'unreached',postQuitFloor:'unreached'};
const result = await observeSession({
    observeRetirement: ({quit, extraction}) => { lifecycle = {quit, postQuitFloor: extraction}; },
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
            root: process.env.APPDIR,
        }));
        assert.equal(identity.packaged, true);
        assert.equal(identity.version, version);
        assert.equal(identity.platform, process.platform);
        assert.equal(identity.arch, process.arch);
        assert.equal(identity.asset, ASSET);
        assert.equal(identity.root, binding.root);
        for (const [field, member] of [['executable', 'diagnostic-hub'], ['asar', 'resources/app.asar']]) {
            const file = path.join(binding.root, member);
            assert.equal(identity[field], file);
            assert.equal(await realpath(file), file);
            assert.equal(await hashOriginalMember(file), binding[field + 'SHA256']);
        }
        return {asset: ASSET, archiveSHA256: binding.archiveSHA256, window: 'portable-overview'};
    },
    retire: checkSpace,
    async commit(identity) {
        await writeFile(destination, JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' });
    },
});
const verdict = result === 'extraction' ? 'post-quit-floor' : result;
process.stdout.write('HUB_TAR_OBSERVER '+verdict+' '+lifecycle.quit+' '+lifecycle.postQuitFloor+'\n');
if (result !== 'pass') process.exitCode = 78;

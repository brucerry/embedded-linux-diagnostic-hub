// Private observer integration. Shipping code and artifact bytes stay unchanged.
import assert from 'node:assert/strict';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { hashOriginalMember, observeSession, stableProcess, verifyFrameFence, verifyRenderer } from './runtime-observation.mjs';

export const ASSET = 'Diagnostic-Hub-linux-x64.AppImage';

async function canonicalDirectory(directory, uid) {
    const current = await lstat(directory);
    assert.ok(path.isAbsolute(directory) && await realpath(directory) === directory &&
              current.isDirectory() && current.uid === uid && !(current.mode & 0o7022),
              'appimage-private-directory');
    return [current.dev,current.ino,current.uid,current.mode];
}

export async function privateExtraction(directory, uid) {
    const stamp = await canonicalDirectory(directory,uid);
    assert.ok(uid>0 && (stamp[3]&0o777)===0o700,'appimage-private-tmpdir-mode');
    assert.deepEqual(await readdir(directory),[],'appimage-private-tmpdir-empty');
    return {directory,uid,stamp};
}

function confinedProfile(profile, directory) {
    const relative = path.relative(directory,profile);
    assert.ok(path.isAbsolute(profile) && relative.startsWith('..'+path.sep),'appimage-profile-separation');
}

export function appimageLaunch(profile, control, env) {
    confinedProfile(profile,control.directory);
    const names = new Set(['PATH','LC_ALL','HOME','DISPLAY','XAUTHORITY','XDG_CONFIG_HOME',
                           'XDG_CACHE_HOME','HUB_STAGED_ASSET']);
    const clean = Object.fromEntries(Object.entries(env).filter(([key]) => names.has(key)));
    // Playwright prepends its inspector flags. The pinned AppImage runtime treats
    // the first double-dash option as its mode, so a trailing CLI mode is too late.
    return {args:['--user-data-dir='+profile],
            env:{...clean,TMPDIR:control.directory,APPIMAGE_EXTRACT_AND_RUN:'1'}};
}

function executable(path) {
    return lstat(path).then((row) => row.isFile() && row.nlink===1 && (row.mode&0o100)!==0);
}

// AppRun replaces its own process with Electron. The outer AppImage runtime remains
// the child Playwright owns until its real application exits and extraction is retired.
export async function observeAppImage({ identity, archive, extraction, wrapperPid, baselinePid,
        rolePins, capture = (target) => stableProcess('/proc',target), checkSpace, recheckFrame, initialRenderer }) {
    assert.ok(Number.isSafeInteger(wrapperPid) && wrapperPid > 1 &&
              Number.isSafeInteger(identity.mainPID) && identity.mainPID>1 &&
              identity.mainPID!==wrapperPid,'appimage-distinct-wrapper-and-application');
    assert.ok(identity.asset===ASSET && identity.extractAndRun==='1' &&
              identity.runtimeTmp===extraction.directory,'appimage-browser-case');
    assert.ok(path.isAbsolute(archive.path) && path.basename(archive.path)===ASSET &&
              identity.original===archive.path && await realpath(archive.path)===archive.path,
              'appimage-reported-original');
    const source=await lstat(archive.path);
    assert.ok(source.uid===extraction.uid && (source.mode&0o777)===0o500 &&
              source.size===archive.size && await hashOriginalMember(archive.path)===archive.sha256,
              'appimage-live-original');
    assert.deepEqual(await canonicalDirectory(extraction.directory,extraction.uid),extraction.stamp,
                     'appimage-opaque-extraction-parent');
    const root=identity.extractionRoot, leaf=path.basename(root);
    assert.ok(path.dirname(root)===extraction.directory &&
              /^appimage_extracted_[a-f0-9]{32}$/.test(leaf),'appimage-extracted-root-name');
    assert.deepEqual(await readdir(extraction.directory),[leaf],'appimage-one-extraction');
    const rootStamp = await canonicalDirectory(root,extraction.uid);
    assert.equal(rootStamp[0],extraction.stamp[0],'appimage-extraction-device');
    assert.deepEqual(Object.keys(rolePins).sort(),['AppRun','diagnostic-hub','resources/app.asar']);
    for (const [name,pin] of Object.entries(rolePins)) {
        const target=path.join(root,name);
        const data=await lstat(target);
        // The runtime may apply its process umask to extracted modes. The signed
        // inventory's mode is still bound upstream and no unsafe runtime mode is allowed.
        assert.ok(data.uid===extraction.uid && data.dev===rootStamp[0] &&
                  data.size===pin[0] && !(data.mode&0o7022) &&
                  await realpath(target)===target && await hashOriginalMember(target)===pin[2],
                  'appimage-extracted-member-readback');
        if (name!=='resources/app.asar') assert.ok(await executable(target),'appimage-executable-role');
    }
    const expected={asset:ASSET,executable:path.join(root,'diagnostic-hub'),
                    asar:path.join(root,'resources/app.asar')};
    const wrapper = await capture(wrapperPid);
    const main=await capture(identity.mainPID);
    const uid=String(extraction.uid);
    assert.ok(wrapper.pid===wrapperPid && wrapper.executable===archive.path &&
              wrapper.parent===baselinePid && main.pid===identity.mainPID && main.parent===wrapperPid &&
              /^[0-9]+$/.test(wrapper.start) && /^[0-9]+$/.test(main.start),
              'appimage-live-runtime-lineage');
    assert.deepEqual(wrapper.fields.Uid,[uid,uid,uid,uid],'appimage-wrapper-owner');
    for (const field of ['CapEff','CapPrm']) assert.deepEqual(wrapper.fields[field],['0000000000000000']);
    assert.ok(wrapper.argv[1]==='--inspect=0' && wrapper.argv[2]==='--remote-debugging-port=0' &&
              wrapper.argv[3]==='--user-data-dir='+identity.profile && wrapper.argv.length===5 &&
              wrapper.argv[4]==='' && !wrapper.argv.includes('--no-sandbox') &&
              !wrapper.argv.includes('--disable-setuid-sandbox'),'appimage-wrapper-command');
    confinedProfile(identity.profile,extraction.directory);
    verifyFrameFence(identity.frameIdentity,await recheckFrame(),identity.rendererPID);
    const result = await verifyRenderer({identity,childPid:main.pid,baselinePid,uid,expected,capture,initialRenderer});
    // Do not hand acceptance off using stale identity or a guest below the floor.
    assert.deepEqual(await capture(wrapperPid),wrapper,'appimage-runtime-wrapper-drift');
    assert.deepEqual(await capture(main.pid),main,'appimage-runtime-main-drift');
    assert.deepEqual(await canonicalDirectory(root,extraction.uid),rootStamp,'appimage-runtime-root-drift');
    await checkSpace();
    verifyFrameFence(identity.frameIdentity,await recheckFrame(),identity.rendererPID);
    return result;
}

export async function requireAppImageRetired(extraction) {
    assert.deepEqual(await canonicalDirectory(extraction.directory,extraction.uid),extraction.stamp,
                     'appimage-retirement-parent');
    assert.deepEqual(await readdir(extraction.directory),[],'appimage-runtime-extraction-retirement');
}

export async function observeAppImageSession({ launch, mapWindow, readIdentity, archive, extraction,
        baselinePid, rolePins, capture, checkSpace, recheckFrame, commit, observeRetirement, quitMs }) {
    return observeSession({
        launch,
        mapWindow,
        async verify(application, wrapperPid) {
            const identity=await readIdentity(application);
            const sandbox=await observeAppImage({ identity, archive, extraction, wrapperPid,
                baselinePid, rolePins, capture, checkSpace, recheckFrame });
            return {identity,sandbox};
        },
        async retire() {
            await requireAppImageRetired(extraction);
            await checkSpace();
        },
        commit,
        observeRetirement,
        quitMs,
    });
}

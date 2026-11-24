// Additional test-side checks for the unchanged tracked archive runtime observer.
import assert from 'node:assert/strict';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const pid = (n) => Number.isSafeInteger(n) && n > 1;
const max = 16384;

export function statRow(raw, expected) {
    assert.ok(raw.length <= max, 'proc-stat-bound');
    const match = raw.match(/^(\d+) \(([\s\S]*)\) ([A-Za-z]) (\d+) (.*)\n$/);
    assert.ok(match && Number(match[1]) === expected, 'proc-stat-id');
    const start = match[5].split(' ')[17];
    assert.ok(/^\d+$/.test(start), 'proc-stat-start');
    return { pid: expected, parent: Number(match[4]), start };
}

export function status(raw) {
    assert.ok(raw.length <= max, 'proc-status-bound');
    const keys = ['Uid','NSpid','NoNewPrivs','Seccomp','CapEff','CapPrm'];
    const fields = new Map();
    for (const line of raw.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 1) continue;
        const key = line.slice(0, colon);
        if (!keys.includes(key)) continue;
        assert.ok(!fields.has(key), 'proc-status-repeat');
        fields.set(key,line.slice(colon+1).trim().split(/\s+/));
    }
    assert.equal(fields.size,keys.length,'proc-status-fields');
    return Object.fromEntries(fields);
}

function equalStartPair(a,b) {
    assert.deepEqual(b,a,'proc-start-or-parent-drift');
}

export class ProcIdentityUnavailable extends Error {}
export class ProcIdentityChanged extends Error {}

// Resolve all task entries relative to the opened proc directory, with the
// same credentials as the original observer. A recycled numeric PID cannot
// direct subsequent reads within this capture to a different task.
export async function stableProcess(proc, processId, link = readlink) {
    assert.ok(pid(processId),'proc-pid-number');
    const dir=path.posix.join(proc,String(processId));
    let held;
    try {
        held=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        const stableDir='/proc/self/fd/'+held.fd;
        const mark=entry=>[entry.dev.toString(),entry.ino.toString()];
        const inode=mark(await held.stat({bigint:true}));
        const snapshot=()=>readFile(stableDir+'/stat','ascii').then(raw=>statRow(raw,processId));
        const before=await snapshot();
        const fields=status(await readFile(stableDir+'/status','ascii'));
        assert.ok(fields.NSpid[0]===String(processId) && fields.NSpid.every(value=>/^[1-9]\d*$/.test(value)),
                  'proc-outer-pid-mapping');
        const argv=(await readFile(stableDir+'/cmdline')).toString('utf8').split('\0');
        assert.ok(argv.length>1 && argv.length<=512 && argv.at(-1)==='' &&
                  argv.join('\0').length<=max,'proc-command-bound');
        const executable=await link(stableDir+'/exe');
        const userNS=await link(stableDir+'/ns/user');
        const pidNS=await link(stableDir+'/ns/pid');
        assert.match(userNS,/^user:\[\d+\]$/,'proc-user-namespace');
        assert.match(pidNS,/^pid:\[\d+\]$/,'proc-pid-namespace');
        equalStartPair(before,await snapshot());
        if (mark(await lstat(dir,{bigint:true})).join(':')!==inode.join(':'))
            throw new ProcIdentityChanged('proc-directory-replaced');
        return {...before,inode,fields,argv,executable,userNS,pidNS};
    } catch (error) {
        if (error?.code==='EACCES' || error?.code==='EPERM')
            throw new ProcIdentityUnavailable('proc-identity-read-denied');
        if (error?.code==='ENOENT' || error?.code==='ESRCH')
            throw new ProcIdentityChanged('proc-identity-disappeared');
        throw error;
    } finally {
        if (held) await held.close();
    }
}

export function verifyFrameFence(before, after, rendererPID) {
    assert.ok(before && ['windowId','contentsId','treeId','chromiumPid','routingId'].every(
              key=>Number.isSafeInteger(before[key]) && before[key]>=0) &&
              typeof before.frameToken==='string' && before.frameToken.length>0 &&
              before.frameToken.length<=128 && pid(rendererPID) && before.pid===rendererPID &&
              before.url==='app://bundle/index.html','native-frame-pid-association');
    assert.deepEqual(after,before,'native-frame-replaced');
}

function ordinary(row, uid) {
    assert.deepEqual(row.fields.Uid,[uid,uid,uid,uid],'native-ordinary-user');
    assert.deepEqual(row.fields.CapEff,['0000000000000000'],'native-effective-capabilities');
    assert.deepEqual(row.fields.CapPrm,['0000000000000000'],'native-permitted-capabilities');
    assert.ok(!row.argv.includes('--no-sandbox') && !row.argv.includes('--disable-setuid-sandbox'),
              'native-sandbox-argv');
}

export async function verifyRenderer({ identity, childPid, baselinePid, uid, expected, capture, initialRenderer }) {
    assert.ok(pid(childPid) && pid(baselinePid) && pid(identity.rendererPID) &&
              String(uid).match(/^[1-9]\d*$/) && childPid!==identity.rendererPID,
              'native-pid-roster');
    uid = String(uid);
    assert.equal(identity.asset,expected.asset,'native-asset-label');
    assert.equal(identity.executable,expected.executable,'native-main-path');
    assert.equal(identity.asar,expected.asar,'native-asar-path');
    assert.ok(identity.packaged===true && identity.osSandboxed===true &&
              identity.contextsSeparated===true && identity.pageNodeAbsent===true &&
              identity.sandbox===true,'native-window-and-page-security');
    const base = await capture(baselinePid);
    const main = await capture(childPid);
    const renderer = await capture(identity.rendererPID);
    if (initialRenderer)
        assert.deepEqual(renderer,initialRenderer,'native-renderer-changed-since-frame-sample');
    for (const entry of [base,main,renderer]) ordinary(entry,uid);
    assert.deepEqual(base.fields.Seccomp,['0'],'native-stock-baseline-seccomp');
    assert.deepEqual(renderer.fields.NoNewPrivs,['1'],'native-renderer-nonewprivs');
    assert.deepEqual(renderer.fields.Seccomp,['2'],'native-renderer-seccomp');
    assert.equal(main.executable,expected.executable,'native-actual-main-executable');
    assert.equal(renderer.executable,expected.executable,'native-actual-renderer-executable');
    assert.ok(renderer.argv.includes('--type=renderer'),'native-actual-renderer-role');
    assert.ok(base.userNS!==renderer.userNS && base.pidNS!==renderer.pidNS &&
              renderer.fields.NSpid.length>base.fields.NSpid.length,'native-distinct-renderer-sandbox');
    let entry = renderer;
    const ancestry = new Map([[renderer.pid,renderer]]);
    while (entry.pid !== childPid) {
        assert.ok(pid(entry.parent) && !ancestry.has(entry.parent) && ancestry.size<16,
                  'native-renderer-ancestry');
        entry = entry.parent===childPid ? main : await capture(entry.parent);
        ordinary(entry,uid);
        assert.equal(entry.executable,expected.executable,'native-renderer-ancestor-executable');
        ancestry.set(entry.pid,entry);
    }
    for (const pinned of ancestry.values()) {
        const after = await capture(pinned.pid);
        assert.deepEqual(after,pinned,'native-renderer-process-drift');
    }
    return Object.freeze({ window:'portable-overview',renderer:'artifact-descendant',
                           sandbox:'distinct-user-pid-seccomp-nonewprivs' });
}

export async function hashOriginalMember(path) {
    const member = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
        const initial = await member.stat();
        assert.ok(initial.isFile() && initial.nlink===1 && initial.size>0 &&
                  initial.size<=512*1024*1024, 'native-original-member-type');
        const hash=createHash('sha256');
        let count=0;
        for await (const bytes of member.createReadStream({ autoClose:false })) {
            count+=bytes.length;
            assert.ok(count<=initial.size,'native-original-member-length');
            hash.update(bytes);
        }
        const snapshot=(row)=>[row.dev,row.ino,row.size,row.uid,row.mode,row.mtimeMs,row.ctimeMs];
        assert.equal(count,initial.size,'native-original-member-length');
        assert.deepEqual(snapshot(await member.stat()),snapshot(initial),'native-original-member-drift');
        assert.deepEqual(snapshot(await lstat(path)),snapshot(initial),'native-original-path-drift');
        return hash.digest('hex');
    } finally {
        await member.close();
    }
}

export async function runtimeObservation(identity, childPid) {
    // This control is passed by the owning guest supervisor from the admitted original tar
    // member readback. The portable Electron artifact is never patched to provide these facts.
    const pinPath = process.env.HUB_RT_BINDING;
    assert.ok(pinPath && path.isAbsolute(pinPath) && await realpath(pinPath)===pinPath,'native-binding-path');
    const pinned = await open(pinPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let raw;
    try {
        const before = await pinned.stat();
        assert.ok(before.isFile() && before.nlink===1 && before.uid===0 && before.gid===0 &&
            (before.mode&0o222)===0 && before.size>0 && before.size<=4096,'native-binding-owner-and-bound');
        raw = await pinned.readFile('utf8');
        const after = await pinned.stat();
        assert.equal(raw.length,before.size,'native-binding-length');
        assert.equal(before.ctimeMs,after.ctimeMs,'native-binding-unchanged');
    } finally {
        await pinned.close();
    }
    const expected=JSON.parse(raw);
    assert.equal(expected.asset,'Diagnostic-Hub-linux-x64.tar.gz','native-tar-only-observer');
    for (const [kind, leaf] of [['executable','diagnostic-hub'],['asar','resources/app.asar']]) {
        const file = path.join(expected.root,leaf);
        assert.ok(path.isAbsolute(file) && await realpath(file)===file,'native-owned-runtime-file');
        assert.equal(expected[kind],file,'native-expected-runtime-file');
        assert.equal(await hashOriginalMember(file),expected[kind+'SHA256'],'native-original-member-content');
    }
    return verifyRenderer({
        identity,childPid,baselinePid:process.pid,uid:process.getuid(),expected,
        capture:(target)=>stableProcess('/proc',target),
    });
}

export async function mapOverview(application, requireVisible) {
    const page = await application.firstWindow();
    await page.waitForURL('app://bundle/index.html');
    await requireVisible(page.getByRole('heading', { name: 'Device overview' }));
    await application.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length !== 1 || !windows[0].isVisible() ||
            windows[0].webContents.getURL() !== 'app://bundle/index.html')
            throw Error('Native visible window does not identify one packaged BrowserWindow.');
    });
}

// The owned child process and its stdio must actually close. An early exit or exitCode
// alone cannot supply the close event required by this evidence contract.
export async function observeSession({ launch, mapWindow, verify, retire, commit, observeRetirement = () => {}, rejected = () => false, quitMs = 88000, verificationStage = 'renderer' }) {
    assert.ok(['renderer','identity'].includes(verificationStage));
    const end = performance.now() + quitMs;
    let application, child, listener, closed, timer, browserVerified = false;
    let stage = 'launch';
    let failure;
    let quit='unreached', extraction='unreached';
    try {
        application = await launch();
        child = application.process();
        assert.ok(!rejected() && pid(child?.pid) && child.exitCode === null && child.signalCode === null);
        closed = new Promise((resolve) => {
            listener = (code, signal) => resolve({ code, signal });
            child.once('close', listener);
        });
        stage = 'window';
        await mapWindow(application);
        assert.ok(!rejected());
        stage = verificationStage;
        browserVerified = await verify(application, child.pid);
        assert.ok(browserVerified && !rejected());
    } catch (error) {
        failure = error instanceof ProcIdentityUnavailable && stage === 'renderer'
            ? 'renderer-proc-unavailable' : stage;
    } finally {
        if (application) {
            try {
                await Promise.race([
                    (async () => {
                        // A child already exited before a requested normal quit cannot
                        // satisfy normal-quit evidence.
                        const running = closed && child.exitCode === null && child.signalCode === null;
                        await application.close();
                        assert.ok(running);
                        assert.deepEqual(await closed, { code: 0, signal: null });
                        assert.ok(!rejected());
                    })(),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(Error('normal-quit-deadline')),
                            Math.max(0, end - performance.now()));
                    }),
                ]);
                quit='pass';
            } catch {
                quit=closed?'fail':'unreached';
                failure ??= 'quit';
            } finally {
                clearTimeout(timer);
                if (listener) child.off('close', listener);
            }
        }
    }
    if (retire && quit==='pass') {
        try {
            await retire();
            extraction='pass';
        } catch {
            extraction='fail';
            failure ??= 'extraction';
        }
    }
    observeRetirement({quit,extraction});
    if (failure) return failure;
    try {
        assert.ok(!rejected());
        await commit(browserVerified);
        assert.ok(!rejected());
    } catch {
        return 'record';
    }
    return 'pass';
}

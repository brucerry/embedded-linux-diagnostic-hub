// Additional test-side checks for the unchanged tracked archive runtime observer.
import assert from 'node:assert/strict';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const pid = (n) => Number.isSafeInteger(n) && n > 1;
const max = 16384;

export function statRow(raw, expected) {
    assert.ok(raw.length <= max, 'proc-stat-bound');
    const match = raw.match(/^(\d+) \((.*)\) ([A-Z]) (\d+) (.*)\n$/);
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

async function stableProcess(proc, processId) {
    const dir = path.posix.join(proc,String(processId));
    const snapshot = () => readFile(dir+'/stat','ascii').then((raw) => statRow(raw,processId));
    const before = await snapshot();
    const fields = status(await readFile(dir+'/status','ascii'));
    const argv = (await readFile(dir+'/cmdline')).toString('utf8').split('\0');
    assert.ok(argv.length > 1 && argv.length <= 512 && argv.at(-1)==='' &&
              argv.join('\0').length <= max,'proc-command-bound');
    const executable = await readlink(dir+'/exe');
    const userNS = await readlink(dir+'/ns/user');
    const pidNS = await readlink(dir+'/ns/pid');
    assert.match(userNS,/^user:\[\d+\]$/,'proc-user-namespace');
    assert.match(pidNS,/^pid:\[\d+\]$/,'proc-pid-namespace');
    equalStartPair(before, await snapshot());
    return { ...before, fields, argv, executable, userNS, pidNS };
}

function ordinary(row, uid) {
    assert.deepEqual(row.fields.Uid,[uid,uid,uid,uid],'native-ordinary-user');
    assert.deepEqual(row.fields.CapEff,['0000000000000000'],'native-effective-capabilities');
    assert.deepEqual(row.fields.CapPrm,['0000000000000000'],'native-permitted-capabilities');
    assert.ok(!row.argv.includes('--no-sandbox') && !row.argv.includes('--disable-setuid-sandbox'),
              'native-sandbox-argv');
}

export async function verifyRenderer({ identity, childPid, baselinePid, uid, expected, capture }) {
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
        equalStartPair({ pid:pinned.pid,parent:pinned.parent,start:pinned.start },
                       { pid:after.pid,parent:after.parent,start:after.start });
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

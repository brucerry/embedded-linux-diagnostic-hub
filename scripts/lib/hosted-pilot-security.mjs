import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { digest, metadataIdentity, ancestryIdentity, checkAncestry } from './windows-preflight.mjs';
/** Readback policy is pilot-specific. Ordinary collection owner admission is untouched. */
export function pilotHostedContext(
    env = process.env,
    {
        platform = process.platform,
        identity = metadataIdentity,
        realpath = fs.realpathSync,
        ancestry = ancestryIdentity,
        tmp = os.tmpdir(),
        mode = 'pilot',
    } = {},
) {
    assert.equal(platform, 'win32');
    assert(['pilot', 'winps-contract'].includes(mode));
    if (mode === 'winps-contract') assert.notEqual(env.HUB_WINDOWS_NATIVE_PILOT, '1');
    for (const [k, v] of Object.entries({
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'X64',
        GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_RUN_ATTEMPT: '1',
        ...(mode === 'pilot'
            ? { HUB_WINDOWS_NATIVE_PILOT: '1' }
            : { HUB_WINDOWS_PILOT_WINPS_CONTRACT: '1' }),
    }))
        assert.equal(env[k], v, 'Pilot context ' + k);
    assert.notEqual(env.HUB_WINDOWS_PREFLIGHT_ONLY, '1');
    assert(!env.ELECTRON_DISABLE_SANDBOX, 'Pilot cannot inherit disabled sandbox');
    assert.notEqual(env.ELECTRON_RUN_AS_NODE, '1');
    assert(/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID));
    assert(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA));
    const profile = realpath(env.USERPROFILE);
    assert(/^C:\\Users\\[^\\]+$/i.test(profile));
    const parent = path.win32.join(profile, 'AppData', 'Local', 'Temp');
    const physical = (p) => {
        const r = identity(p);
        assert(r.directory && !r.file && r.realpath === p);
        return r;
    };
    const p = physical(parent),
        canonical = physical(realpath(tmp)),
        local = physical(realpath(env.LOCALAPPDATA));
    assert.equal(p.dev, canonical.dev);
    assert.equal(p.ino, canonical.ino);
    const expectedLocal = physical(path.win32.join(profile, 'AppData', 'Local'));
    assert.equal(local.dev, expectedLocal.dev);
    assert.equal(local.ino, expectedLocal.ino);
    const preserved = Object.fromEntries(
            ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA'].map((k) => [k, env[k]]),
        ),
        ancestors = ancestry(parent);
    return {
        parent,
        host: {
            repository: env.GITHUB_REPOSITORY,
            run: env.GITHUB_RUN_ID,
            attempt: '1',
            commit: env.GITHUB_SHA,
            environment: 'github-hosted',
        },
        check() {
            for (const [k, v] of Object.entries(preserved)) assert.equal(env[k], v);
            checkAncestry(ancestors);
        },
    };
}
function sid(ace, flags) {
    const b = Buffer.from(ace.binary, 'base64');
    assert.equal(b.toString('base64'), ace.binary);
    assert.equal(ace.type, 0);
    assert.equal(ace.flags, flags);
    assert(b.length >= 20 && b[0] === 0 && b[1] === flags);
    assert.equal(b.readUInt16LE(2), b.length);
    assert.equal(b.readUInt32LE(4), 0x1f01ff);
    const n = b[9];
    assert(b[8] === 1 && n >= 1 && n <= 15 && b.length === 16 + 4 * n);
    let a = 0n;
    for (const v of b.subarray(10, 16)) a = (a << 8n) | BigInt(v);
    return (
        'S-1-' + a + Array.from({ length: n }, (_, i) => '-' + b.readUInt32LE(16 + 4 * i)).join('')
    );
}
export function parsePilotSecurity(text, plans, principal) {
    assert(Buffer.byteLength(text) <= 65536);
    const v = JSON.parse(text.replace(/^\uFEFF/, ''));
    assert.equal(v.schema, 1);
    assert.equal(v.complete, true);
    assert(/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(v.principal));
    if (principal) assert.equal(v.principal, principal);
    assert(Array.isArray(v.rows) && v.rows.length === plans.length);
    const trusted = ['S-1-5-18', 'S-1-5-32-544', v.principal].sort();
    let group;
    v.rows.forEach((r, i) => {
        assert.equal(r.path, plans[i].path);
        assert.equal(r.kind, plans[i].kind);
        assert(trusted.includes(r.owner));
        assert.equal(r.group, v.principal.replace(/-\d+$/, '-513'));
        group ??= r.group;
        assert.equal(r.group, group);
        assert(r.daclPresent === true && r.daclNull === false && r.aces.length === 3);
        assert.deepEqual(r.aces.map((a) => sid(a, r.kind === 'file' ? 16 : 19)).sort(), trusted);
        const bytes = Buffer.from(r.binary, 'base64');
        assert(bytes.length >= 20 && bytes.length <= 8192);
        assert.equal(bytes.toString('base64'), r.binary);
        r.descriptorSHA256 = digest(bytes);
    });
    return v;
}

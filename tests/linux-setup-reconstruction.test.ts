import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import {
    createLinuxReviewDisk,
    linuxReviewSourceRoot,
    reviewLinuxAppDir,
    type LinuxReviewHost,
    type LinuxReviewIO,
    type LinuxReviewNode,
} from '../electron/linux-setup-review';
import { SetupTransaction, type SetupContext } from '../electron/setup-transaction';
import {
    verifyLinuxSuccessor,
    type LinuxSuccessorBinding,
    type LinuxSuccessorReply,
    type LinuxKernelSuccessor,
} from '../electron/linux-setup-successor';
import {
    INSTALLATION_MANIFEST,
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
} from '../shared/installation';
import { maintenancePaths, SETUP_OWNER, SETUP_PAYLOAD } from '../electron/installation-maintenance';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const uuid = '11111111-1111-4111-8111-111111111111';
function fixture() {
    const host: LinuxReviewHost = {
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
        euid: 1000,
        home: '/home/test',
        appData: '/home/test/data',
        sourceRoot: '/home/test/source',
        version: '0.6.0',
    };
    const root = '/home/test/installed',
        nodes = new Map<string, LinuxReviewNode>(),
        content = new Map<string, Buffer>(),
        calls: string[] = [];
    let inode = 1;
    const directory = (file: string) => {
        if (nodes.has(file)) return;
        if (file !== '/') directory(path.posix.dirname(file));
        nodes.set(file, {
            kind: 'directory',
            uid: file.startsWith('/home/test') ? 1000 : 0,
            mode: 0o40700,
            dev: 1,
            ino: inode++,
            nlink: 1,
            size: 0,
            mtimeMs: 1,
            ctimeMs: 1,
        });
    };
    const file = (name: string, bytes: string) => {
        directory(path.posix.dirname(name));
        content.set(name, Buffer.from(bytes));
        nodes.set(name, {
            kind: 'file',
            uid: 1000,
            mode: 0o100600,
            dev: 1,
            ino: inode++,
            nlink: 1,
            size: Buffer.byteLength(bytes),
            mtimeMs: 1,
            ctimeMs: 1,
        });
    };
    const manifest = (version: string) => ({
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        layout: 'linux-folder',
        platform: 'linux',
        arch: 'x64',
        version,
        sourceCommit: 'a'.repeat(40),
        entryPoint: 'app/diagnostic-hub',
        files: [{ kind: 'file', path: 'app/diagnostic-hub', bytes: 7, sha256: hash('fixture') }],
    });
    const io: LinuxReviewIO = {
        async node(name) {
            calls.push('node:' + name);
            return nodes.has(name) ? { ...nodes.get(name)! } : null;
        },
        async canonical(name) {
            calls.push('canonical:' + name);
            return name;
        },
        async names(name, limit) {
            calls.push('names:' + name);
            const names = [...nodes.keys()]
                .filter((file) => file !== name && path.posix.dirname(file) === name)
                .map((file) => path.posix.basename(file));
            if (names.length > limit) throw Error('bound');
            return names;
        },
        async bytes(name, limit) {
            calls.push('bytes:' + name);
            const bytes = content.get(name);
            if (!bytes || bytes.length > limit) throw Error('missing or oversized metadata');
            return Buffer.from(bytes);
        },
        async digest(name, bytes) {
            calls.push('digest:' + name);
            const buffer = content.get(name);
            if (!buffer || buffer.length !== bytes) throw Error('length');
            return hash(buffer);
        },
    };
    directory(host.home);
    directory(host.appData);
    file(host.sourceRoot + '/' + SETUP_PAYLOAD, JSON.stringify(manifest(host.version)));
    file(host.sourceRoot + '/app/diagnostic-hub', 'fixture');
    const owned = (version = '0.5.2') => {
        const bytes = JSON.stringify(manifest(version));
        file(root + '/app/diagnostic-hub', 'fixture');
        file(root + '/' + INSTALLATION_MANIFEST, bytes);
        file(
            root + '/' + INSTALLATION_RECORD,
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId: uuid,
                manifestSHA256: hash(bytes),
                profile: 'dedicated',
            }),
        );
        file(
            root + '/' + SETUP_OWNER,
            JSON.stringify({
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId: uuid,
                root,
                integrations: [],
                options: { startMenu: false, desktop: false, launch: false },
            }),
        );
    };
    return { host, root, nodes, content, calls, io, file, directory, manifest, owned };
}
test('new Linux review validates source bytes but advertises no executable actions', async () => {
    const f = fixture(),
        result = await reviewLinuxAppDir(f.host, f.root, f.io);
    assert.equal(result.state, 'new');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.proposedActions, ['install']);
    assert.equal(result.qualification, 'source-review-only');
    assert.equal(result.options.launch, false);
    assert.match(result.reviewToken, /^[a-f0-9]{64}$/);
    assert.equal(f.nodes.has(f.root), false);
});
test('owned Linux review preserves UUID/profile and refuses downgrade proposals', async () => {
    const f = fixture();
    f.owned();
    const result = await reviewLinuxAppDir(f.host, f.root, f.io);
    assert.equal(result.state, 'owned');
    assert.deepEqual(result.proposedActions, ['launch', 'update']);
    assert.equal(result.profile, f.host.appData + '/DiagnosticHub/profiles/' + uuid);
    assert.deepEqual(result.actions, []);
    f.owned('0.7.0');
    assert.deepEqual((await reviewLinuxAppDir(f.host, f.root, f.io)).proposedActions, ['launch']);
});
for (const delta of [{ platform: 'darwin' }, { arch: 'arm64' }, { uid: 0 }, { euid: 0 }])
    test('unsupported host refused before IO: ' + JSON.stringify(delta), async () => {
        const f = fixture();
        await assert.rejects(
            reviewLinuxAppDir({ ...f.host, ...delta }, f.root, f.io),
            /ordinary-user/,
        );
        assert.equal(f.calls.length, 0);
    });
for (const destination of [
    '/home/test',
    '/home/test/../escape',
    '/home/test/source/new',
    '/home/test/data/app',
    '/outside/app',
    '/home/test/bad\\name',
])
    test('unsafe destination preserved: ' + destination, async () => {
        const f = fixture();
        await assert.rejects(reviewLinuxAppDir(f.host, destination, f.io));
        assert.equal(f.nodes.has(f.root), false);
    });
for (const delta of [{ kind: 'other' as const }, { uid: 2000 }, { mode: 0o40777 }])
    test('parent alias/ownership/shared write refusal: ' + JSON.stringify(delta), async () => {
        const f = fixture();
        Object.assign(f.nodes.get(f.host.home)!, delta);
        await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io), /owned directories/);
    });
test('missing source descriptor, wrong version and corrupt payload refuse without effects', async () => {
    const f = fixture();
    f.content.delete(f.host.sourceRoot + '/' + SETUP_PAYLOAD);
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io));
    f.file(f.host.sourceRoot + '/' + SETUP_PAYLOAD, JSON.stringify(f.manifest('0.5.2')));
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io), /version/);
    f.file(f.host.sourceRoot + '/' + SETUP_PAYLOAD, JSON.stringify(f.manifest('0.6.0')));
    f.content.set(f.host.sourceRoot + '/app/diagnostic-hub', Buffer.from('changed'));
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io), /checksum/);
});
test('foreign destination and foreign owned children are preserved', async () => {
    const f = fixture();
    f.file(f.root + '/foreign.txt', 'keep');
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io));
    f.owned();
    const before = new Map(f.content);
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io), /Foreign/);
    assert.deepEqual(f.content, before);
});
test('existing maintenance state is refused without reading it', async () => {
    const f = fixture(),
        work = maintenancePaths(f.root).work;
    f.directory(work);
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io), /recovery/);
    assert.equal(
        f.calls.some((call) => call.startsWith('bytes:' + work)),
        false,
    );
});
test('parent mutation and missing ancestor creation are refused', async () => {
    for (const makeMissing of [false, true]) {
        const f = fixture();
        const original = f.io.digest.bind(f.io);
        f.io.digest = async (...args) => {
            const value = await original(...args);
            if (makeMissing) f.directory(f.root);
            else f.nodes.get(f.host.home)!.ino++;
            return value;
        };
        await assert.rejects(
            reviewLinuxAppDir(f.host, f.root, f.io),
            /identity changed|location changed/,
        );
    }
});
test('read failure and source/owner mutations propagate, never becoming a verified review', async () => {
    const f = fixture();
    f.owned();
    const original = f.io.digest.bind(f.io);
    f.io.digest = async (...args) => {
        const value = await original(...args);
        if (args[0].startsWith(f.root)) f.nodes.get(f.root + '/' + SETUP_OWNER)!.mtimeMs++;
        return value;
    };
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io), /location changed/);
    f.io.digest = async () => {
        throw Error('inert read failure');
    };
    await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io), /inert read failure/);
});
test('Linux SetupTransaction probe delegates read-only; every effect entry refuses before adapters', async () => {
    const f = fixture();
    let effects = 0;
    const forbidden = async () => {
        effects++;
        throw Error('unexpected effect');
    };
    const context = {
        ...f.host,
        linuxReview: { uid: 1000, euid: 1000, io: f.io },
        busy: forbidden,
        ownerAlive: forbidden,
        processIdentity: forbidden,
        integrate: forbidden,
        validateIntegrations: forbidden,
        removeIntegrations: forbidden,
        launch: forbidden,
        successorObserved: forbidden,
    } as unknown as SetupContext;
    const engine = new SetupTransaction(context);
    assert.deepEqual((await engine.probe(f.root)).actions, []);
    await assert.rejects(
        engine.install(
            f.root,
            'install',
            { startMenu: false, desktop: false, launch: false },
            'x',
            true,
            '',
        ),
        /not implemented/,
    );
    await assert.rejects(engine.remove(f.root, 'x', true), /not implemented/);
    await assert.rejects(engine.rollback(f.root, 'x', true), /not implemented/);
    await assert.rejects(engine.finalize(f.root), /not implemented/);
    await assert.rejects(engine.launch(f.root), /not implemented/);
    assert.equal(effects, 0);
});
function successor() {
    const expected: LinuxSuccessorBinding = {
        root: '/home/test/installed',
        installationId: uuid,
        transactionId: uuid,
        manifestSHA256: 'b'.repeat(64),
        version: '0.6.0',
        profile: '/home/test/data/profiles/' + uuid,
        uid: 1000,
        pid: 4321,
        startTicks: '1234',
        activatedAtMs: 10000,
        nonce: 'c'.repeat(64),
    };
    const reply: LinuxSuccessorReply = {
        ...expected,
        executable: expected.root + '/app/diagnostic-hub',
        observedAtMs: 11000,
        window: '0100',
        visible: true,
        minimized: false,
        responsive: true,
        trustedMainFrame: true,
        normalInvocation: true,
        listenerInode: '5678',
    };
    const kernel: LinuxKernelSuccessor = {
        creationTimeMs: 10000,
        uid: expected.uid,
        pid: expected.pid,
        startTicks: expected.startTicks,
        executable: reply.executable,
        profile: expected.profile,
        listenerInode: reply.listenerInode,
        normalInvocation: true,
    };
    const key = Buffer.alloc(32, 7);
    const sign = (r = reply) =>
        createHmac('sha256', key)
            .update(
                JSON.stringify([
                    r.root,
                    r.installationId,
                    r.transactionId,
                    r.manifestSHA256,
                    r.version,
                    r.profile,
                    r.uid,
                    r.pid,
                    r.startTicks,
                    r.activatedAtMs,
                    r.nonce,
                    r.executable,
                    r.observedAtMs,
                    r.window,
                    r.visible,
                    r.minimized,
                    r.responsive,
                    r.trustedMainFrame,
                    r.normalInvocation,
                    r.listenerInode,
                ]),
            )
            .digest('hex');
    return { expected, reply, kernel, key, sign };
}
test('Linux successor verifier requires signed exact independent kernel/window/profile facts', () => {
    const f = successor();
    assert.equal(verifyLinuxSuccessor(f.expected, f.reply, f.kernel, f.sign(), f.key, 11500), true);
    for (const change of [
        { pid: 99 },
        { uid: 0 },
        { startTicks: '999' },
        { executable: '/wrong' },
        { profile: '/wrong' },
        { listenerInode: '999' },
        { normalInvocation: false },
        { creationTimeMs: 9999 },
        { creationTimeMs: 11001 },
    ])
        assert.equal(
            verifyLinuxSuccessor(
                f.expected,
                f.reply,
                { ...f.kernel, ...change },
                f.sign(),
                f.key,
                11500,
            ),
            false,
        );
});
test('even correctly signed hidden/stale/forged successor claims cannot authorize cleanup', () => {
    const f = successor();
    for (const change of [
        { visible: false },
        { minimized: true },
        { responsive: false },
        { trustedMainFrame: false },
        { normalInvocation: false },
        { window: '0000' },
        { nonce: 'd'.repeat(64) },
        { version: '0.5.2' },
        { observedAtMs: 9000 },
        { observedAtMs: 12000 },
        { extra: 'unrecognized' },
    ]) {
        const reply = { ...f.reply, ...change };
        assert.equal(
            verifyLinuxSuccessor(f.expected, reply, f.kernel, f.sign(reply), f.key, 11500),
            false,
            JSON.stringify(change),
        );
    }
    assert.equal(
        verifyLinuxSuccessor(f.expected, f.reply, f.kernel, f.sign(), f.key, 13000),
        false,
    );
    assert.equal(
        verifyLinuxSuccessor(f.expected, f.reply, f.kernel, '0'.repeat(64), f.key, 11500),
        false,
    );
    assert.equal(
        verifyLinuxSuccessor(f.expected, f.reply, f.kernel, f.sign(), Buffer.alloc(31), 11500),
        false,
    );
    assert.equal(
        verifyLinuxSuccessor(
            f.expected,
            null as unknown as LinuxSuccessorReply,
            f.kernel,
            '',
            f.key,
            11500,
        ),
        false,
    );
});

function diskFixture(text = 'abc') {
    let opened = 0,
        closed = 0,
        flags = 0,
        reads = 0;
    const bytes = Buffer.from(text);
    const shape = {
        uid: 1000,
        mode: 0o100600,
        dev: 1,
        ino: 7,
        nlink: 1,
        size: bytes.length,
        mtimeMs: 1,
        ctimeMs: 1,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
    };
    const state = { before: shape, active: { ...shape }, after: { ...shape }, failRead: false };
    let stats = 0;
    const filesystem = {
        async lstat() {
            return stats++ === 0 ? state.before : state.after;
        },
        async realpath(file: string) {
            return file;
        },
        async open(_file: string, value: number) {
            opened++;
            flags = value;
            return {
                async stat() {
                    return state.active;
                },
                async read(buffer: Buffer, offset: number, length: number, position: number) {
                    reads++;
                    if (state.failRead) throw Error('inert IO refusal');
                    const count = Math.min(length, 2, Math.max(0, bytes.length - position));
                    bytes.copy(buffer, offset, position, position + count);
                    return { bytesRead: count, buffer };
                },
                async close() {
                    closed++;
                },
            };
        },
    } as unknown as NonNullable<Parameters<typeof createLinuxReviewDisk>[0]>;
    return {
        io: createLinuxReviewDisk(filesystem),
        state,
        counts: () => ({ opened, closed, flags, reads }),
    };
}
test('disk metadata reader handles partial reads, exact EOF and non-follow/nonblocking flags', async () => {
    const f = diskFixture();
    assert.deepEqual(await f.io.bytes('/owned/metadata', 8, 1000), Buffer.from('abc'));
    const { constants } = await import('node:fs');
    assert.equal(f.counts().flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
    assert.equal(f.counts().flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
    assert.deepEqual(
        { opened: f.counts().opened, closed: f.counts().closed },
        { opened: 1, closed: 1 },
    );
    assert.equal(f.counts().reads, 3);
});
for (const change of [
    { isFile: () => false },
    { isSymbolicLink: () => true },
    { nlink: 2 },
    { uid: 99 },
    { mode: 0o100644 },
    { size: 9 },
])
    test(
        'disk metadata refuses nonprivate/nonregular/oversized input before open: ' +
            Object.keys(change)[0],
        async () => {
            const f = diskFixture();
            Object.assign(f.state.before, change);
            await assert.rejects(f.io.bytes('/owned/metadata', 8, 1000));
            assert.equal(f.counts().opened, 0);
            assert.equal(f.counts().reads, 0);
        },
    );
test('disk readers retain errors and close their returned handles on read/change refusal', async () => {
    for (const problem of ['read', 'descriptor', 'path', 'size'] as const) {
        const f = diskFixture();
        if (problem === 'read') f.state.failRead = true;
        if (problem === 'descriptor') f.state.active.ino++;
        if (problem === 'path') f.state.after.ino++;
        if (problem === 'size') {
            f.state.before.size = 2;
            f.state.active.size = 2;
            f.state.after.size = 2;
        }
        await assert.rejects(f.io.bytes('/owned/metadata', 8, 1000));
        assert.equal(f.counts().closed, 1);
    }
    const f = diskFixture('fixture');
    assert.equal(await f.io.digest('/owned/app', 7, 1000), hash('fixture'));
    assert.equal(f.counts().closed, 1);
});
test('links, wrong layout, installation digest and foreign menu ownership are preserved', async () => {
    for (const problem of ['link', 'layout', 'digest', 'menu', 'metadata'] as const) {
        const f = fixture();
        f.owned();
        if (problem === 'link')
            f.nodes.get(f.host.sourceRoot + '/app/diagnostic-hub')!.kind = 'other';
        if (problem === 'layout')
            f.file(
                f.host.sourceRoot + '/' + SETUP_PAYLOAD,
                JSON.stringify({ ...f.manifest('0.6.0'), layout: 'linux-appimage' }),
            );
        if (problem === 'digest') {
            const file = f.root + '/' + INSTALLATION_RECORD;
            const record = JSON.parse(f.content.get(file)!.toString());
            f.file(file, JSON.stringify({ ...record, manifestSHA256: '0'.repeat(64) }));
        }
        if (problem === 'menu' || problem === 'metadata') {
            const file = f.root + '/' + SETUP_OWNER;
            const owner = JSON.parse(f.content.get(file)!.toString());
            f.file(
                file,
                JSON.stringify(
                    problem === 'menu'
                        ? { ...owner, integrations: [{ kind: 'menu', path: '/foreign' }] }
                        : { ...owner, unknown: true },
                ),
            );
        }
        const before = new Map(f.content);
        await assert.rejects(reviewLinuxAppDir(f.host, f.root, f.io));
        assert.deepEqual(f.content, before);
    }
});

test('Linux worker source binding uses only explicit ROOT/app/diagnostic-hub shape', () => {
    assert.equal(
        linuxReviewSourceRoot('/home/test/source/app/diagnostic-hub'),
        '/home/test/source',
    );
    for (const executable of [
        '/home/test/source/diagnostic-hub',
        '/home/test/source/app/Diagnostic-Hub.AppImage',
        '/home/test/source/app/../diagnostic-hub',
        'app/diagnostic-hub',
    ])
        assert.throws(() => linuxReviewSourceRoot(executable), /complete-folder/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readSync } from 'node:fs';
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
    assertLinuxPermanentMemberModes,
    readLinuxTarPermanentMembers,
    verifyLinuxPermanentDirectoryModes,
} from '../scripts/lib/linux-permanent-member-modes.mjs';

const rootName = 'Diagnostic-Hub-linux-x64';
const archiveName = rootName + '.tar.gz';
type Member = { path: string; kind: 'file' | 'directory'; mode?: number };
const linuxOnly = { skip: process.platform !== 'linux' };
const required = [
    { path: 'resources/linux-installed-AppRun', kind: 'file', mode: 0o755 },
    { path: 'resources/linux-setup-bootstrap.cjs', kind: 'file', mode: 0o644 },
    { path: 'resources/linux-setup-install.cjs', kind: 'file', mode: 0o644 },
    { path: 'resources/diagnostic_hub_rename_noreplace.node', kind: 'file', mode: 0o644 },
] satisfies Array<Member & { mode: number }>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(context: TestContext) {
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-permanent-mode-fixture-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

async function populate(directory: string) {
    await mkdir(path.join(directory, 'resources'));
    for (const member of required) {
        const destination = path.join(directory, member.path);
        await writeFile(destination, 'inert\n', { flag: 'wx' });
        await chmod(destination, member.mode);
    }
}

function tarEntry(member: Member & { body?: Buffer }) {
    const header = Buffer.alloc(512);
    const data =
        member.kind === 'directory' ? Buffer.alloc(0) : (member.body ?? Buffer.from('inert\n'));
    const field = (value: string, from: number, width: number) =>
        header.write(String(value), from, width, 'ascii');
    const number = (value: number, from: number, width: number) =>
        field(value.toString(8).padStart(width - 1, '0'), from, width);
    field(member.path, 0, 100);
    if (member.mode !== undefined) number(member.mode, 100, 8);
    number(0, 108, 8);
    number(0, 116, 8);
    number(data.length, 124, 12);
    number(0, 136, 12);
    header.fill(32, 148, 156);
    field(member.kind === 'directory' ? '5' : '0', 156, 1);
    field('ustar\0', 257, 6);
    field('00', 263, 2);
    number(
        header.reduce((sum, byte) => sum + byte, 0),
        148,
        8,
    );
    return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

async function archive(
    directory: string,
    files: (Member & { body?: Buffer })[],
    wrapper = rootName,
) {
    const entries: (Member & { body?: Buffer })[] = [
        { path: wrapper, kind: 'directory', mode: 0o755 },
        { path: wrapper + '/resources', kind: 'directory', mode: 0o755 },
        ...files.map((entry) => ({ ...entry, path: wrapper + '/' + entry.path })),
    ];
    const raw = gzipSync(Buffer.concat([...entries.flatMap(tarEntry), Buffer.alloc(1024)]));
    const file = path.join(directory, archiveName);
    await writeFile(file, raw);
    return { file, expected: { bytes: raw.length, sha256: hash(raw) } };
}

const wrongMode = (entry: Member) => (entry.mode === 0o755 ? 0o700 : 0o600);

test('accepts exact modes on a real inert staging tree', linuxOnly, async (context) => {
    const directory = await fixture(context);
    await populate(directory);
    await verifyLinuxPermanentDirectoryModes(directory);
});

test('refuses the wrong mode on each staged member', linuxOnly, async (context) => {
    const directory = await fixture(context);
    await populate(directory);
    for (const member of required) {
        const file = path.join(directory, member.path);
        await chmod(file, wrongMode(member));
        await assert.rejects(
            verifyLinuxPermanentDirectoryModes(directory),
            (error: Error) =>
                error.message.includes('LINUX_PERMANENT_MEMBER_MODE') &&
                error.message.includes(member.path),
        );
        await chmod(file, member.mode);
    }
});

test(
    'refuses each missing member and refuses a symlink in its place',
    linuxOnly,
    async (context) => {
        const directory = await fixture(context);
        await populate(directory);
        for (const member of required) {
            const file = path.join(directory, member.path);
            await unlink(file);
            await assert.rejects(
                verifyLinuxPermanentDirectoryModes(directory),
                /must appear exactly once/,
            );
            await symlink(path.join(directory, 'inert-target'), file);
            await assert.rejects(
                verifyLinuxPermanentDirectoryModes(directory),
                /must appear exactly once/,
            );
            await unlink(file);
            await writeFile(file, 'inert\n');
            await chmod(file, member.mode);
        }
    },
);

test('refuses a linked resources directory', linuxOnly, async (context) => {
    const directory = await fixture(context);
    await populate(directory);
    await rename(path.join(directory, 'resources'), path.join(directory, 'inert-target'));
    await symlink('inert-target', path.join(directory, 'resources'));
    await assert.rejects(
        verifyLinuxPermanentDirectoryModes(directory),
        /resources must be a directory/,
    );
});

test(
    'accepts original archive modes with an independently supplied digest',
    linuxOnly,
    async (context) => {
        const { file, expected } = await archive(await fixture(context), required);
        const entries = await readLinuxTarPermanentMembers(file, { expected });
        assertLinuxPermanentMemberModes(entries);
        assert.equal(entries.length, required.length);
    },
);

test(
    'ordinary pre-checksum verification hands the same accepted descriptor to its consumer',
    linuxOnly,
    async (context) => {
        const { file } = await archive(await fixture(context), required);
        let called = false;
        await readLinuxTarPermanentMembers(file, {
            consume(fd, wrapper) {
                const magic = Buffer.alloc(2);
                assert.equal(readSync(fd, magic, 0, 2, null), 2);
                assert.equal(magic.toString('hex'), '1f8b');
                assert.equal(wrapper, rootName);
                called = true;
            },
        });
        assert.ok(called);
    },
);

test(
    'refuses each original wrong mode and skips extraction callback',
    linuxOnly,
    async (context) => {
        const directory = await fixture(context);
        for (const member of required) {
            const { file } = await archive(
                directory,
                required.map((item) =>
                    item.path === member.path ? { ...item, mode: wrongMode(item) } : item,
                ),
            );
            await assert.rejects(
                readLinuxTarPermanentMembers(file, {
                    consume: () => assert.fail('unexpected consumer'),
                }),
                (error: Error) =>
                    error.message.includes(member.path) && error.message.includes('expected'),
            );
        }
    },
);

test('refuses each absent archive member before extraction', linuxOnly, async (context) => {
    const directory = await fixture(context);
    for (const member of required) {
        const { file } = await archive(
            directory,
            required.filter((item) => item.path !== member.path),
        );
        await assert.rejects(
            readLinuxTarPermanentMembers(file, {
                consume: () => assert.fail('unexpected consumer'),
            }),
            (error: Error) =>
                error.message.includes(member.path) &&
                error.message.includes('must appear exactly once'),
        );
    }
});

test('refuses an archive header whose mode field is empty', linuxOnly, async (context) => {
    const directory = await fixture(context);
    const { file } = await archive(directory, [
        { ...required[0], mode: undefined },
        ...required.slice(1),
    ]);
    await assert.rejects(
        readLinuxTarPermanentMembers(file, { consume: () => assert.fail('unexpected consumer') }),
        /ARCHIVE_LAYOUT_INVALID/,
    );
});

test('refuses duplicate entries and a wrong root', linuxOnly, async (context) => {
    const directory = await fixture(context);
    const { file } = await archive(directory, [...required, required[0]]);
    await assert.rejects(readLinuxTarPermanentMembers(file), /ARCHIVE_LAYOUT_INVALID/);
    await archive(directory, required, 'Inert-Wrong-Root');
    await assert.rejects(readLinuxTarPermanentMembers(file), /LINUX_ARCHIVE_WRAPPER/);
});

test('refuses a wrong supplied archive hash or size', linuxOnly, async (context) => {
    const { file, expected } = await archive(await fixture(context), required);
    await assert.rejects(
        readLinuxTarPermanentMembers(file, {
            expected: { ...expected, sha256: '0'.repeat(64) },
        }),
        /ARCHIVE_FINAL_INVALID/,
    );
    await assert.rejects(
        readLinuxTarPermanentMembers(file, {
            expected: { ...expected, bytes: expected.bytes + 1 },
        }),
        /Linux archive size changed/,
    );
});

test('refuses a path replacement during consumption', linuxOnly, async (context) => {
    const { file } = await archive(await fixture(context), required);
    await assert.rejects(
        readLinuxTarPermanentMembers(file, {
            async consume() {
                await rename(file, file + '.old');
                await writeFile(file, 'replacement', { flag: 'wx' });
            },
        }),
        /Linux archive (path )?changed/,
    );
});

const afterPackInputs = {
    'dist-electron/linux-setup-review.cjs': 'review bundle',
    'dist-electron/linux-setup-install.cjs': 'installer bundle',
    'dist-electron/linux-setup-bootstrap.cjs': 'bootstrap bundle',
    'dist-linux-native/diagnostic_hub_rename_noreplace.node': 'native marker data',
    'scripts/linux-setup-install.sh': 'setup launcher',
    'scripts/linux-installed-launcher.sh': 'installed launcher',
    'scripts/linux-launcher.sh': 'portable launcher',
};

async function afterPackFixture(context: TestContext, createResources = true) {
    const root = await fixture(context);
    for (const relative of [
        'scripts/linux-after-pack.cjs',
        'scripts/lib/linux-review-after-pack.cjs',
        'scripts/lib/linux-review-package.mjs',
    ]) {
        const target = path.join(root, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(new URL('../' + relative, import.meta.url), target);
    }
    for (const [relative, content] of Object.entries(afterPackInputs)) {
        const target = path.join(root, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    }
    const appOutDir = path.join(root, 'linux-unpacked');
    const resources = path.join(appOutDir, 'resources');
    await mkdir(createResources ? resources : appOutDir, { recursive: true, mode: 0o700 });
    return { root, appOutDir, resources };
}

function runAfterPack(
    { root, appOutDir }: Awaited<ReturnType<typeof afterPackFixture>>,
    refusal: { code: string } | { message: string } | null = null,
) {
    const child = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import assert from 'node:assert/strict';
            import { pathToFileURL } from 'node:url';
            process.umask(0o077);
            const { default: afterPack } = await import(pathToFileURL(process.argv[1]));
            const run = () => afterPack({
                electronPlatformName: 'linux',
                arch: 1,
                appOutDir: process.argv[2],
                packager: { appInfo: { version: '0.6.0' } },
            });
            const refusal = JSON.parse(process.argv[3]);
            if (refusal) await assert.rejects(run, refusal);
            else await run();
            assert.equal(process.umask(), 0o077);`,
            path.join(root, 'scripts/linux-after-pack.cjs'),
            appOutDir,
            JSON.stringify(refusal),
        ],
        { encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
}

test(
    'Linux afterPack publishes permanent member modes under umask 0077',
    linuxOnly,
    async (context) => {
        const staged = await afterPackFixture(context);
        runAfterPack(staged);
        await verifyLinuxPermanentDirectoryModes(staged.appOutDir);

        const outputs = [
            ['resources/linux-installed-AppRun', 0o755, 'installed launcher'],
            ['resources/linux-setup-bootstrap.cjs', 0o644, 'bootstrap bundle'],
            ['resources/linux-setup-install.cjs', 0o644, 'installer bundle'],
            ['resources/diagnostic_hub_rename_noreplace.node', 0o644, 'native marker data'],
            ['resources/linux-setup-install.sh', 0o700, 'setup launcher'],
            ['resources/linux-setup-review.cjs', 0o600, 'review bundle'],
            ['resources/linux-setup-review.json', 0o600],
            ['AppRun', 0o755, 'portable launcher'],
        ] as const;
        for (const [relative, mode, content] of outputs) {
            const target = path.join(staged.appOutDir, relative);
            const observed = await lstat(target);
            assert.ok(observed.isFile());
            assert.equal(observed.mode & 0o7777, mode, relative);
            if (content !== undefined) assert.equal(await readFile(target, 'utf8'), content);
        }
        for (const [relative, content] of Object.entries(afterPackInputs)) {
            const file = path.join(staged.root, relative);
            assert.equal((await lstat(file)).mode & 0o7777, 0o600, relative);
            assert.equal(await readFile(file, 'utf8'), content);
        }
    },
);

test(
    'afterPack bytes and modes survive an inert archive round-trip',
    linuxOnly,
    async (context) => {
        const staged = await afterPackFixture(context);
        runAfterPack(staged);
        const fromDisk = async () =>
            Promise.all(
                required.map(async ({ path: relative, kind }) => {
                    const file = path.join(staged.appOutDir, relative);
                    const observed = await lstat(file);
                    assert.ok(observed.isFile());
                    return {
                        path: relative,
                        kind,
                        mode: observed.mode & 0o7777,
                        body: await readFile(file),
                    };
                }),
            );
        const files = await fromDisk();
        const { file, expected } = await archive(staged.root, files);
        const exact = await readLinuxTarPermanentMembers(file, { expected });
        assertLinuxPermanentMemberModes(exact);
        for (const entry of exact) {
            assert.ok(entry.kind === 'file');
            const original = files.find(({ path: relative }) => relative === entry.path);
            assert.ok(original);
            assert.equal(entry.mode, original.mode);
            assert.equal(entry.bytes, original.body.length);
            assert.equal(entry.sha256, hash(original.body));
        }

        // An otherwise self-consistent archive must not make a bad member mode consumable.
        await chmod(path.join(staged.appOutDir, required[0].path), 0o700);
        const drift = await archive(staged.root, await fromDisk());
        assert.notEqual(drift.expected.sha256, expected.sha256);
        await assert.rejects(
            readLinuxTarPermanentMembers(drift.file, {
                expected: drift.expected,
                consume: () => assert.fail('incorrect mode reached the archive consumer'),
            }),
            /LINUX_PERMANENT_MEMBER_MODE/,
        );
    },
);

for (const kind of ['regular file', 'symlink'] as const) {
    test(
        `Linux afterPack preserves a pre-existing permanent ${kind}`,
        linuxOnly,
        async (context) => {
            const staged = await afterPackFixture(context);
            const member = path.join(staged.resources, 'linux-setup-install.cjs');
            const existing = kind === 'symlink' ? path.join(staged.root, 'sentinel') : member;
            await writeFile(existing, 'untouched', { mode: 0o600, flag: 'wx' });
            if (kind === 'symlink') await symlink(existing, member);
            const before = await lstat(existing);
            const destination = await lstat(member);

            runAfterPack(staged, { code: 'EEXIST' });

            const after = await lstat(existing);
            assert.equal(after.ino, before.ino);
            assert.equal(after.mode, before.mode);
            assert.equal(await readFile(existing, 'utf8'), 'untouched');
            const memberAfter = await lstat(member);
            assert.equal(memberAfter.ino, destination.ino);
            assert.equal(memberAfter.mode, destination.mode);
            if (kind === 'symlink') assert.equal(await readlink(member), existing);
        },
    );
}

test('Linux afterPack refuses an aliased resources directory', linuxOnly, async (context) => {
    const staged = await afterPackFixture(context, false);
    const alias = path.join(staged.root, 'existing-directory');
    await mkdir(alias, { mode: 0o700 });
    await symlink(alias, staged.resources);
    runAfterPack(staged, { message: 'LINUX_REVIEW_OUTPUT_ALIAS' });
    assert.equal(await readlink(staged.resources), alias);
    await assert.rejects(lstat(path.join(alias, 'linux-setup-review.cjs')), { code: 'ENOENT' });
});

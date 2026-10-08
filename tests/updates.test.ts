import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ReleaseUpdater } from '../electron/updates';

const binary = Buffer.from('MZverified-portable-test-data');
const sha = createHash('sha256').update(binary).digest('hex');
function release(
    version: string,
    prerelease = false,
    filename = 'Diagnostic-Hub.exe',
    data = binary,
) {
    const base = `https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/download/v${version}/`;
    return {
        tag_name: `v${version}`,
        prerelease,
        draft: false,
        published_at: '2026-10-07T00:00:00Z',
        body: 'Release notes',
        assets: [
            { name: filename, size: data.length, browser_download_url: base + filename },
            {
                name: `${filename}.sha256`,
                size: 100,
                browser_download_url: `${base}${filename}.sha256`,
            },
        ],
    };
}
function fixture(
    releases: unknown[],
    options: {
        data?: Buffer;
        checksum?: string;
        packaged?: boolean;
        platform?: string;
        arch?: string;
    } = {},
) {
    const requests: string[] = [];
    const request: typeof fetch = async (url) => {
        requests.push(String(url));
        if (String(url).includes('/repos/')) return Response.json(releases);
        if (String(url).endsWith('.sha256'))
            return new Response(options.checksum ?? `${sha}  Diagnostic-Hub.exe\n`);
        return new Response(new Uint8Array(options.data ?? binary));
    };
    return {
        requests,
        request,
        updater: (directory: string) =>
            new ReleaseUpdater(
                '0.1.0',
                directory,
                options.platform ?? 'win32',
                options.arch ?? 'x64',
                options.packaged ?? true,
                request,
            ),
    };
}

test('updates select by semantic version, including prereleases optionally, and reject drafts or unrelated URLs', async () => {
    const untrusted = release('9.0.0');
    untrusted.assets[0].browser_download_url = 'https://untrusted.example/Diagnostic-Hub.exe';
    const draft = { ...release('10.0.0'), draft: true };
    const f = fixture([
        release('0.1.0'),
        release('0.2.1'),
        release('0.3.0-rc.2', true),
        release('0.3.0-rc.10', true),
        release('0.2.0'),
        untrusted,
        draft,
    ]);
    const updater = f.updater('/unused');
    assert.equal((await updater.check(true)).release?.version, '0.3.0-rc.10');
    assert.equal((await updater.check(false)).release?.version, '0.2.1');
    assert.equal(
        f.requests.length,
        2,
        'Checks only request metadata, never download an executable.',
    );
    await assert.rejects(
        () => updater.check('yes' as unknown as boolean),
        /Invalid release selection/,
    );
    assert.equal(
        (
            await fixture([release('0.1.0')])
                .updater('/unused')
                .check(true)
        ).release,
        null,
    );
    assert.equal(
        (
            await fixture([release('1.0.0')], { arch: 'ia32' })
                .updater('/unused')
                .check(true)
        ).installable,
        false,
    );
});

test('verified portable download is staged in a user directory and checked again before restart', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-update-'));
    try {
        const updater = fixture([release('0.2.0')]).updater(directory);
        await assert.rejects(() => updater.executable(), /Download and verify/);
        await updater.check(true);
        const file = await updater.download();
        assert.ok(file.startsWith(directory + path.sep));
        assert.deepEqual(await readFile(file), binary);
        assert.equal((await stat(file)).mode & 0o777, 0o700);
        assert.equal(await updater.executable(), file);
        assert.equal(
            (await updater.check(true)).readyPath,
            file,
            'Reopening the dialog keeps the verified download.',
        );
        await writeFile(file, 'tampered');
        await assert.rejects(() => updater.executable(), /has changed/);
        assert.equal(
            (await updater.check(true)).readyPath,
            undefined,
            'A changed cached executable is never offered for restart.',
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('corrupt downloads and wrong filenames never replace a verified copy or leave partial files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-update-'));
    try {
        const good = fixture([release('0.2.0')]).updater(directory);
        await good.check(true);
        const file = await good.download();
        for (const options of [
            { data: Buffer.from('MZcorrupted-portable-test-data') },
            { checksum: `${'0'.repeat(64)}  Diagnostic-Hub.exe` },
            { checksum: `${sha}  Other.exe` },
        ]) {
            const updater = fixture([release('0.2.0')], options).updater(directory);
            await updater.check(true);
            await assert.rejects(() => updater.download(), /checksum|size/);
            assert.deepEqual(await readFile(file), binary);
            assert.deepEqual(await readdir(path.dirname(file)), ['Diagnostic-Hub.exe']);
            await assert.rejects(() => updater.executable(), /Download and verify/);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('Linux downloads select AppImage and development builds cannot install', async () => {
    const data = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0x41, 0x49, 0x02, 0]);
    const hash = createHash('sha256').update(data).digest('hex');
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-update-'));
    try {
        const updater = fixture(
            [release('0.2.0', false, 'Diagnostic-Hub-linux-x64.AppImage', data)],
            { platform: 'linux', data, checksum: `${hash}  Diagnostic-Hub-linux-x64.AppImage` },
        ).updater(directory);
        await updater.check(true);
        assert.ok((await updater.download()).endsWith('.AppImage'));
        const development = fixture([release('0.2.0')], { packaged: false }).updater(directory);
        assert.equal((await development.check(true)).installable, false);
        await assert.rejects(() => development.download(), /packaged application/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('offline checks report a recoverable error and overlapping update operations are rejected', async () => {
    let resolve!: (value: Response) => void;
    const request: typeof fetch = () =>
        new Promise<Response>((done) => {
            resolve = done;
        });
    const updater = new ReleaseUpdater('0.1.0', '/unused', 'win32', 'x64', true, request);
    const pending = updater.check(true);
    await assert.rejects(() => updater.check(true), /already running/);
    await assert.rejects(() => updater.download(), /already running/);
    resolve(new Response('', { status: 503 }));
    await assert.rejects(() => pending, /503/);
    const offline = new ReleaseUpdater('0.1.0', '/unused', 'win32', 'x64', true, async () => {
        throw Error('Offline');
    });
    await assert.rejects(() => offline.check(true), /Offline/);
});

test('oversized response bodies are stopped before parsing metadata or checksums', async () => {
    const oversized = new ReleaseUpdater(
        '0.1.0',
        '/unused',
        'win32',
        'x64',
        true,
        async () => new Response('x'.repeat(5 * 1024 * 1024 + 1)),
    );
    await assert.rejects(() => oversized.check(true), /exceeds the expected size/);
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-update-'));
    try {
        const updater = fixture([release('0.2.0')], { checksum: 'x'.repeat(4097) }).updater(
            directory,
        );
        await updater.check(true);
        await assert.rejects(() => updater.download(), /exceeds the expected size/);
        assert.deepEqual(await readdir(directory), []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

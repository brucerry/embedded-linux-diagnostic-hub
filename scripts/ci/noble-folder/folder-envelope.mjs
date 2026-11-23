// Prepare the original tar's permanent envelope with the existing source-owned planner and disk adapter.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const archiveName = 'Diagnostic-Hub-linux-x64.tar.gz';
const sha = (body) => createHash('sha256').update(body).digest('hex');
const identity = (row) => [row.dev, row.ino, row.mode, row.uid, row.nlink, row.size, row.mtimeNs, row.ctimeNs];

async function prepare(args) {
    const [operation, project, home, rawSize, digest, commit] = args;
    const uid = process.getuid();
    assert.ok(args.length === 6 && ['plan', 'prepare'].includes(operation) &&
        isAbsolute(project) && isAbsolute(home) && home === process.env.HOME &&
        uid === process.geteuid() && uid > 0 && /^[1-9][0-9]{0,8}$/.test(rawSize) &&
        /^[0-9a-f]{64}$/.test(digest) && /^[0-9a-f]{40}$/.test(commit));
    const lib = (name) => pathToFileURL(join(project, 'scripts/lib', name)).href;
    const { observeLinuxGzipTar, linuxObservationWindow } = await import(lib('linux-archive-members.mjs'));
    const { normalizeLinuxPackagerCensus } = await import(lib('linux-release-observation.mts'));
    const { planLinuxPermanentEnvelope, prepareLinuxPermanentEnvelope } = await import(lib('linux-setup-envelope.ts'));
    const archivePath = join(home, archiveName);
    const expected = { bytes: Number(rawSize), sha256: digest };
    const startedMs = performance.now();
    const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let census;
    try {
        const before = await handle.stat({ bigint: true });
        assert.ok(before.isFile() && before.uid === BigInt(uid) && before.nlink === 1n &&
            (before.mode & 0o7777n) === 0o400n && before.size === BigInt(expected.bytes));
        assert.deepEqual(identity(await lstat(archivePath, { bigint: true })), identity(before));
        async function* chunks() {
            const buffer = Buffer.alloc(65536);
            for (let at = 0; ;) {
                const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.bytes - at + 1), at);
                if (!bytesRead) break;
                at += bytesRead;
                assert.ok(at <= expected.bytes);
                yield Buffer.from(buffer.subarray(0, bytesRead));
            }
        }
        census = await observeLinuxGzipTar(chunks(), expected, linuxObservationWindow({
            requestId: randomBytes(16).toString('hex'), startedMs, deadlineMs: startedMs + 60000,
            now: () => performance.now(),
        }));
        assert.deepEqual(identity(await handle.stat({ bigint: true })), identity(before));
        assert.deepEqual(identity(await lstat(archivePath, { bigint: true })), identity(before));
    } finally {
        await handle.close();
    }
    const mapped = normalizeLinuxPackagerCensus(census, archiveName);
    const files = mapped.payloadEntries.filter((row) => row.kind === 'file')
        .map(({ path, bytes, sha256, mode }) => ({ path, bytes, sha256, mode }));
    const input = {
        platform: 'linux', arch: 'x64', uid, euid: uid, home,
        sourceRoot: join(home, mapped.rootName), outputRoot: join(home, 'envelope'), archivePath,
        archive: { asset: archiveName, ...expected }, layout: 'flat-linux-portable', version: '0.6.0',
        sourceCommit: commit, files, inventorySHA256: sha(JSON.stringify(files)),
    };
    const { descriptorSHA256, files: installed } = planLinuxPermanentEnvelope(input);
    let status = 'planned';
    if (operation === 'prepare') {
        const value = await prepareLinuxPermanentEnvelope(input);
        assert.equal(value.status, 'prepared-install-envelope');
        assert.equal(value.descriptorSHA256, descriptorSHA256);
        status = value.status;
    }
    const appRunSHA256 = installed.find(({ path }) => path === 'AppRun').sha256;
    process.stdout.write(JSON.stringify({ status, descriptorSHA256, appRunSHA256 }) + '\n');
}

try {
    await prepare(process.argv.slice(2));
} catch {
    process.exitCode = 1;
}

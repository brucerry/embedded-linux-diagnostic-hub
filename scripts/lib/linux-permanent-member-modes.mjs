import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import {
    LINUX_ARCHIVE_LIMITS,
    linuxObservationWindow,
    observeLinuxGzipTar,
} from './linux-archive-members.mjs';
import { normalizeLinuxPackagerCensus } from './linux-release-observation.mts';

// The installer planner checks these same original-member modes before making an envelope.
const required = new Map([
    ['resources/linux-installed-AppRun', 0o755],
    ['resources/linux-setup-bootstrap.cjs', 0o644],
    ['resources/linux-setup-install.cjs', 0o644],
    ['resources/diagnostic_hub_rename_noreplace.node', 0o644],
]);
const octal = (mode) => (Number.isInteger(mode) ? '0' + mode.toString(8) : 'missing mode');

export function assertLinuxPermanentMemberModes(entries) {
    const failures = [];
    for (const [name, mode] of required) {
        const matches = entries.filter((entry) => entry.path === name);
        if (matches.length !== 1 || matches[0].kind !== 'file')
            failures.push(name + ' must appear exactly once as a regular file');
        else if (matches[0].mode !== mode)
            failures.push(name + ' has ' + octal(matches[0].mode) + ', expected ' + octal(mode));
    }
    assert.equal(failures.length, 0, 'LINUX_PERMANENT_MEMBER_MODE: ' + failures.join('; '));
}

export async function verifyLinuxPermanentDirectoryModes(directory) {
    assert.ok((await lstat(directory)).isDirectory(), 'Linux package root must be a directory.');
    assert.ok(
        (await lstat(path.join(directory, 'resources'))).isDirectory(),
        'Linux package resources must be a directory.',
    );
    const members = [];
    for (const name of required.keys()) {
        try {
            const member = await lstat(path.join(directory, name));
            members.push({
                path: name,
                kind: member.isFile() ? 'file' : 'other',
                mode: member.mode & 0o7777,
            });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    assertLinuxPermanentMemberModes(members);
}

const statOptions = { bigint: true };
const identity = (stat) => [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
];

/**
 * Read the original archive headers, before any extraction can mask their mode.
 * A supplied expected identity is for callers with independent custody evidence.
 * During ordinary build verification, a first pass measures the same open file.
 * The optional consumer receives that descriptor, still at offset zero.
 * @param {string} file
 * @param {{expected?: {bytes: number, sha256: string}, consume?: (fd: number, root: string) => void | Promise<void>}} [options]
 */
export async function readLinuxTarPermanentMembers(file, { expected, consume } = {}) {
    const before = await lstat(file, statOptions);
    assert.ok(
        before.isFile() &&
            before.nlink === 1n &&
            before.size > 0n &&
            before.size <= BigInt(LINUX_ARCHIVE_LIMITS.compressed),
        'Invalid Linux archive file.',
    );
    const bytes = Number(before.size);
    const snapshot = identity(before);
    const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        assert.deepEqual(
            identity(await handle.stat(statOptions)),
            snapshot,
            'Linux archive changed.',
        );
        const startedMs = performance.now();
        const window = linuxObservationWindow({
            requestId: randomBytes(16).toString('hex'),
            startedMs,
            deadlineMs: startedMs + 120000,
            now: () => performance.now(),
        });
        async function* chunks() {
            const buffer = Buffer.alloc(LINUX_ARCHIVE_LIMITS.chunk);
            let at = 0;
            while (at < bytes) {
                window.check();
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    Math.min(buffer.length, bytes - at),
                    at,
                );
                window.check();
                assert.ok(bytesRead > 0, 'Truncated Linux archive.');
                at += bytesRead;
                yield buffer.subarray(0, bytesRead);
            }
        }
        if (!expected) {
            const hash = createHash('sha256');
            for await (const chunk of chunks()) hash.update(chunk);
            expected = { bytes, sha256: hash.digest('hex') };
        }
        assert.equal(bytes, expected.bytes, 'Linux archive size changed.');
        const census = await observeLinuxGzipTar(chunks(), expected, window);
        const mapped = normalizeLinuxPackagerCensus(census, path.basename(file));
        const entries = mapped.payloadEntries.filter((entry) => required.has(entry.path));
        assert.deepEqual(
            identity(await handle.stat(statOptions)),
            snapshot,
            'Linux archive changed.',
        );
        if (consume) {
            assertLinuxPermanentMemberModes(entries);
            await consume(handle.fd, mapped.rootName);
            assert.deepEqual(
                identity(await handle.stat(statOptions)),
                snapshot,
                'Linux archive changed.',
            );
        }
        assert.deepEqual(
            identity(await lstat(file, statOptions)),
            snapshot,
            'Linux archive path changed.',
        );
        return entries;
    } finally {
        await handle.close();
    }
}

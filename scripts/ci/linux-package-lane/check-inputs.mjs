import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lane = path.dirname(fileURLToPath(import.meta.url));
const maxArchiveBytes = 64 * 1024 * 1024;

export async function sha512RegularFile(filename, limit = maxArchiveBytes) {
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await fd.stat({ bigint: true });
        if (!before.isFile() || before.size === 0n || before.size > BigInt(limit))
            throw new Error('expected a bounded regular archive');
        const hash = createHash('sha512');
        const buf = Buffer.alloc(128 * 1024);
        let used = 0;
        while (used < Number(before.size)) {
            const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, Number(before.size) - used), used);
            if (!bytesRead) throw new Error('archive ended while reading');
            hash.update(buf.subarray(0, bytesRead));
            used += bytesRead;
        }
        const after = await fd.stat({ bigint: true });
        for (const field of ['dev','ino','mode','size','mtimeNs','ctimeNs']) {
            if (before[field] !== after[field]) throw new Error('archive changed while reading');
        }
        return 'sha512-' + hash.digest('base64');
    } finally {
        await fd.close();
    }
}

export async function checkVendorArchives(inputRoot) {
    const root = await realpath(inputRoot);
    const vendor = path.join(root, 'vendor');
    let vendorPresent = false;
    try {
        if (await realpath(vendor) !== vendor) throw new Error('expected a canonical vendor directory');
        vendorPresent = true;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const lock = JSON.parse(await readFile(path.join(lane, 'package-lock.json'), 'utf8'));
    const pins = Object.values(lock.packages).filter(entry => entry.resolved?.startsWith('file:vendor/'));
    const names = new Set();
    if (pins.length !== 8) throw new Error('expected eight pinned Linux vendor archives');
    const results = [];
    for (const { resolved, integrity } of pins) {
        const name = resolved.slice('file:vendor/'.length);
        if (!/^[a-z0-9._-]+\.tgz$/.test(name) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) || names.has(name))
            throw new Error('invalid Linux vendor pin');
        names.add(name);
        let status = 'missing';
        if (vendorPresent) {
            try {
                const digest = await sha512RegularFile(path.join(vendor, name));
                status = digest === integrity ? 'verified' : 'digest-mismatch';
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        results.push({ name, status });
    }
    return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.argv.length !== 3) {
        throw new Error('run as node check-inputs.mjs ABSOLUTE_INPUT_DIRECTORY on Linux x64');
    }
    if (!path.isAbsolute(process.argv[2])) throw new Error('use an absolute input directory');
    const entries = await checkVendorArchives(process.argv[2]);
    console.log(JSON.stringify({ kind: 'vendor-archive-preflight', qualification: false, entries }, null, 2));
    process.exitCode = entries.every(e => e.status === 'verified') ? 0 : 2;
}

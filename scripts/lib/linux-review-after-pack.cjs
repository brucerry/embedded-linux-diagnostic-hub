const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

// Concrete build-time writer; never called by module import or the pure tests' default path.
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
    .every(key => a[key] === b[key]);
const disk = {
    async readBundle(file, limit) {
        const before = await fs.lstat(file);
        if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit ||
            (before.mode & 0o7022)) throw Error('LINUX_REVIEW_BUILD_INPUT');
        const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            if (!same(before, await fd.stat())) throw Error('LINUX_REVIEW_BUILD_IDENTITY');
            const bytes = Buffer.alloc(before.size + 1);
            let count = 0;
            while (count < bytes.length) {
                const part = await fd.read(bytes, count, bytes.length - count, count);
                if (part.bytesRead === 0) break;
                count += part.bytesRead;
            }
            if (count !== before.size || !same(before, await fd.stat()) ||
                !same(before, await fs.lstat(file))) throw Error('LINUX_REVIEW_BUILD_CHANGED');
            return bytes.subarray(0, count);
        } finally { await fd.close(); }
    },
    async publish(file, bytes, mode) {
        const parent = path.dirname(file);
        if (await fs.realpath(parent) !== parent) throw Error('LINUX_REVIEW_OUTPUT_ALIAS');
        const directory = await fs.lstat(parent);
        if (!directory.isDirectory() || (directory.mode & 0o7022))
            throw Error('LINUX_REVIEW_OUTPUT_DIRECTORY');
        // Exclusive creation. On failure retain this new partial file; no overwrite/unlink fallback.
        const fd = await fs.open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
            constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
        try {
            await fd.writeFile(bytes);
            await fd.sync();
            const observed = Buffer.alloc(bytes.length + 1);
            let count = 0;
            while (count < observed.length) {
                const part = await fd.read(observed, count, observed.length - count, count);
                if (!part.bytesRead) break;
                count += part.bytesRead;
            }
            const held = await fd.stat(), named = await fs.lstat(file), parentAfter = await fs.lstat(parent);
            if (!held.isFile() || held.nlink !== 1 || held.size !== bytes.length ||
                !same(held, named) || !parentAfter.isDirectory() ||
                !['dev', 'ino', 'mode'].every(key => directory[key] === parentAfter[key]) ||
                await fs.realpath(parent) !== parent)
                throw Error('LINUX_REVIEW_OUTPUT_IDENTITY');
            if (count !== bytes.length || !observed.subarray(0, count).equals(bytes))
                throw Error('LINUX_REVIEW_OUTPUT_READBACK');
        } finally { await fd.close(); }
    },
};
function createReviewPackager(io = disk) {
    return async function packageReview({ electronPlatformName, arch, appOutDir, version, source }) {
        if (electronPlatformName !== 'linux') return { status: 'not-applicable' };
        if (arch !== 'x64' || !path.isAbsolute(appOutDir) || path.normalize(appOutDir) !== appOutDir)
            throw Error('LINUX_REVIEW_PACKAGE_PLATFORM');
        const { createLinuxReviewCapability, MAX_LINUX_REVIEW_BUNDLE } =
            await import('./linux-review-package.mjs');
        const observed = await io.readBundle(source, MAX_LINUX_REVIEW_BUNDLE);
        if (!Buffer.isBuffer(observed)) throw Error('LINUX_REVIEW_BUILD_INPUT');
        const bytes = Buffer.from(observed);
        const capability = createLinuxReviewCapability(version, bytes);
        await io.publish(path.join(appOutDir, 'resources', 'linux-setup-review.cjs'), Buffer.from(bytes), 0o644);
        const metadata = Buffer.from(JSON.stringify(capability) + '\n');
        if (metadata.length > 4096) throw Error('LINUX_REVIEW_METADATA_CAP');
        await io.publish(path.join(appOutDir, 'resources', 'linux-setup-review.json'), metadata, 0o600);
        return { status: 'read-only-entry-packaged', capability };
    };
}
// Explicit opt-in preparation API; ordinary afterPack does not invoke it or assemble an envelope.
async function prepareReviewEnvelope(input, io) {
    const { prepareLinuxReviewEnvelope } = await import('./linux-setup-envelope.ts');
    return prepareLinuxReviewEnvelope(input, io);
}
// Production entry has no qualified provenance admission: never accept payload-supplied trust.
async function reviewEnvelopeHandoff(input, observation) {
    const { inspectLinuxArchiveTreeBinding } = await import('./linux-envelope-binding.ts');
    return inspectLinuxArchiveTreeBinding(input, observation);
}
async function observeReviewEnvelope(input, records, window) {
    const { planLinuxReviewEnvelope } = await import('./linux-setup-envelope.ts');
    const { createLinuxEnvelopeDisk } = await import('./linux-setup-envelope-disk.mjs');
    const plan = planLinuxReviewEnvelope(input);
    return createLinuxEnvelopeDisk().observeBinding(plan, structuredClone(records), window);
}
module.exports = { createReviewPackager, prepareReviewEnvelope, reviewEnvelopeHandoff, observeReviewEnvelope };

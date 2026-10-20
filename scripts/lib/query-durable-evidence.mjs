import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

function identity(stat) {
    assert(
        stat.isFile() && !stat.isSymbolicLink() && String(stat.nlink) === '1',
        'Evidence file identity',
    );
    if (typeof process.getuid === 'function')
        assert.equal(String(stat.uid), String(process.getuid()), 'Evidence file owner');
    return Object.fromEntries(['dev', 'ino', 'uid', 'nlink'].map((k) => [k, String(stat[k])]));
}
export function acquiredEvidenceIdentity(fd, io = fs) {
    return Object.freeze(identity(io.fstatSync(fd, { bigint: true })));
}
const version = (s) =>
    Object.fromEntries(['size', 'mtimeNs', 'ctimeNs'].map((k) => [k, String(s[k])]));
export function requireEvidenceProof(proof, maximum, { sealed = true } = {}) {
    assert(proof && typeof proof === 'object');
    assert.deepEqual(
        Object.keys(proof).sort(),
        [
            'path',
            'bytes',
            'sha256',
            'identity',
            ...(sealed || proof.version ? ['version'] : []),
        ].sort(),
    );
    assert(typeof proof.path === 'string' && proof.path.length > 0);
    assert(Number.isSafeInteger(proof.bytes) && proof.bytes >= 0 && proof.bytes <= maximum);
    assert(/^[a-f0-9]{64}$/.test(proof.sha256));
    assert.deepEqual(Object.keys(proof.identity).sort(), ['dev', 'ino', 'uid', 'nlink'].sort());
    for (const v of Object.values(proof.identity)) assert(typeof v === 'string' && /^\d+$/.test(v));
    assert.equal(proof.identity.nlink, '1');
    if (proof.version) {
        assert.deepEqual(Object.keys(proof.version).sort(), ['size', 'mtimeNs', 'ctimeNs'].sort());
        for (const v of Object.values(proof.version))
            assert(typeof v === 'string' && /^-?\d+$/.test(v));
        assert.equal(proof.version.size, String(proof.bytes));
    }
    return proof;
}
/** A bounded read binds named file, read handle, and optionally still-open writer.
 * The read-only handle is registered immediately and closed exactly once on every path.
 * This is temporal path/object verification, not an atomic Windows handle capability. */
function readProof(proof, { maximum, io = fs, check = () => {}, writerFD } = {}) {
    requireEvidenceProof(proof, maximum, { sealed: false });
    check();
    const verify = (fd) => {
        check();
        const named = io.lstatSync(proof.path, { bigint: true }),
            opened = io.fstatSync(fd, { bigint: true });
        assert.deepEqual(identity(named), proof.identity, 'Evidence path identity rebound');
        assert.deepEqual(identity(opened), proof.identity, 'Evidence descriptor identity rebound');
        assert.equal(Number(named.size), proof.bytes, 'Evidence named byte count');
        assert.equal(Number(opened.size), proof.bytes, 'Evidence descriptor byte count');
        assert.deepEqual(
            version(named),
            version(opened),
            'Evidence named/descriptor version differs',
        );
        if (proof.version)
            assert.deepEqual(
                version(named),
                proof.version,
                'Evidence file changed after durable closure',
            );
        if (writerFD !== undefined) {
            const writer = io.fstatSync(writerFD, { bigint: true });
            assert.deepEqual(identity(writer), proof.identity, 'Evidence writer identity rebound');
            assert.equal(Number(writer.size), proof.bytes, 'Evidence writer byte count');
        }
        return version(named);
    };
    let fd, bytes, error, closeError, observedVersion;
    try {
        assert.deepEqual(
            identity(io.lstatSync(proof.path, { bigint: true })),
            proof.identity,
            'Evidence path identity rebound',
        );
        fd = io.openSync(proof.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const beforeVersion = verify(fd);
        bytes = Buffer.alloc(proof.bytes);
        let offset = 0;
        while (offset < bytes.length) {
            check();
            const n = io.readSync(
                fd,
                bytes,
                offset,
                Math.min(65536, bytes.length - offset),
                offset,
            );
            assert(Number.isSafeInteger(n) && n > 0, 'Evidence short read');
            offset += n;
        }
        const extra = Buffer.alloc(1);
        assert.equal(io.readSync(fd, extra, 0, 1, offset), 0, 'Evidence grew during proof');
        assert.equal(
            createHash('sha256').update(bytes).digest('hex'),
            proof.sha256,
            'Evidence content digest changed',
        );
        assert.deepEqual(verify(fd), beforeVersion, 'Evidence changed during bounded read');
        observedVersion = beforeVersion;
    } catch (e) {
        error = e;
    } finally {
        if (fd !== undefined)
            try {
                io.closeSync(fd);
            } catch (e) {
                closeError = e;
            }
    }
    if (error || closeError)
        throw new AggregateError(
            [error, closeError].filter(Boolean),
            'Evidence identity/content/durability proof failed',
        );
    check();
    const after = io.lstatSync(proof.path, { bigint: true });
    assert.deepEqual(
        identity(after),
        proof.identity,
        'Evidence path identity rebound after read close',
    );
    assert.deepEqual(version(after), observedVersion, 'Evidence changed during read close');
    return { bytes, version: observedVersion };
}

export function readEvidenceProof(proof, options) {
    return readProof(proof, options).bytes;
}
export function sealEvidenceProof(proof, options) {
    const observed = readProof(proof, options);
    return Object.freeze({ ...proof, version: Object.freeze(observed.version) });
}

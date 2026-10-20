import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    acquiredEvidenceIdentity,
    readEvidenceProof,
    sealEvidenceProof,
} from './query-durable-evidence.mjs';
// Core-only bootstrap capture: no runtime/provider imports before the entry clock.
// A copy is forwarded to GitHub's job log; the retained private copy has its own cap.
let installed;
export const currentOwnerStdio = () => installed;
export function ownerStdioCapture({ io = fs, maximum = 1048576 } = {}) {
    const slots = [0, 1].map(() => ({
        bytes: 0,
        attemptedBytes: 0,
        hash: createHash('sha256'),
        pending: [],
        entry: null,
    }));
    let failure = null,
        admit = () => {},
        hold = () => {},
        guardCheck = () => {},
        closed = false,
        closedProofs = null;
    const fail = (error) => {
        failure ??= error;
        hold({ phase: 'owner-stdio-unknown' });
    };
    function write(index, value, encoding) {
        try {
            const b = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, encoding);
            const s = slots[index];
            s.attemptedBytes += b.length;
            s.hash.update(b);
            assert(!closed, 'Owner capture already closed');
            assert(s.bytes + b.length <= maximum, '1MiB owner stream bound');
            guardCheck();
            admit(b.length);
            s.bytes += b.length;
            if (s.entry) {
                let offset = 0;
                while (offset < b.length) {
                    const n = io.writeSync(s.entry.fd, b, offset, b.length - offset);
                    assert(n > 0);
                    offset += n;
                }
            } else s.pending.push(b);
        } catch (error) {
            fail(error);
        }
    }
    return {
        write,
        attach(directory, { admit: admission, hold: retention, check }) {
            admit = admission;
            hold = retention;
            guardCheck = check;
            check();
            assert(!failure, 'Owner bootstrap stream capture incomplete');
            try {
                for (const [i, s] of slots.entries()) {
                    // Register each acquisition before the next open/write can fail.
                    s.entry = {
                        fd: io.openSync(
                            path.join(directory, i === 0 ? 'owner.stdout.log' : 'owner.stderr.log'),
                            'wx',
                            0o600,
                        ),
                        errors: [],
                        attempted: false,
                        synced: false,
                        closed: false,
                    };
                    const file = (s.file = path.join(
                        directory,
                        i === 0 ? 'owner.stdout.log' : 'owner.stderr.log',
                    ));
                    const opened = io.fstatSync(s.entry.fd);
                    s.identity = acquiredEvidenceIdentity(s.entry.fd, io);
                    const verify = () => {
                        guardCheck();
                        const now = io.lstatSync(file),
                            fd = io.fstatSync(s.entry.fd);
                        assert(now.isFile() && !now.isSymbolicLink() && now.nlink === 1);
                        for (const k of ['dev', 'ino', 'uid'])
                            assert(
                                now[k] === opened[k] && fd[k] === opened[k],
                                'Owner raw file rebound',
                            );
                        assert(now.size === s.bytes && fd.size === s.bytes, 'Owner raw byte count');
                        readEvidenceProof(
                            {
                                path: s.file,
                                identity: s.identity,
                                bytes: s.bytes,
                                sha256: s.hash.copy().digest('hex'),
                            },
                            { maximum, io, check: guardCheck, writerFD: s.entry.fd },
                        );
                    };
                    s.entry.beforeSync = () => {
                        verify();
                        s.syncedProof = sealEvidenceProof(
                            {
                                path: s.file,
                                identity: s.identity,
                                bytes: s.bytes,
                                sha256: s.hash.copy().digest('hex'),
                            },
                            { maximum, io, check: guardCheck, writerFD: s.entry.fd },
                        );
                    };
                    s.entry.afterSync = () => {
                        verify();
                        readEvidenceProof(s.syncedProof, {
                            maximum,
                            io,
                            check: guardCheck,
                            writerFD: s.entry.fd,
                        });
                    };
                    for (const b of s.pending) {
                        admit(b.length);
                        let offset = 0;
                        while (offset < b.length) {
                            const n = io.writeSync(s.entry.fd, b, offset, b.length - offset);
                            assert(n > 0);
                            offset += n;
                        }
                    }
                    s.pending = [];
                }
            } catch (error) {
                fail(error);
                throw error;
            }
        },
        entries: () => slots.map((s) => s.entry).filter(Boolean),
        names: () => ['owner.stdout.log', 'owner.stderr.log'],
        check() {
            guardCheck();
            assert(!failure, 'Owner raw capture incomplete');
        },
        snapshot: () => ({
            bytes: slots.map((s) => s.bytes),
            attemptedBytes: slots.map((s) => s.attemptedBytes),
            fullStreamSHA256: slots.map((s) => s.hash.copy().digest('hex')),
            closed,
            failed: Boolean(failure),
        }),
        // closeEntries is supplied by the runtime only after all core bootstrap imports settle.
        close(closeEntries) {
            const closure = closeEntries(this.entries(), io);
            closed = true;
            if (!closure.complete) fail(Error('Owner raw sync/close unknown'));
            assert(!failure, 'Owner raw capture incomplete');
            try {
                closedProofs = slots.map((s) =>
                    sealEvidenceProof(s.syncedProof, { maximum, io, check: guardCheck }),
                );
            } catch (error) {
                fail(error);
                throw error;
            }
            return closure;
        },
        proofs() {
            assert(closedProofs && !failure, 'Owner raw proofs incomplete');
            return [...closedProofs];
        },
        install() {
            assert(!installed);
            installed = this;
            const originals = [process.stdout.write, process.stderr.write];
            for (const [i, stream] of [process.stdout, process.stderr].entries())
                stream.write = function (chunk, encoding, callback) {
                    write(i, chunk, typeof encoding === 'string' ? encoding : undefined);
                    return originals[i].call(stream, chunk, encoding, callback);
                };
            this.restore = () => {
                assert(closed && !failure, 'Capture must close before restoration');
                process.stdout.write = originals[0];
                process.stderr.write = originals[1];
                installed = undefined;
            };
            return this;
        },
    };
}

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

export const LINUX_ARCHIVE_LIMITS = Object.freeze({ compressed: 2 * 1024 ** 3,
    payload: 2 * 1024 ** 3, files: 20000, directories: 20000, entries: 40000,
    chunk: 65536, control: 4 * 1024 ** 2, endPadding: 10240 });
const expandedLimit = LINUX_ARCHIVE_LIMITS.payload + LINUX_ARCHIVE_LIMITS.entries * 512 +
    LINUX_ARCHIVE_LIMITS.files * 511 + LINUX_ARCHIVE_LIMITS.endPadding;
const zero = bytes => bytes.every(byte => byte === 0);
const error = code => { throw Error(code); };
const codecOwners = new Set(); // Private retained flow/context on uncertainty; no destroy fallback.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function stringField(bytes) {
    const end = bytes.indexOf(0), text = end < 0 ? bytes : bytes.subarray(0, end);
    if (end >= 0 && !zero(bytes.subarray(end))) error('TAR_STRING');
    try { return decoder.decode(text); } catch { error('TAR_UTF8'); }
}
function octal(bytes, blank = false) {
    if (bytes.some(byte => byte > 127)) error('TAR_NUMBER');
    const text = bytes.toString('ascii');
    if (blank && /^[ \0]*$/.test(text)) return 0;
    if (!/^ *[0-7]+[ \0]*$/.test(text)) error('TAR_NUMBER');
    const value = Number.parseInt(text.trim().replace(/\0.*$/, ''), 8);
    if (!Number.isSafeInteger(value) || value < 0) error('TAR_NUMBER');
    return value;
}
/** Bounded POSIX ustar regular-file/directory census; namespace mapping is explicit and separate. */
// node-tar portable:true leaves UID/GID and directory mtime all-NUL. They are not ownership proof.
function portableOptionalOctal(bytes) { return zero(bytes) ? 0 : octal(bytes); }
export class LinuxTarCensus {
    constructor() {
        this.header = Buffer.alloc(512); this.headerUsed = 0; this.remaining = 0; this.padding = 0;
        this.active = null; this.entries = []; this.seen = new Map(); this.parents = new Set();
        this.files = 0; this.directories = 0; this.payloadBytes = 0; this.expandedBytes = 0;
        this.controlBytes = 2; this.zeroBlocks = 0; this.ended = false; this.endBytes = 0;
    }
    add(entry) {
        this.controlBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (this.controlBytes > LINUX_ARCHIVE_LIMITS.control) error('TAR_CONTROL_CAP');
        this.entries.push(entry);
    }
    finishFile() {
        if (!this.active) return;
        this.add({ kind: 'file', path: this.active.path, mode: this.active.mode,
            bytes: this.active.size, sha256: this.active.hash.digest('hex') });
        this.active = null;
    }
    parseHeader(block) {
        if (zero(block)) {
            this.zeroBlocks++; this.endBytes += 512;
            if (this.zeroBlocks === 2) this.ended = true;
            return;
        }
        if (this.zeroBlocks) error('TAR_END_MARKER');
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : block[i];
        if (octal(block.subarray(148, 156)) !== checksum) error('TAR_CHECKSUM');
        if (!block.subarray(257, 263).equals(Buffer.from('ustar\0')) ||
            block.subarray(263, 265).toString('ascii') !== '00' || !zero(block.subarray(500)))
            error('TAR_FORMAT_UNSUPPORTED');
        const type = block[156];
        if (![0, 48, 53].includes(type) || !zero(block.subarray(157, 257))) error('TAR_TYPE_UNSUPPORTED');
        const kind = type === 53 ? 'directory' : 'file';
        const prefix = stringField(block.subarray(345, 500)), name = stringField(block.subarray(0, 100));
        let filename = prefix ? prefix + '/' + name : name;
        if (kind === 'directory' && filename.endsWith('/')) filename = filename.slice(0, -1);
        if (!filename || filename.length > 1024 || filename.startsWith('/') || /^[a-z]:/i.test(filename) ||
            /[\\\x00-\x1f\x7f]/.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..'))
            error('TAR_PATH');
        const key = filename.normalize('NFC');
        if (this.seen.has(key) || kind === 'file' && this.parents.has(key)) error('TAR_ALIAS');
        const parts = filename.split('/'); parts.pop();
        while (parts.length) {
            const parent = parts.join('/').normalize('NFC');
            if (this.seen.get(parent) === 'file') error('TAR_ALIAS');
            this.parents.add(parent);
            if (this.parents.size > LINUX_ARCHIVE_LIMITS.directories) error('TAR_COUNT');
            parts.pop();
        }
        const mode = octal(block.subarray(100, 108)), size = octal(block.subarray(124, 136));
        portableOptionalOctal(block.subarray(108, 116)); portableOptionalOctal(block.subarray(116, 124));
        if (kind === 'directory') portableOptionalOctal(block.subarray(136, 148));
        else octal(block.subarray(136, 148));
        if (octal(block.subarray(329, 337), true) || octal(block.subarray(337, 345), true)) error('TAR_DEVICE');
        stringField(block.subarray(265, 297)); stringField(block.subarray(297, 329));
        if (mode > 0o777 || (mode & 0o022) || !(mode & 0o400) ||
            kind === 'directory' && ((mode & 0o100) === 0 || size !== 0)) error('TAR_MODE_SIZE');
        if (this.entries.length >= LINUX_ARCHIVE_LIMITS.entries) error('TAR_COUNT');
        this.seen.set(key, kind);
        if (kind === 'directory') {
            if (++this.directories > LINUX_ARCHIVE_LIMITS.directories) error('TAR_COUNT');
            this.add({ kind, path: filename, mode }); return;
        }
        if (++this.files > LINUX_ARCHIVE_LIMITS.files) error('TAR_COUNT');
        if (size > LINUX_ARCHIVE_LIMITS.payload ||
            this.payloadBytes + size > LINUX_ARCHIVE_LIMITS.payload) error('TAR_PAYLOAD_CAP');
        this.payloadBytes += size; this.remaining = size; this.padding = (512 - size % 512) % 512;
        this.active = { path: filename, mode, size, hash: createHash('sha256') };
        if (!size) this.finishFile();
    }
    push(input) {
        if (!Buffer.isBuffer(input) || input.length > LINUX_ARCHIVE_LIMITS.chunk) error('TAR_CHUNK');
        this.expandedBytes += input.length;
        if (this.expandedBytes > expandedLimit) error('TAR_EXPANSION_CAP');
        let at = 0;
        while (at < input.length) {
            if (this.ended) {
                const rest = input.subarray(at); this.endBytes += rest.length;
                if (!zero(rest) || this.endBytes > LINUX_ARCHIVE_LIMITS.endPadding) error('TAR_TRAILING');
                return;
            }
            if (this.remaining) {
                const length = Math.min(this.remaining, input.length - at);
                this.active.hash.update(input.subarray(at, at + length));
                this.remaining -= length; at += length;
                if (!this.remaining) this.finishFile();
            } else if (this.padding) {
                const length = Math.min(this.padding, input.length - at);
                if (!zero(input.subarray(at, at + length))) error('TAR_PADDING');
                this.padding -= length; at += length;
            } else {
                const length = Math.min(512 - this.headerUsed, input.length - at);
                input.copy(this.header, this.headerUsed, at, at + length); this.headerUsed += length; at += length;
                if (this.headerUsed === 512) { this.headerUsed = 0; this.parseHeader(this.header); }
            }
        }
    }
    finish() {
        if (!this.ended || this.headerUsed || this.remaining || this.padding ||
            this.expandedBytes % 512 || !this.files) error('TAR_TRUNCATED');
        for (const parent of this.parents) if (this.seen.get(parent) !== 'directory') error('TAR_DIRECTORY_MISSING');
        const entries = this.entries.map(entry => ({ ...entry })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        return { format: 'ustar', entries, files: this.files, directories: this.directories,
            payloadBytes: this.payloadBytes, expandedBytes: this.expandedBytes };
    }
}
export function linuxObservationWindow(window) {
    const { requestId, startedMs, deadlineMs, now } = { ...window };
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId) || typeof now !== 'function' ||
        !Number.isFinite(startedMs) || !Number.isFinite(deadlineMs) || deadlineMs <= startedMs ||
        deadlineMs - startedMs > 120000) error('OBSERVATION_WINDOW');
    let previous = startedMs, stopped = false;
    return { requestId, startedMs, deadlineMs,
        stop() { stopped = true; },
        check() {
            if (stopped) error('OBSERVATION_STOPPED');
            const current = now();
            if (!Number.isFinite(current) || current < previous || current < startedMs || current >= deadlineMs) {
                stopped = true; error('OBSERVATION_DEADLINE');
            }
            previous = current; return current;
        } };
}
/**
 * @typedef {Object} LinuxArchiveObservation
 * @property {string} format
 * @property {Array<{kind: string, path: string, mode: number, bytes?: number, sha256?: string}>} entries
 * @property {number} files
 * @property {number} directories
 * @property {number} payloadBytes
 * @property {number} expandedBytes
 * @property {number} compressedBytes
 * @property {string} compressedSHA256
 */
/** Actual gzip decoding is data-only; input is a bounded iterator, never a path or extraction API.
 * @returns {Promise<LinuxArchiveObservation>}
 */
export function observeLinuxGzipTar(chunks, expected, window) {
    expected = { bytes: expected?.bytes, sha256: expected?.sha256 };
    if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 ||
        expected.bytes > LINUX_ARCHIVE_LIMITS.compressed || typeof expected.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expected.sha256))
        return Promise.reject(Error('ARCHIVE_EXPECTED'));
    window.check();
    const owner = { stopped: false, rawDone: false, compressedBytes: 0, source: null, codec: null, timer: null, iterator: null, lastRawReturn: null };
    codecOwners.add(owner);
    return new Promise((resolve, reject) => {
        const parser = new LinuxTarCensus(), checksum = createHash('sha256');
        const stop = code => {
            if (owner.stopped) return;
            owner.stopped = true; codecOwners.add(owner); window.stop(); clearTimeout(owner.timer);
            owner.source?.pause(); owner.codec?.pause(); reject(Error(code));
        };
        async function* bounded() {
            try {
                const iterator = chunks[Symbol.asyncIterator](); owner.iterator = iterator;
                for (;;) {
                    if (owner.stopped) return; window.check();
                    const item = await iterator.next(); owner.lastRawReturn = item;
                    if (owner.stopped) return; window.check();
                    if (item.done) { owner.rawDone = true; return; }
                    if (!Buffer.isBuffer(item.value) || item.value.length < 1 || item.value.length > LINUX_ARCHIVE_LIMITS.chunk)
                        error('ARCHIVE_CHUNK');
                    const bytes = Buffer.from(item.value); owner.compressedBytes += bytes.length;
                    if (owner.compressedBytes > expected.bytes || owner.compressedBytes > LINUX_ARCHIVE_LIMITS.compressed)
                        error('ARCHIVE_COMPRESSED_CAP');
                    checksum.update(bytes); yield bytes;
                }
            } catch { stop('ARCHIVE_INPUT_FAILED'); }
        }
        try {
            owner.source = Readable.from(bounded(), { objectMode: false, highWaterMark: LINUX_ARCHIVE_LIMITS.chunk });
            owner.codec = createGunzip({ chunkSize: LINUX_ARCHIVE_LIMITS.chunk, rejectGarbageAfterEnd: true,
                highWaterMark: LINUX_ARCHIVE_LIMITS.chunk, autoDestroy: false });
            // Containment handlers precede pipe/data activation; late errors cannot escape.
            owner.source.on('error', () => stop('ARCHIVE_INPUT_FAILED'));
            owner.codec.on('error', () => stop('GZIP_INVALID'));
            owner.codec.on('data', bytes => {
                if (owner.stopped) return;
                try { window.check(); parser.push(bytes); }
                catch { stop('ARCHIVE_LAYOUT_INVALID'); }
            });
            owner.codec.on('end', () => {
                if (owner.stopped) return;
                try {
                    window.check();
                    if (!owner.rawDone || owner.compressedBytes !== expected.bytes ||
                        owner.codec.bytesWritten !== owner.compressedBytes || checksum.digest('hex') !== expected.sha256)
                        error('ARCHIVE_STREAM_IDENTITY');
                    const census = parser.finish(); window.check(); clearTimeout(owner.timer); codecOwners.delete(owner);
                    resolve({ ...census, compressedBytes: owner.compressedBytes, compressedSHA256: expected.sha256 });
                } catch { stop('ARCHIVE_FINAL_INVALID'); }
            });
            owner.timer = setTimeout(() => stop('OBSERVATION_DEADLINE'), Math.max(1, window.deadlineMs - window.check()));
            owner.timer.unref(); owner.source.pipe(owner.codec);
        } catch { stop('ARCHIVE_SETUP_FAILED'); }
    });
}

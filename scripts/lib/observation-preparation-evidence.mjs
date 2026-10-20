import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { boundedRead, closeEntries, writeAll, digest } from './product-collector-evidence.mjs';

export const preparationEvidenceLimits = Object.freeze({
    bytes: 1048576,
    rows: 2048,
    rowBytes: 65536,
    terminalBytes: 327680,
    holdBytes: 32768,
    queryBytes: 245760,
    queryRows: 8,
    terminalRows: 32,
    dictionaryBytes: 262144,
    dictionaryRows: 256,
});
function recordIdentity(stat) {
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid, size: stat.size };
}
const refusals = new WeakMap();
export const provedPreparationRefusal = (error) => refusals.get(error) ?? null;
const reusable = new Set(['security-input', 'security-output', 'security-command-closed']);
const terminal = new Set([
    ...reusable,
    'preparation-error',
    'preparation-refused',
    'ownership-held.json',
]);
const boundedText = (value, maximum) => {
    let text = '',
        bytes = 0;
    for (const point of String(value)) {
        const size = Buffer.byteLength(point);
        if (bytes + size > maximum) break;
        text += point;
        bytes += size;
    }
    return text;
};
const errorValue = (error, stage, charges) => ({
    charges,
    stage: boundedText(stage, 128),
    error: boundedText(error, 2048),
    stack: typeof error?.stack === 'string' ? boundedText(error.stack, 4096) : null,
    code: typeof error?.code === 'string' ? error.code.slice(0, 64) : null,
});

/** Durable physical records; repeated payloads reference an earlier durable full record.
 * The byte/row reserve belongs to failure reporting and guarded cleanup, never new work. */
export class PreparationEvidence {
    constructor(directory, { check, admit, hold, io = fs, limits = {} }) {
        this.directory = directory;
        this.check = check;
        this.admit = admit;
        this.hold = hold;
        this.io = io;
        this.limits = { ...preparationEvidenceLimits, ...limits };
        for (const key of Object.keys(preparationEvidenceLimits))
            assert(
                Number.isSafeInteger(this.limits[key]) &&
                    this.limits[key] >= 0 &&
                    this.limits[key] <= preparationEvidenceLimits[key],
            );
        assert(this.limits.terminalBytes < this.limits.bytes);
        assert(this.limits.terminalRows < this.limits.rows);
        assert([check, admit, hold].every((fn) => typeof fn === 'function'));
        this.bytes = this.rows = this.dictionaryBytes = 0;
        this.dictionary = new Map();
        this.committed = [];
        this.uncertain = this.refused = this.failureMode = false;
        this.firstError = null;
        this.activeQuery = null;
        this.failureRecorded = false;
        this.reportingErrors = [];
    }
    snapshot() {
        return {
            bytes: this.bytes,
            rows: this.rows,
            complete: !this.uncertain,
            refused: this.refused,
            failureMode: this.failureMode,
            dictionaryBytes: this.dictionaryBytes,
            dictionaryRows: this.dictionary.size,
            activeQuery: this.activeQuery ? { ...this.activeQuery } : null,
            firstError: this.firstError,
            reportingErrors: [...this.reportingErrors],
        };
    }
    verifyPrefix() {
        assert(!this.uncertain, 'Preparation prefix already uncertain');
        this.check();
        assert.deepEqual(
            this.io.readdirSync(this.directory).sort(),
            this.committed.map((r) => path.basename(r.file)),
        );
        for (const entry of this.committed) {
            this.check();
            assert.deepEqual(recordIdentity(this.io.lstatSync(entry.file)), entry.identity);
            assert.equal(
                digest(boundedRead(entry.file, this.limits.rowBytes, this.io)),
                entry.sha256,
                'Preparation committed prefix changed',
            );
        }
    }
    complete() {
        if (this.uncertain) return false;
        try {
            this.verifyPrefix();
            return true;
        } catch (error) {
            this.unknown(error, 'preparation-prefix-verification');
            return false;
        }
    }
    /** Routine successful-wait envelope derived from the original remaining absolute
     * clock, actual PTY file count and unchanged max3 adapter. Novel data is guarded. */
    admitApprovalWait({ ptyFiles = 0, ptyPasses = 1, remainingMs = 1200000 } = {}) {
        assert(
            !this.failureMode && !this.uncertain && !this.refused,
            'Preparation work admission closed',
        );
        this.check();
        assert(Number.isSafeInteger(ptyFiles) && ptyFiles >= 0 && ptyFiles <= 8192);
        assert(Number.isSafeInteger(remainingMs) && remainingMs > 0 && remainingMs <= 1200000);
        // preserveObservationPty checks root, groups of16 (each split into max3),
        // then the two temp paths. Eight approval/API checks plus24 setup/final checks.
        const ptyQueries = 2 + Math.floor(ptyFiles / 16) * 6 + Math.ceil((ptyFiles % 16) / 3);
        const polls = Math.min(120, Math.ceil(remainingMs / 10000));
        assert([1, 2].includes(ptyPasses));
        const queries = polls * 3 + ptyQueries * ptyPasses + 32,
            rows = queries * 3;
        // First-visit PTY queries have a declared8192-byte encoded routine envelope;
        // subsequent records are exact references. All actual novel data is still guarded.
        const bytes = rows * 256 + (ptyPasses === 2 ? ptyQueries * (8192 - 768) : 0);
        this.admit(bytes + this.limits.terminalBytes);
        const byteLimit = this.limits.bytes - this.limits.terminalBytes,
            rowLimit = this.limits.rows - this.limits.terminalRows;
        if (this.bytes + bytes > byteLimit || this.rows + rows > rowLimit) {
            const error = Error('Preparation approval-wait evidence envelope refused before work');
            this.verifyPrefix();
            refusals.set(
                error,
                Object.freeze({
                    kind: 'pre-open-preparation-budget-refusal',
                    descriptorAcquired: false,
                    sequence: this.rows,
                    bytes,
                    usedBytes: this.bytes,
                    byteLimit,
                    rowLimit,
                }),
            );
            this.refused = true;
            throw error;
        }
        return {
            polls,
            ptyQueries,
            queries,
            rows,
            bytes,
            terminalBytes: this.limits.terminalBytes,
        };
    }
    unknown(error, stage) {
        this.uncertain = true;
        this.failureMode = true;
        this.firstError ??= errorValue(error, stage, this.charges());
        try {
            this.hold({
                phase: 'preparation-evidence-unknown',
                firstError: this.firstError,
                error: boundedText(error, 2048),
            });
        } catch (failure) {
            if (this.reportingErrors.length < 4)
                this.reportingErrors.push(boundedText(failure, 512));
        }
    }
    /** Called before descendant joining/cleanup can replace the original error. */
    beginFailure(error, stage = 'preparation') {
        this.firstError ??= errorValue(error, stage, this.charges());
        this.failureMode = true;
        if (this.failureRecorded) return;
        this.failureRecorded = true;
        try {
            this.record('preparation-error', this.firstError);
        } catch (failure) {
            this.unknown(failure, 'preparation-error-persistence');
            if (this.reportingErrors.length < 4)
                this.reportingErrors.push(boundedText(failure, 512));
        }
    }
    charges() {
        return {
            bytes: this.bytes,
            rows: this.rows,
            query: this.activeQuery ? { ...this.activeQuery } : null,
        };
    }
    /** Full raw-query allowance is checked before the input record/provider spawn.
     * Only this live wrapper can distinguish an unstarted input refusal from a
     * missing output/closed receipt after actual process effects. */
    securityQuery(query) {
        return (source, powershell, raw, options = {}) => {
            assert(!this.activeQuery, 'Nested preparation security query');
            assert(!this.uncertain, 'Uncertain query admission');
            this.check();
            const byteLimit =
                this.limits.bytes -
                (this.failureMode ? this.limits.holdBytes : this.limits.terminalBytes);
            const rowLimit = this.limits.rows - (this.failureMode ? 1 : this.limits.terminalRows);
            if (
                this.bytes + this.limits.queryBytes > byteLimit ||
                this.rows + this.limits.queryRows > rowLimit
            ) {
                const error = Error('Preparation query envelope refused before provider admission');
                try {
                    this.verifyPrefix();
                } catch (failure) {
                    this.unknown(failure, 'preparation-prefix-verification');
                    throw failure;
                }
                refusals.set(
                    error,
                    Object.freeze({
                        kind: 'pre-open-preparation-budget-refusal',
                        descriptorAcquired: false,
                        providerAttempted: false,
                        sequence: this.rows,
                        bytes: this.limits.queryBytes,
                        usedBytes: this.bytes,
                        byteLimit,
                        rowLimit,
                    }),
                );
                this.refused = true;
                throw error;
            }
            this.admit(
                this.limits.queryBytes +
                    (this.failureMode ? this.limits.holdBytes : this.limits.terminalBytes),
            );
            const state = {
                sequence: this.rows,
                bytes: this.bytes,
                attempted: false,
                processClosed: false,
                inputClosed: false,
                resultClosed: false,
            };
            this.activeQuery = state;
            try {
                const result = query(source, powershell, raw, {
                    ...options,
                    onProcessState: (value) => {
                        state.attempted = value.attempted === true;
                        state.processClosed = value.closed === true;
                        options.onProcessState?.(value);
                    },
                });
                assert(
                    state.attempted && state.processClosed && state.resultClosed,
                    'Security query closure/evidence unproved',
                );
                return result;
            } catch (error) {
                if (state.attempted && (!state.processClosed || !state.resultClosed))
                    this.unknown(error, 'security-query-incomplete');
                throw error;
            } finally {
                this.activeQuery = null;
            }
        };
    }
    record(stage, value) {
        let budgetRefusal;
        try {
            this.check();
            assert(typeof stage === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(stage));
            assert(!this.failureMode || terminal.has(stage), 'Failure mode cannot admit new work');
            assert(
                !this.uncertain || ['preparation-error', 'ownership-held.json'].includes(stage),
                'Uncertain evidence only admits held/error reporting',
            );
            if (this.refused && !this.failureMode)
                throw Error('Preparation evidence admission closed');
            const text = JSON.stringify(value),
                data = JSON.parse(text),
                payloadBytes = Buffer.byteLength(text),
                key = stage + ':' + digest(Buffer.from(text)),
                previous = reusable.has(stage) ? this.dictionary.get(key) : null;
            let row;
            if (previous) {
                row = {
                    schema: 1,
                    sequence: this.rows,
                    stage,
                    reference: {
                        sequence: previous.sequence,
                        bytes: payloadBytes,
                        dataSHA256: digest(Buffer.from(text)),
                    },
                };
            } else {
                const encoded =
                    payloadBytes <= this.limits.rowBytes ? deflateRawSync(Buffer.from(text)) : null;
                const compressed = encoded && {
                    encoding: 'deflate-raw-base64',
                    bytes: payloadBytes,
                    dataSHA256: digest(Buffer.from(text)),
                    base64: encoded.toString('base64'),
                };
                row =
                    compressed && Buffer.byteLength(JSON.stringify(compressed)) < payloadBytes
                        ? { schema: 1, sequence: this.rows, stage, encoded: compressed }
                        : { schema: 1, sequence: this.rows, stage, data };
            }
            const bytes = Buffer.from(JSON.stringify(row) + '\n');
            const byteLimit =
                    this.limits.bytes -
                    (stage === 'ownership-held.json'
                        ? 0
                        : this.failureMode
                          ? this.limits.holdBytes
                          : this.limits.terminalBytes),
                rowLimit =
                    this.limits.rows -
                    (stage === 'ownership-held.json'
                        ? 0
                        : this.failureMode
                          ? 1
                          : this.limits.terminalRows);
            if (
                bytes.length > this.limits.rowBytes ||
                this.rows >= rowLimit ||
                this.bytes + bytes.length > byteLimit
            ) {
                budgetRefusal = Error('Preparation evidence refused before descriptor acquisition');
                this.verifyPrefix();
                refusals.set(
                    budgetRefusal,
                    Object.freeze({
                        kind: 'pre-open-preparation-budget-refusal',
                        descriptorAcquired: false,
                        bytes: bytes.length,
                        sequence: this.rows,
                        usedBytes: this.bytes,
                        byteLimit,
                        rowLimit,
                    }),
                );
                this.refused = true;
                throw budgetRefusal;
            }
            if (previous) {
                assert(bytes.length <= 256, 'Approval-wait reference envelope');
                // No descriptor is acquired before the budget decision. Once admitted,
                // origin trust and actual read closure precede reference acknowledgment.
                assert.deepEqual(
                    recordIdentity(this.io.lstatSync(previous.file)),
                    previous.identity,
                    'Preparation reference origin rebound',
                );
                const raw = boundedRead(previous.file, this.limits.rowBytes, this.io);
                assert.equal(
                    digest(raw),
                    previous.recordSHA256,
                    'Preparation reference origin changed',
                );
            }
            this.admit(
                bytes.length +
                    (stage === 'ownership-held.json'
                        ? 0
                        : this.failureMode
                          ? this.limits.holdBytes
                          : this.limits.terminalBytes),
            );
            // Reserve failed ordinals and bytes, including failed open, so reporting cannot
            // recursively retry a damaged pathname or claim the missing record succeeded.
            const sequence = this.rows++,
                file = path.join(this.directory, String(sequence).padStart(6, '0') + '.json');
            this.bytes += bytes.length;
            const entry = { fd: this.io.openSync(file, 'wx', 0o600), errors: [], attempted: false };
            let primary, identity;
            const verify = () => {
                const opened = recordIdentity(this.io.fstatSync(entry.fd));
                assert.equal(opened.size, bytes.length);
                assert.deepEqual(
                    recordIdentity(this.io.lstatSync(file)),
                    opened,
                    'Preparation record rebound',
                );
                identity = opened;
            };
            entry.beforeSync = entry.afterSync = verify;
            try {
                writeAll(entry.fd, bytes, this.io);
            } catch (error) {
                primary = error;
            } finally {
                const closure = closeEntries([entry], this.io);
                if (!closure.complete) {
                    if (this.reportingErrors.length < 4)
                        this.reportingErrors.push(boundedText(JSON.stringify(closure), 512));
                    primary ??= Error('Preparation record sync/close unknown');
                }
            }
            if (primary) throw primary;
            assert.deepEqual(recordIdentity(this.io.lstatSync(file)), identity);
            this.committed.push({ file, identity, sha256: digest(bytes) });
            if (this.activeQuery) {
                if (stage === 'security-input') this.activeQuery.inputClosed = true;
                if (stage === 'security-command-closed') this.activeQuery.resultClosed = true;
                assert(this.bytes - this.activeQuery.bytes <= this.limits.queryBytes);
                assert(this.rows - this.activeQuery.sequence <= this.limits.queryRows);
            }
            if (
                !previous &&
                reusable.has(stage) &&
                this.dictionary.size < this.limits.dictionaryRows &&
                this.dictionaryBytes + payloadBytes <= this.limits.dictionaryBytes
            ) {
                this.dictionary.set(key, { file, sequence, identity, recordSHA256: digest(bytes) });
                this.dictionaryBytes += payloadBytes;
            }
        } catch (error) {
            if (error !== budgetRefusal) this.unknown(error, stage);
            throw error;
        }
    }
}

/** Bounded strict audit reader. References can target only earlier full same-stage records.
 * Consume the complete iterator before claiming the entire prefix is valid. */
function fullData(row) {
    if (Object.hasOwn(row, 'data')) {
        assert.deepEqual(Object.keys(row).sort(), ['data', 'schema', 'sequence', 'stage']);
        return row.data;
    }
    assert.deepEqual(Object.keys(row).sort(), ['encoded', 'schema', 'sequence', 'stage']);
    const e = row.encoded;
    assert.deepEqual(Object.keys(e).sort(), ['base64', 'bytes', 'dataSHA256', 'encoding']);
    assert.equal(e.encoding, 'deflate-raw-base64');
    assert(
        Number.isSafeInteger(e.bytes) &&
            e.bytes > 0 &&
            e.bytes <= preparationEvidenceLimits.rowBytes,
    );
    const compressed = Buffer.from(e.base64, 'base64');
    assert.equal(compressed.toString('base64'), e.base64);
    const raw = inflateRawSync(compressed, { maxOutputLength: preparationEvidenceLimits.rowBytes });
    assert.equal(raw.length, e.bytes);
    assert.equal(digest(raw), e.dataSHA256);
    const value = JSON.parse(raw.toString());
    assert(Buffer.from(JSON.stringify(value)).equals(raw));
    return value;
}
export function* readPreparationEvidence(directory, { io = fs, check = () => {} } = {}) {
    const names = io.readdirSync(directory).sort();
    assert(names.length <= preparationEvidenceLimits.rows);
    let bytes = 0;
    const read = (sequence) => {
        check();
        const raw = boundedRead(
            path.join(directory, String(sequence).padStart(6, '0') + '.json'),
            preparationEvidenceLimits.rowBytes,
            io,
        );
        const row = JSON.parse(raw.toString());
        assert(
            Buffer.from(JSON.stringify(row) + '\n').equals(raw),
            'Noncanonical preparation record',
        );
        assert.equal(row.schema, 1);
        assert.equal(row.sequence, sequence);
        return { row, raw };
    };
    for (let sequence = 0; sequence < names.length; sequence++) {
        assert.equal(names[sequence], String(sequence).padStart(6, '0') + '.json');
        const { row, raw } = read(sequence);
        bytes += raw.length;
        assert(bytes <= preparationEvidenceLimits.bytes);
        assert(typeof row.stage === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(row.stage));
        if (Object.hasOwn(row, 'reference')) {
            assert.deepEqual(Object.keys(row).sort(), ['reference', 'schema', 'sequence', 'stage']);
            assert(reusable.has(row.stage));
            const ref = row.reference;
            assert.deepEqual(Object.keys(ref).sort(), ['bytes', 'dataSHA256', 'sequence']);
            assert(
                Number.isSafeInteger(ref.sequence) && ref.sequence >= 0 && ref.sequence < sequence,
            );
            const origin = read(ref.sequence).row;
            const data = fullData(origin);
            assert.equal(origin.stage, row.stage);
            const payload = Buffer.from(JSON.stringify(data));
            assert.equal(payload.length, ref.bytes);
            assert.equal(digest(payload), ref.dataSHA256);
            yield { sequence, stage: row.stage, data };
        } else {
            yield { sequence, stage: row.stage, data: fullData(row) };
        }
    }
}

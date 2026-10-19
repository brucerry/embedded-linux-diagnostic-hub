// @ts-nocheck
import { encodeProvenance, decodeProvenance } from './soak-provenance-codec.mjs';
import { SoakPhysicalCharges } from './soak-physical-charges.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import {
    CanonicalStaging,
    measureCanonical,
    canonicalDigest,
    allocateCanonical,
} from './soak-canonical.mjs';
import contract from './soak-evidence-contract.json' with { type: 'json' };
import { losslessReportStages, lifecycleEvidenceStages } from './startup-identity-report.mjs';
export const soakEvidenceContract = Object.freeze(contract);
export const soakEvidenceContractSHA256 = hash(Buffer.from(JSON.stringify(contract)));
export const soakEvidenceLimits = Object.freeze(contract.limits);
const stages = new Set([...contract.ordinaryStages, ...losslessReportStages]);
const lifecycle = new Set(lifecycleEvidenceStages);
const reportAdmissions = new WeakMap();
const shaPattern = /^[a-f0-9]{64}$/;
const positive = (n) => Number.isSafeInteger(n) && n >= 0;
export function hash(b) {
    return createHash('sha256').update(b).digest('hex');
}
const exact = (v, keys) => {
    assert(v && typeof v === 'object' && !Array.isArray(v));
    assert.deepEqual(Object.keys(v).sort(), [...keys].sort(), 'Soak schema keys');
};
/** Lexical quotas are checked before JSON.parse allocates its object graph. */
export function boundedJSON(
    bytes,
    max = soakEvidenceLimits.reportBytes,
    allocation,
    baseDepth = 0,
) {
    assert(Buffer.isBuffer(bytes) && bytes.length <= max, 'Soak JSON byte bound');
    let depth = 0,
        nodes = 0,
        members = 0,
        quoted = false,
        escape = false,
        bare = false;
    const token = () => {
        if (nodes++) members++;
        assert(
            nodes <= contract.limits.nodes && members <= contract.limits.members,
            'Soak JSON object quota',
        );
    };
    for (const c of bytes) {
        if (quoted) {
            if (escape) escape = false;
            else if (c === 92) escape = true;
            else if (c === 34) quoted = false;
            continue;
        }
        if (c === 34) {
            bare = false;
            quoted = true;
            token();
        } else if (c === 123 || c === 91) {
            bare = false;
            token();
            assert(++depth + baseDepth <= contract.limits.depth, 'Soak JSON depth');
        } else if (c === 125 || c === 93) {
            bare = false;
            assert(--depth >= 0);
        } else if (c === 44 || c === 58 || c === 32 || c === 9 || c === 10 || c === 13)
            bare = false;
        else if (!bare) {
            token();
            bare = true;
        }
    }
    assert(!quoted && !escape && depth === 0, 'Soak JSON truncated');
    if (allocation) {
        assert(
            (allocation.nodes ?? 0) + nodes <= contract.limits.nodes &&
                (allocation.members ?? 0) + members <= contract.limits.members,
            'Soak cumulative object quota',
        );
        allocation.nodes = (allocation.nodes ?? 0) + nodes;
        allocation.members = (allocation.members ?? 0) + members;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        value = JSON.parse(text);
    const measured = measureCanonical(value, contract.limits, max);
    assert(
        measured.bytes === bytes.length && canonicalDigest(value, bytes.length) === hash(bytes),
        'Soak canonical JSON',
    );
    return value;
}

function canonical(value, max = contract.limits.reportBytes) {
    const measured = measureCanonical(value, contract.limits, max);
    return allocateCanonical(value, measured.bytes);
}
/** Simultaneous byte-buffer credit, checked before packet allocation. */
export function readerBufferAdmission(
    packetBytes,
    dictionaryBytes,
    reportBytes,
    readerBytes = contract.limits.readerBufferBytes,
) {
    assert([packetBytes, dictionaryBytes, reportBytes, readerBytes].every(positive));
    assert(
        dictionaryBytes <= contract.limits.dictionaryBytes &&
            reportBytes <= contract.limits.reportBytes &&
            readerBytes <= contract.limits.readerBufferBytes,
        'Soak declared buffer bounds',
    );
    const total =
        packetBytes +
        dictionaryBytes +
        reportBytes +
        contract.limits.inputBufferBytes +
        contract.limits.rowBytes;
    assert(total <= readerBytes, 'Soak reader buffer credit');
    return {
        total,
        availablePacketBytes:
            readerBytes -
            dictionaryBytes -
            reportBytes -
            contract.limits.inputBufferBytes -
            contract.limits.rowBytes,
    };
}
/** Full-soak counters are lifetime totals. Reservations are never refunded or reset. */
export class SoakLedger {
    constructor(limits = soakEvidenceLimits) {
        this.limits = { ...limits };
        this.used = {
            physicalBytes: 0,
            physicalRows: 0,
            records: 0,
            reports: 0,
            decodedBytes: 0,
            sampleDecodedBytes: 0,
            otherDecodedBytes: 0,
            cleanupDecodedBytes: 0,
            samples: 0,
            dictionaryEntries: 0,
            dictionaryBytes: 0,
        };
        for (const [key, value] of Object.entries(this.limits))
            assert(
                positive(value) && value <= soakEvidenceLimits[key],
                'Soak limit cannot exceed declared contract',
            );
        this.cleanup = false;
        this.failed = null;
    }
    enterCleanup() {
        this.cleanup = true;
    }
    fork() {
        const next = new SoakLedger(this.limits);
        next.used = { ...this.used };
        next.cleanup = this.cleanup;
        next.failed = this.failed;
        next.cleanupFailed = this.cleanupFailed;
        return next;
    }
    reserve(charge, partition = this.cleanup ? 'cleanup' : charge.samples ? 'sample' : 'other') {
        if (this.cleanupFailed || (!this.cleanup && this.failed))
            throw this.cleanupFailed ?? this.failed;
        assert(['sample', 'other', 'cleanup'].includes(partition));
        assert(
            !Object.keys(charge).some((key) =>
                ['sampleDecodedBytes', 'otherDecodedBytes', 'cleanupDecodedBytes'].includes(key),
            ),
            'Forged decoded partition charge',
        );
        assert((partition === 'cleanup') === this.cleanup, 'Soak partition phase');
        if (Object.hasOwn(charge, 'decodedBytes')) {
            const key = partition + 'DecodedBytes';
            assert(!Object.hasOwn(charge, key), 'Forged decoded partition charge');
            charge = { ...charge, [key]: charge.decodedBytes };
        }
        try {
            for (const [key, n] of Object.entries(charge)) {
                assert(Object.hasOwn(this.used, key) && positive(n), 'Soak charge');
                const work = 'work' + key[0].toUpperCase() + key.slice(1),
                    cap =
                        !this.cleanup && this.limits[work] !== undefined
                            ? this.limits[work]
                            : this.limits[key];
                assert(this.used[key] + n <= cap, 'Soak lifetime budget: ' + key);
            }
            for (const [key, n] of Object.entries(charge)) this.used[key] += n;
        } catch (e) {
            if (this.cleanup) this.cleanupFailed ??= e;
            else this.failed ??= e;
            throw e;
        }
    }
    snapshot() {
        return { ...this.used };
    }
}
/** Exact immutable dictionary entries; there are no references inside definitions. */
function encode(value, dictionary, definitions, property = '', geometry = 0) {
    if (geometry === 3) return encodeProvenance(value);
    const intern = (v) => dictionary.intern(v);
    if (typeof value === 'string' && property === '$key') return intern(value);
    if (
        value &&
        typeof value === 'object' &&
        (property === 'fixtureOwnership' ||
            property === 'productOwnership' ||
            value.state === 'terminated')
    )
        return intern(value);
    if (Array.isArray(value) && property === 'events')
        return [
            1,
            ...value.map((item) =>
                item && typeof item === 'object'
                    ? intern(item)
                    : encode(item, dictionary, definitions),
            ),
        ];
    if (typeof value === 'number' && value < 0) return [0, value];
    if (Array.isArray(value)) return [1, ...value.map((v) => encode(v, dictionary, definitions))];
    if (value && typeof value === 'object')
        return [
            2,
            ...Object.keys(value).flatMap((k) => [
                -intern(k),
                encode(
                    value[k],
                    dictionary,
                    definitions,
                    k,
                    geometry === 1 && k === 'read'
                        ? 2
                        : geometry === 2 && k === 'provenance'
                          ? 3
                          : 0,
                ),
            ]),
        ];
    return value;
}
function decode(
    node,
    dictionary,
    depth = 0,
    quota = { nodes: 0, members: 0, bytes: 0 },
    geometry = 0,
) {
    if (geometry === 3) {
        assert(Array.isArray(node) && node[0] === 3, 'Provenance codec required');
        return decodeProvenance(node, quota, depth);
    }
    assert(!Array.isArray(node) || node[0] !== 3, 'Provenance codec outside declared stage/path');
    assert(depth <= contract.limits.depth, 'Soak expansion depth');
    const charge = (bytes) => {
        quota.bytes = (quota.bytes ?? 0) + bytes;
        assert(quota.bytes <= contract.limits.reportBytes, 'Soak per-report expansion bytes');
    };
    if (typeof node === 'number' && node < 0) {
        assert(
            Number.isSafeInteger(node) && dictionary.has(-node),
            'Soak foreign/forward reference',
        );
        const entry = dictionary.get(-node);
        charge(entry.bytes);
        quota.nodes += entry.stats.nodes;
        quota.members += entry.stats.members;
        assert(
            quota.nodes <= contract.limits.nodes &&
                quota.members <= contract.limits.members &&
                depth + entry.stats.depth <= contract.limits.depth,
            'Soak cumulative cached expansion quota',
        );
        return entry.value;
    }
    assert(++quota.nodes <= contract.limits.nodes, 'Soak cumulative object quota');
    if (!Array.isArray(node)) {
        assert(node === null || ['string', 'boolean', 'number'].includes(typeof node));
        charge(measureCanonical(node, contract.limits).bytes);
        return node;
    }
    assert(node.length && [0, 1, 2].includes(node[0]), 'Soak node tag');
    if (node[0] === 0) {
        assert(
            node.length === 2 &&
                typeof node[1] === 'number' &&
                Number.isFinite(node[1]) &&
                node[1] < 0,
        );
        charge(measureCanonical(node[1], contract.limits).bytes);
        return node[1];
    }
    if (node[0] === 1) {
        quota.members = (quota.members ?? 0) + node.length - 1;
        assert(quota.members <= contract.limits.members, 'Soak cumulative members');
        charge(2 + Math.max(0, node.length - 2));
        return node.slice(1).map((value) => decode(value, dictionary, depth + 1, quota));
    }
    assert(node.length % 2 === 1 && node.length / 2 <= contract.limits.members);
    charge(2 + Math.max(0, (node.length - 1) / 2 - 1));
    const value = {};
    for (let i = 1; i < node.length; i += 2) {
        assert(positive(node[i]) && node[i] > 0 && dictionary.has(node[i]));
        quota.members = (quota.members ?? 0) + 2;
        assert(quota.members <= contract.limits.members, 'Soak cumulative members');
        const keyEntry = dictionary.get(node[i]);
        charge(keyEntry.bytes + 1);
        const key = keyEntry.value;
        quota.nodes += keyEntry.stats.nodes;
        quota.members += keyEntry.stats.members;
        assert(typeof key === 'string' && !Object.hasOwn(value, key), 'Soak duplicate key');
        Object.defineProperty(value, key, {
            value: decode(
                node[i + 1],
                dictionary,
                depth + 1,
                quota,
                geometry === 1 && key === 'read'
                    ? 2
                    : geometry === 2 && key === 'provenance'
                      ? 3
                      : 0,
            ),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return value;
}
/** Owner-bound local writer; finite IPC queues and limits are untouched. */
export class SoakTimeline {
    /** @type {any} */ emit;
    constructor(handle, options) {
        this.handle = handle;
        this.options = options;
        assert(
            shaPattern.test(options.sourceSHA256) &&
                typeof options.nonce === 'string' &&
                options.nonce.length <= 128,
        );
        this.ledger = new SoakLedger(options.limits);
        this.staging = new CanonicalStaging(contract.limits.writerCanonicalBytes);
        this.dictionary = new Map();
        this.ordinal = 0;
        this.sequence = 0;
        this.tx = 0;
        this.tail = Promise.resolve();
        this.failure = null;
        this.workFailure = null;
        this.holdFailure = null;
        this.closed = false;
        this.footerDurable = false;
        this.closing = false;
        this.waiters = 0;
        this.executing = false;
        this.als = new AsyncLocalStorage();
        this.rolling = createHash('sha256');
        this.physicalCharges = new SoakPhysicalCharges();
        this.seenStartup = new Set();
        this.previousTiming = null;
        const admission = Symbol();
        reportAdmissions.set(this, admission);
        this.emit = (stage, data) => this.record(stage, data);
        this.emit.publishIdentity = (stage, data) => {
            assert(losslessReportStages.includes(stage));
            return this.record(stage, data, admission);
        };
    }
    now() {
        return this.options.monotonic?.() ?? performance.now();
    }
    fail(error) {
        this.workFailure ??= error;
        try {
            this.options.hold(this.workFailure);
        } catch (holdError) {
            this.holdFailure ??= holdError;
        }
        return this.workFailure;
    }
    fatal(error) {
        this.failure ??= error;
        this.fail(error);
        return this.failure;
    }
    enqueue(work, cleanup = false) {
        if (this.failure || (this.workFailure && !this.cleanupStarted && !cleanup))
            return Promise.reject(this.failure ?? this.workFailure);
        if (this.closing || this.closed)
            return Promise.reject(this.fail(Error('Soak timeline closed admission')));
        if (++this.waiters > contract.limits.queueRequests + (this.executing ? 1 : 0)) {
            this.waiters--;
            return Promise.reject(this.fail(Error('Soak timeline queue bound')));
        }
        const task = this.tail.then(async () => {
            if (this.failure || (this.workFailure && !this.cleanupStarted && !cleanup))
                throw this.failure ?? this.workFailure;
            this.executing = true;
            try {
                return await work();
            } finally {
                this.executing = false;
            }
        });
        this.tail = task.then(
            () => {
                this.waiters--;
            },
            (error) => {
                this.waiters--;
                this.fail(error);
            },
        );
        void task.catch(() => {});
        return task;
    }
    async row(bytes, charge = { kind: 'soak-control' }) {
        assert(
            bytes.length <= this.ledger.limits.rowBytes &&
                bytes.length <= this.ledger.limits.pendingBytes,
            'Soak encoded row/pending bound',
        );
        try {
            await this.handle.writeFile(bytes);
        } catch (error) {
            throw this.fatal(error);
        }
        this.rolling.update(bytes);
        this.physicalCharges.observe(charge, bytes.length);
    }
    async sync() {
        try {
            await this.handle.sync();
        } catch (error) {
            throw this.fatal(error);
        }
    }
    start() {
        return this.enqueue(async () => {
            assert(!this.started);
            this.started = true;
            const row = Buffer.from(
                JSON.stringify({
                    kind: 'soak-header',
                    schema: 1,
                    format: contract.format,
                    sourceSHA256: this.options.sourceSHA256,
                    nonce: this.options.nonce,
                    budgetSHA256: soakEvidenceContractSHA256,
                }) + '\n',
            );
            this.ledger.reserve({ physicalRows: 1, physicalBytes: row.length });
            await this.row(row);
            await this.sync();
        });
    }
    snapshot(stage, data) {
        assert(stages.has(stage), 'Soak stage allowlist: ' + stage);
        const begin = this.now(),
            scratch = this.staging.acquire(contract.limits.inputBufferBytes);
        let retained;
        try {
            const value = { stage, data },
                measured = measureCanonical(value, contract.limits);
            retained = this.staging.acquire(measured.bytes);
            const sha256 = canonicalDigest(value, measured.bytes);
            return {
                stage,
                value,
                bytes: measured.bytes,
                sha256,
                time: this.options.wallClock?.() ?? Date.now(),
                retained,
                canonicalizationMs: this.now() - begin,
            };
        } catch (error) {
            retained?.release();
            throw error;
        } finally {
            scratch.release();
        }
    }
    releaseRequest(request) {
        if (request.retained) {
            request.retained.release();
            request.retained = null;
        }
        request.value = null;
    }
    materialize(request) {
        let output, scratch;
        const begin = this.now();
        try {
            // Queued requests retain the caller graph with exact canonical-equivalent credit;
            // no cloned graph, Buffer or full JSON string exists before active admission.
            scratch = this.staging.acquire(contract.limits.inputBufferBytes);
            const measured = measureCanonical(request.value, contract.limits);
            assert(measured.bytes === request.bytes, 'Queued canonical source mutated');
            output = this.staging.acquire(request.bytes);
            const raw = allocateCanonical(request.value, request.bytes, request.sha256);
            return {
                ...request,
                value: null,
                retained: null,
                raw,
                credit: output,
                canonicalizationMs: request.canonicalizationMs + this.now() - begin,
            };
        } catch (error) {
            output?.release();
            throw error;
        } finally {
            scratch?.release();
            this.releaseRequest(request);
        }
    }
    allowed(stage) {
        assert(
            !this.cleanupStarted || contract.cleanupStages.includes(stage),
            'Soak cleanup-only stage admission: ' + stage,
        );
    }
    record(stage, data, admission) {
        let request;
        try {
            if (this.failure || (this.workFailure && !this.cleanupStarted))
                throw this.failure ?? this.workFailure;
            assert(!this.closing && !this.closed, 'Soak timeline closed admission');
            if (losslessReportStages.includes(stage))
                assert(admission === reportAdmissions.get(this), 'Soak report capability');
            this.allowed(stage);
            const active = this.als.getStore();
            if (!active)
                assert(
                    this.waiters < contract.limits.queueRequests + (this.executing ? 1 : 0),
                    'Soak timeline queue bound',
                );
            request = this.snapshot(stage, data);
            if (active) {
                assert(active.events.length < 128, 'Soak transaction event bound');
                const item = this.materialize(request);
                active.events.push(item);
                return Promise.resolve();
            }
            return this.enqueue(async () => {
                this.allowed(stage);
                const item = this.materialize(request);
                return this.commit([item], false);
            }).finally(() => this.releaseRequest(request));
        } catch (error) {
            if (request) this.releaseRequest(request);
            return Promise.reject(this.fail(error));
        }
    }
    transaction(work) {
        return this.enqueue(async () => {
            assert(!this.cleanupStarted, 'Soak sample/work admission after cleanup');
            const active = { events: [] };
            let value, error;
            try {
                value = await this.als.run(active, work);
            } catch (failure) {
                error = failure;
            }
            try {
                if (this.failure) throw this.failure;
                if (active.events.length) await this.commit(active.events, true, !error);
                if (error) throw error;
                return value;
            } finally {
                for (const event of active.events) event.credit?.release();
                active.events.length = 0;
            }
        });
    }
    async commit(events, sample, usable = true) {
        const planningStarted = this.now(),
            temporary = [];
        let committed = false;
        try {
            assert(this.started && !this.failure && events.length > 0 && events.length <= 128);
            assert(!sample || !this.cleanupStarted, 'Soak sample/work admission after cleanup');
            for (const event of events) this.allowed(event.stage);
            assert(this.staging.used <= this.staging.limit, 'Shared canonical commit charge');
            const planned = this.ledger.fork();
            const startup = new Set(this.seenStartup),
                definitions = [],
                overlay = new Map();
            const dictionary = {
                intern: (value) => {
                    const measured = measureCanonical(value, contract.limits),
                        sha256 = canonicalDigest(value, measured.bytes);
                    const prior = overlay.get(sha256) ?? this.dictionary.get(sha256);
                    if (prior) return -prior.id;
                    // Reserve lifetime dictionary credit before retaining a definition or overlay entry.
                    planned.reserve({ dictionaryEntries: 1, dictionaryBytes: measured.bytes });
                    const credit = this.staging.acquire(measured.bytes);
                    temporary.push(credit);
                    const raw = allocateCanonical(value, measured.bytes, sha256);
                    const entry = {
                        id: this.dictionary.size + overlay.size + 1,
                        bytes: raw,
                        sha256,
                    };
                    overlay.set(sha256, entry);
                    definitions.push(entry);
                    return -entry.id;
                },
            };
            let ordinal = this.ordinal,
                sequence = this.sequence,
                decodedBytes = 0,
                reportCount = 0,
                canonicalizationMs = 0,
                completeWindow = false;
            const encoded = [];
            for (const event of events) {
                const scratch = this.staging.acquire(
                    event.bytes * 2 + contract.limits.inputBufferBytes,
                );
                try {
                    // Only one decoded graph and its temporary text exist during reference encoding.
                    const value = boundedJSON(event.raw);
                    if (value.stage === 'sampling-window' && value.data.status === 'unavailable')
                        completeWindow = true;
                    if (losslessReportStages.includes(event.stage)) {
                        reportCount++;
                        if (!lifecycle.has(event.stage)) {
                            const key = event.stage + ':' + event.sha256;
                            assert(!startup.has(key), 'Duplicate startup identity');
                            startup.add(key);
                        }
                    }
                    // Encoded nodes may retain inline value strings after the decode scratch is
                    // released. Acquire a conservative canonical-equivalent upper bound first;
                    // dictionary keys/reference tags and negative escapes are at most4x input.
                    const encodedCredit = this.staging.acquire(event.bytes * 4);
                    temporary.push(encodedCredit);
                    const node = encode(
                        value.data,
                        dictionary,
                        definitions,
                        '',
                        event.stage === 'actual-product-serial-geometry' ? 1 : 0,
                    );
                    assert(
                        measureCanonical(node, contract.limits, encodedCredit.bytes).bytes <=
                            encodedCredit.bytes,
                        'Encoded canonical staging bound',
                    );
                    encoded.push([
                        sequence++,
                        lifecycle.has(event.stage) ? ++ordinal : null,
                        -encode(event.stage, dictionary, definitions, '$key'),
                        event.time,
                        event.bytes,
                        event.sha256,
                        node,
                    ]);
                    decodedBytes += event.bytes;
                    canonicalizationMs += event.canonicalizationMs;
                } finally {
                    scratch.release();
                }
            }
            assert(
                !sample || (usable ? events.at(-1).stage === 'processes' : completeWindow),
                'Soak sample missing complete window/result',
            );
            const strings = [];
            for (const definition of definitions) {
                const credit = this.staging.acquire(definition.bytes.length);
                temporary.push(credit);
                strings.push([
                    definition.id,
                    definition.bytes.length,
                    definition.sha256,
                    definition.bytes.toString(),
                ]);
            }
            const value = { definitions: strings, events: encoded },
                dictionaryBytes = planned.used.dictionaryBytes,
                reportBytes = Math.max(...events.map((event) => event.bytes));
            const available = readerBufferAdmission(
                0,
                dictionaryBytes,
                reportBytes,
            ).availablePacketBytes;
            const measured = measureCanonical(value, contract.limits, Math.max(0, available));
            // Encoded packet allocation has its own simultaneous reader credit; it is not a 32-MiB allowance.
            const packet = allocateCanonical(value, measured.bytes),
                tx = this.tx + 1,
                parts = Math.ceil(packet.length / 49152),
                sha256 = hash(packet);
            const make = (index) =>
                Buffer.from(
                    JSON.stringify({
                        kind: 'soak-extent',
                        tx,
                        index,
                        parts,
                        bytes: packet.length,
                        sha256,
                        dictionaryBytes,
                        reportBytes,
                        base64: packet
                            .subarray(index * 49152, (index + 1) * 49152)
                            .toString('base64'),
                    }) + '\n',
                );
            const commit = Buffer.from(
                JSON.stringify({
                    kind: 'soak-commit',
                    tx,
                    parts,
                    bytes: packet.length,
                    sha256,
                    sample,
                    usable,
                    previousTiming: this.previousTiming,
                }) + '\n',
            );
            const local =
                this.options.compact !== false && packet.length <= contract.compactRecordBytes
                    ? Buffer.from(
                          JSON.stringify({
                              kind: 'soak-local',
                              tx,
                              bytes: packet.length,
                              sha256,
                              sample,
                              usable,
                              previousTiming: this.previousTiming,
                              dictionaryBytes,
                              reportBytes,
                              packet: value,
                          }) + '\n',
                      )
                    : null;
            let physicalBytes = local ? local.length : commit.length;
            for (let index = 0; !local && index < parts; index++) {
                const row = make(index);
                assert(row.length <= this.ledger.limits.pendingBytes);
                physicalBytes += row.length;
            }
            planned.reserve({
                physicalRows: local ? 1 : parts + 1,
                physicalBytes,
                records: events.length,
                reports: reportCount,
                decodedBytes: decodedBytes * contract.decodedPasses,
                samples: sample ? 1 : 0,
            });
            assert(ordinal <= this.ledger.limits.reports, 'Soak lifecycle ordinal');
            this.ledger = planned;
            const planningEnded = this.now(),
                writeStarted = this.now();
            if (local) await this.row(local, { kind: 'soak-local', bytes: packet.length });
            else {
                for (let index = 0; index < parts; index++)
                    await this.row(make(index), {
                        kind: 'soak-extent',
                        index,
                        bytes: packet.length,
                        base64Bytes:
                            4 * Math.ceil(Math.min(49152, packet.length - index * 49152) / 3),
                    });
                await this.row(commit, { kind: 'soak-commit' });
            }
            const writeEnded = this.now(),
                syncStarted = this.now();
            await this.sync();
            const syncEnded = this.now();
            this.previousTiming = {
                tx,
                clockDomain: 'node-performance',
                canonicalizationMs,
                referenceEncodingMs: planningEnded - planningStarted,
                writeStartedMono: writeStarted,
                writeEndedMono: writeEnded,
                syncStartedMono: syncStarted,
                syncEndedMono: syncEnded,
            };
            for (const [sha, entry] of overlay) this.dictionary.set(sha, entry);
            this.seenStartup = startup;
            this.ordinal = ordinal;
            this.sequence = sequence;
            this.tx = tx;
            committed = true;
        } finally {
            for (const credit of temporary) credit.release();
            for (const event of events) {
                event.raw = null;
                if (event.credit) {
                    event.credit.release();
                    event.credit = null;
                }
            }
        }
    }
    async cleanupMarker() {
        assert(!this.cleanupStarted, 'Soak cleanup entered twice');
        this.cleanupStarted = true;
        this.ledger.enterCleanup();
        const row = Buffer.from(
            JSON.stringify({
                kind: 'soak-cleanup',
                tx: this.tx,
                workFailure: this.workFailure ? String(this.workFailure).slice(0, 4096) : null,
            }) + '\n',
        );
        this.ledger.reserve({ physicalRows: 1, physicalBytes: row.length });
        await this.row(row);
        await this.sync();
    }
    enterCleanup() {
        return this.enqueue(() => this.cleanupMarker(), true);
    }
    finish() {
        if (!this.finishPromise) {
            this.closing = true;
            this.finishPromise = this.finishOnce();
        }
        return this.finishPromise;
    }
    closureProof() {
        return Object.freeze({
            descriptorClosed: this.closed,
            footerDurable: this.footerDurable,
            ioFailure: Boolean(this.failure),
            complete: this.closed && this.footerDurable && !this.failure,
        });
    }
    async finishOnce() {
        let error;
        try {
            await this.tail;
            if (this.failure) throw this.failure;
            assert(this.started, 'Soak missing header');
            if (!this.cleanupStarted) await this.cleanupMarker();
            const before = this.ledger.snapshot();
            const footer = Buffer.from(
                JSON.stringify({
                    kind: 'soak-footer',
                    tx: this.tx,
                    sequence: this.sequence,
                    ordinal: this.ordinal,
                    before,
                    sha256: this.rolling.copy().digest('hex'),
                    lastTiming: this.previousTiming,
                    workFailure: this.workFailure ? String(this.workFailure).slice(0, 4096) : null,
                    physicalChargesBeforeFooter: this.physicalCharges.snapshot(),
                }) + '\n',
            );
            this.ledger.reserve({ physicalRows: 1, physicalBytes: footer.length });
            await this.row(footer);
            await this.sync();
            this.footerDurable = true;
        } catch (failure) {
            error = this.fail(failure);
        }
        try {
            await this.handle.close();
            this.closed = true;
        } catch (failure) {
            error ??= this.fail(failure);
        }
        if (error || this.workFailure) throw error ?? this.workFailure;
        return {
            complete: true,
            counters: this.ledger.snapshot(),
            canonicalStagingPeak: this.staging.peak,
            physicalCharges: this.physicalCharges.snapshot(),
            format: contract.format,
            contractSHA256: soakEvidenceContractSHA256,
        };
    }
}

/** Incremental strict reader; retains dictionary and at most one transaction/report. */
export class SoakDecoder {
    constructor(options) {
        assert(
            typeof options.beginTransaction === 'function',
            'Soak transactional consumer required',
        );
        this.options = options;
        this.ledger = new SoakLedger(options.limits);
        this.dictionary = new Map();
        this.dictionaryHashes = new Set();
        this.sequence = 0;
        this.ordinal = 0;
        this.tx = 0;
        this.started = false;
        this.footer = false;
        this.failure = null;
        this.pending = null;
        this.rolling = createHash('sha256');
        this.physicalCharges = new SoakPhysicalCharges();
        this.peakPacketBytes = 0;
        this.seenStartup = new Set();
        this.lastTimingTx = 0;
        this.lastSyncEnd = null;
    }
    timing(value, tx) {
        if (tx === 0) {
            assert(value === null, 'Unexpected initial observer timing');
            return;
        }
        exact(value, [
            'tx',
            'clockDomain',
            'canonicalizationMs',
            'referenceEncodingMs',
            'writeStartedMono',
            'writeEndedMono',
            'syncStartedMono',
            'syncEndedMono',
        ]);
        assert(
            value.tx === tx &&
                tx === this.lastTimingTx + 1 &&
                value.clockDomain === 'node-performance',
            'Observer timing identity',
        );
        for (const key of Object.keys(value).filter((key) => key !== 'clockDomain'))
            assert(Number.isFinite(value[key]) && value[key] >= 0, 'Observer timing finite bound');
        assert(
            value.writeEndedMono >= value.writeStartedMono &&
                value.syncStartedMono >= value.writeEndedMono &&
                value.syncEndedMono >= value.syncStartedMono,
            'Observer timing order',
        );
        if (this.lastSyncEnd !== null)
            assert(value.writeStartedMono >= this.lastSyncEnd, 'Observer timing overlap');
        this.lastTimingTx = tx;
        this.lastSyncEnd = value.syncEndedMono;
        this.options.timing?.(value);
    }
    event(event, dictionary, sequence, ordinal, quota, p) {
        assert(Array.isArray(event) && event.length === 7);
        const [seq, ord, stageID, time, bytes, sha, node] = event;
        assert(
            seq === sequence &&
                dictionary.has(stageID) &&
                Number.isSafeInteger(time) &&
                positive(bytes) &&
                bytes > 0 &&
                bytes <= p.reportBytes &&
                shaPattern.test(sha),
            'Soak event binding',
        );
        const stage = dictionary.get(stageID).value;
        assert(typeof stage === 'string');
        assert(stages.has(stage), 'Soak unknown logical stage');
        assert(
            lifecycle.has(stage) ? ord === ordinal + 1 : ord === null,
            'Soak lifecycle ordering',
        );
        assert(
            !this.cleanupStarted || contract.cleanupStages.includes(stage),
            'Soak cleanup-only stage admission',
        );
        const reportQuota = { nodes: quota.nodes, members: quota.members, bytes: 0 };
        const data = decode(
            node,
            dictionary,
            0,
            reportQuota,
            stage === 'actual-product-serial-geometry' ? 1 : 0,
        );
        quota.nodes = reportQuota.nodes;
        quota.members = reportQuota.members;
        const value = { stage, data },
            measured = measureCanonical(value, contract.limits, p.reportBytes);
        assert(
            measured.bytes === bytes && canonicalDigest(value, bytes) === sha,
            'Soak exact logical bytes/SHA',
        );
        return { time, stage, data };
    }
    accept(line) {
        if (this.failure) throw this.failure;
        try {
            assert(
                Buffer.isBuffer(line) &&
                    line.at(-1) === 10 &&
                    line.length <= this.ledger.limits.rowBytes &&
                    !this.footer,
                'Soak line/EOF bound',
            );
            const row = boundedJSON(line.subarray(0, -1), this.ledger.limits.rowBytes),
                before = this.ledger.snapshot();
            if (row.kind === 'soak-cleanup') {
                exact(row, ['kind', 'tx', 'workFailure']);
                assert(
                    row.workFailure === null ||
                        (typeof row.workFailure === 'string' && row.workFailure.length <= 4096),
                );
                this.workFailure = row.workFailure;
                assert(
                    this.started && !this.pending && !this.cleanupStarted && row.tx === this.tx,
                    'Soak cleanup boundary',
                );
                this.cleanupStarted = true;
                this.ledger.enterCleanup();
            }
            this.ledger.reserve({ physicalRows: 1, physicalBytes: line.length });
            if (row.kind === 'soak-cleanup') {
            } else if (!this.started) {
                exact(row, ['kind', 'schema', 'format', 'sourceSHA256', 'nonce', 'budgetSHA256']);
                assert(
                    row.kind === 'soak-header' &&
                        row.schema === 1 &&
                        row.format === contract.format &&
                        row.sourceSHA256 === this.options.sourceSHA256 &&
                        row.nonce === this.options.nonce &&
                        row.budgetSHA256 === soakEvidenceContractSHA256,
                    'Soak header binding',
                );
                this.started = true;
            } else if (row.kind === 'soak-footer') {
                exact(row, [
                    'kind',
                    'tx',
                    'sequence',
                    'ordinal',
                    'before',
                    'sha256',
                    'lastTiming',
                    'workFailure',
                    'physicalChargesBeforeFooter',
                ]);
                assert(
                    row.workFailure === null ||
                        (typeof row.workFailure === 'string' &&
                            row.workFailure.length > 0 &&
                            row.workFailure.length <= 4096),
                    'Soak work failure schema',
                );
                assert(
                    this.workFailure === null || row.workFailure === this.workFailure,
                    'Soak work failure cannot clear or change',
                );
                this.workFailure = row.workFailure;
                assert(
                    this.cleanupStarted &&
                        !this.pending &&
                        row.tx === this.tx &&
                        row.sequence === this.sequence &&
                        row.ordinal === this.ordinal,
                    'Soak footer identity',
                );
                assert.deepEqual(row.before, before);
                assert.deepEqual(
                    row.physicalChargesBeforeFooter,
                    this.physicalCharges.snapshot(),
                    'Physical charge footer binding',
                );
                assert(row.sha256 === this.rolling.copy().digest('hex'), 'Soak footer digest');
                this.timing(row.lastTiming, this.tx);
                this.footer = true;
            } else if (row.kind === 'soak-extent') {
                exact(row, [
                    'kind',
                    'tx',
                    'index',
                    'parts',
                    'bytes',
                    'sha256',
                    'dictionaryBytes',
                    'reportBytes',
                    'base64',
                ]);
                assert(
                    positive(row.tx) &&
                        row.tx === this.tx + 1 &&
                        positive(row.index) &&
                        positive(row.parts) &&
                        row.parts > 0 &&
                        positive(row.bytes) &&
                        row.bytes > 0 &&
                        row.parts === Math.ceil(row.bytes / 49152) &&
                        shaPattern.test(row.sha256),
                    'Soak extent bound',
                );
                assert(
                    positive(row.dictionaryBytes) &&
                        row.dictionaryBytes >= this.ledger.used.dictionaryBytes &&
                        row.dictionaryBytes <= this.ledger.limits.dictionaryBytes &&
                        positive(row.reportBytes) &&
                        row.reportBytes > 0 &&
                        row.reportBytes <= this.ledger.limits.reportBytes,
                    'Soak declared buffer bounds',
                );
                readerBufferAdmission(
                    row.bytes,
                    row.dictionaryBytes,
                    row.reportBytes,
                    this.ledger.limits.readerBufferBytes,
                );
                if (!this.pending)
                    this.pending = {
                        tx: row.tx,
                        parts: row.parts,
                        bytes: row.bytes,
                        sha256: row.sha256,
                        dictionaryBytes: row.dictionaryBytes,
                        reportBytes: row.reportBytes,
                        buffer: Buffer.alloc(row.bytes),
                        next: 0,
                        received: 0,
                    };
                const pending = this.pending;
                assert(
                    row.index === pending.next++ &&
                        row.index < row.parts &&
                        row.parts === pending.parts &&
                        row.bytes === pending.bytes &&
                        row.sha256 === pending.sha256 &&
                        row.dictionaryBytes === pending.dictionaryBytes &&
                        row.reportBytes === pending.reportBytes,
                    'Soak extent order/binding',
                );
                assert(typeof row.base64 === 'string');
                const raw = Buffer.from(row.base64, 'base64');
                assert(
                    raw.toString('base64') === row.base64 &&
                        raw.length === Math.min(49152, row.bytes - row.index * 49152),
                    'Soak canonical extent',
                );
                raw.copy(pending.buffer, pending.received);
                pending.received += raw.length;
                this.peakPacketBytes = Math.max(this.peakPacketBytes, pending.buffer.length);
            } else if (row.kind === 'soak-commit' || row.kind === 'soak-local') {
                const local = row.kind === 'soak-local';
                if (local)
                    exact(row, [
                        'kind',
                        'tx',
                        'bytes',
                        'sha256',
                        'sample',
                        'usable',
                        'previousTiming',
                        'dictionaryBytes',
                        'reportBytes',
                        'packet',
                    ]);
                else
                    exact(row, [
                        'kind',
                        'tx',
                        'parts',
                        'bytes',
                        'sha256',
                        'sample',
                        'usable',
                        'previousTiming',
                    ]);
                const p = local ? { ...row, parts: 1, next: 1, received: row.bytes } : this.pending;
                if (local) {
                    assert(
                        !this.pending &&
                            row.tx === this.tx + 1 &&
                            positive(row.bytes) &&
                            row.bytes > 0 &&
                            row.bytes <= contract.compactRecordBytes &&
                            shaPattern.test(row.sha256),
                        'Soak local binding',
                    );
                    assert(
                        positive(row.dictionaryBytes) &&
                            row.dictionaryBytes >= this.ledger.used.dictionaryBytes &&
                            row.dictionaryBytes <= this.ledger.limits.dictionaryBytes &&
                            positive(row.reportBytes) &&
                            row.reportBytes > 0 &&
                            row.reportBytes <= this.ledger.limits.reportBytes,
                    );
                    readerBufferAdmission(
                        row.bytes,
                        row.dictionaryBytes,
                        row.reportBytes,
                        this.ledger.limits.readerBufferBytes,
                    );
                }
                assert(
                    p &&
                        p.next === p.parts &&
                        row.tx === p.tx &&
                        (local || row.parts === p.parts) &&
                        row.bytes === p.bytes &&
                        row.sha256 === p.sha256 &&
                        typeof row.sample === 'boolean' &&
                        typeof row.usable === 'boolean',
                    'Soak partial commit',
                );
                assert(
                    !row.sample || !this.cleanupStarted,
                    'Soak sample/work admission after cleanup',
                );
                assert(
                    p.received === p.bytes &&
                        (local
                            ? measureCanonical(row.packet, contract.limits, p.bytes).bytes ===
                                  p.bytes && canonicalDigest(row.packet, p.bytes) === p.sha256
                            : hash(p.buffer) === p.sha256),
                    'Soak packet SHA',
                );
                const value = local ? row.packet : boundedJSON(p.buffer, p.bytes);
                exact(value, ['definitions', 'events']);
                assert(
                    Array.isArray(value.definitions) &&
                        Array.isArray(value.events) &&
                        value.events.length > 0 &&
                        value.events.length <= 128,
                );
                const overlay = new Map(),
                    hashes = new Set(),
                    startup = new Set(this.seenStartup),
                    quota = { nodes: 0, members: 0 };
                const dictionary = {
                    has: (id) => overlay.has(id) || this.dictionary.has(id),
                    get: (id) => overlay.get(id) ?? this.dictionary.get(id),
                };
                let dictionaryBytes = 0;
                for (const definition of value.definitions) {
                    assert(Array.isArray(definition) && definition.length === 4);
                    const [id, bytes, sha, json] = definition;
                    assert(
                        id === this.dictionary.size + overlay.size + 1 &&
                            positive(bytes) &&
                            bytes > 0 &&
                            bytes <= this.ledger.limits.reportBytes &&
                            shaPattern.test(sha) &&
                            typeof json === 'string',
                    );
                    assert(
                        !this.dictionaryHashes.has(sha) && !hashes.has(sha),
                        'Soak duplicate dictionary definition',
                    );
                    assert(
                        Buffer.byteLength(json) === bytes &&
                            bytes + this.ledger.used.dictionaryBytes <= p.dictionaryBytes,
                        'Soak dictionary declared charge',
                    );
                    this.ledger.reserve({ dictionaryEntries: 1, dictionaryBytes: bytes });
                    const raw = Buffer.from(json);
                    assert(hash(raw) === sha, 'Soak dictionary hash');
                    const parsed = boundedJSON(raw, contract.limits.reportBytes, quota);
                    assert(
                        typeof parsed === 'string' || (parsed && typeof parsed === 'object'),
                        'Soak dictionary definition kind',
                    );
                    const freeze = (v) => {
                        if (v && typeof v === 'object') {
                            for (const item of Object.values(v)) freeze(item);
                            Object.freeze(v);
                        }
                        return v;
                    };
                    overlay.set(id, {
                        bytes,
                        value: freeze(parsed),
                        stats: measureCanonical(parsed, contract.limits),
                    });
                    hashes.add(sha);
                    dictionaryBytes += bytes;
                }
                let sequence = this.sequence,
                    ordinal = this.ordinal,
                    decodedBytes = 0,
                    reportCount = 0,
                    lastStage,
                    unavailable = false;
                // Validate exactly once into bounded provisional semantic state before commit.
                const provisional = this.options.beginTransaction?.();
                assert(
                    !provisional ||
                        (typeof provisional.record === 'function' &&
                            typeof provisional.commit === 'function'),
                    'Soak semantic transaction port',
                );
                for (const encoded of value.events) {
                    const event = this.event(encoded, dictionary, sequence++, ordinal, quota, p);
                    if (lifecycle.has(event.stage)) ordinal++;
                    if (losslessReportStages.includes(event.stage)) {
                        reportCount++;
                        if (!lifecycle.has(event.stage)) {
                            const key = event.stage + ':' + encoded[5];
                            assert(!startup.has(key), 'Duplicate startup identity');
                            startup.add(key);
                        }
                    }
                    decodedBytes += encoded[4];
                    lastStage = event.stage;
                    unavailable ||=
                        event.stage === 'sampling-window' && event.data.status === 'unavailable';
                    provisional?.record(event);
                }
                assert(
                    !row.sample || (row.usable ? lastStage === 'processes' : unavailable),
                    'Soak incomplete sample',
                );
                assert(
                    this.ledger.used.dictionaryBytes === p.dictionaryBytes &&
                        Math.max(...value.events.map((event) => event[4])) === p.reportBytes,
                    'Soak exact declared allocation',
                );
                this.ledger.reserve({
                    records: value.events.length,
                    reports: reportCount,
                    decodedBytes: decodedBytes * contract.decodedPasses,
                    samples: row.sample ? 1 : 0,
                });
                assert(ordinal <= this.ledger.limits.reports, 'Soak lifecycle ordinal');
                this.timing(row.previousTiming, this.tx);
                provisional.commit();
                for (const [id, raw] of overlay) this.dictionary.set(id, raw);
                for (const sha of hashes) this.dictionaryHashes.add(sha);
                this.seenStartup = startup;
                this.sequence = sequence;
                this.ordinal = ordinal;
                this.tx = p.tx;
                this.pending = null;
            } else assert.fail('Soak unknown/mixed format');
            this.rolling.update(line);
            this.physicalCharges.observe(row, line.length);
        } catch (error) {
            this.failure ??= error;
            throw error;
        }
    }
    finish() {
        if (this.failure) throw this.failure;
        try {
            assert(
                this.started && this.footer && !this.pending,
                'Soak missing footer/incomplete EOF',
            );
            return {
                complete: this.workFailure === null,
                workFailure: this.workFailure,
                counters: this.ledger.snapshot(),
                peakPacketBytes: this.peakPacketBytes,
                physicalCharges: this.physicalCharges.snapshot(),
                decodedPassesReserved: contract.decodedPasses,
                observerTimingTransactions: this.lastTimingTx,
            };
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }
}

/** Each yielded view is borrowed until the next iteration; one row scratch and one input buffer. */
export function* boundedFileLines(file, options = {}) {
    const io = options.io ?? fs,
        fd = io.openSync(file, 'r'),
        input = Buffer.alloc(contract.limits.inputBufferBytes),
        row = Buffer.alloc(contract.limits.rowBytes);
    let used = 0;
    try {
        for (;;) {
            const count = io.readSync(fd, input, 0, input.length, null);
            if (!count) break;
            let start = 0;
            for (let i = 0; i < count; i++)
                if (input[i] === 10) {
                    const n = i + 1 - start;
                    assert(used + n <= row.length, 'Soak input line bound');
                    input.copy(row, used, start, i + 1);
                    used += n;
                    yield row.subarray(0, used);
                    used = 0;
                    start = i + 1;
                }
            assert(used + count - start <= row.length, 'Soak partial line bound');
            input.copy(row, used, start, count);
            used += count - start;
        }
        assert(used === 0, 'Soak unterminated EOF');
    } finally {
        io.closeSync(fd);
    }
}

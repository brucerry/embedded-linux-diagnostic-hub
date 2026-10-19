import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    processQueryCommand,
    processQueryDigest,
    validateProcessQueryProof,
} from '../../scripts/lib/pilot-process-query.mjs';
export type ProcessRow = { pid: number; parent: number; created: string; rssBytes: number | null };
type Row = ProcessRow;
const processTables = new WeakMap<
    Row[],
    { stdoutSHA256: string; stdoutBytes: number; querySequence: number }
>();
let processQuerySequence = 0;
export async function readLinuxProcesses(
    io: { list(): Promise<string[]>; read(file: string): Promise<string> } = {
        list: () => fs.readdir('/proc'),
        read: (file) => fs.readFile(file, 'utf8'),
    },
): Promise<Row[]> {
    const result: Row[] = [];
    for (const name of await io.list()) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const raw = await io.read(`/proc/${name}/stat`),
                fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
            const status = await io.read(`/proc/${name}/status`),
                match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
            if (fields[0] !== 'Z')
                result.push({
                    pid: Number(name),
                    parent: Number(fields[1]),
                    created: fields[19],
                    rssBytes: match ? Number(match[1]) * 1024 : null,
                });
        } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
                throw error;
        }
    }
    return result;
}
export async function readProcessTable(onClosedQuery?: (proof: any) => void): Promise<Row[]> {
    if (process.platform === 'linux') return readLinuxProcesses();
    const windows = process.platform === 'win32';
    const command = processQueryCommand(process.platform);
    const querySequence = ++processQuerySequence;
    assert(Number.isSafeInteger(querySequence));
    let queryPID: number | undefined,
        spawned = false;
    let exit: { code: number | null; signal: string | null } | undefined;
    let close: typeof exit;
    const raw = await new Promise<Buffer>((resolve, reject) => {
        const child = execFile(
            command.file,
            command.args,
            { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 ** 2, encoding: 'buffer' },
            (error, text) => (error ? reject(error) : resolve(text)),
        );
        queryPID = child.pid;
        child.once('spawn', () => {
            spawned = true;
        });
        child.once('exit', (code, signal) => {
            exit = { code, signal };
        });
        child.once('close', (code, signal) => {
            close = { code, signal };
        });
    });
    // execFile's callback is invoked by its close handler. Let every close listener run
    // before using the child as a positive exit-and-inherited-pipe witness.
    await Promise.resolve();
    const stdout = raw.toString('utf8');
    const tableSHA256 = createHash('sha256').update(raw).digest('hex');
    const rows: Row[] = windows
        ? JSON.parse(stdout).map((row: Record<string, string | number>) => ({
              pid: Number(row.ProcessId),
              parent: Number(row.ParentProcessId),
              created: typeof row.Created === 'string' ? row.Created : '',
              rssBytes: Number(row.WorkingSetSize),
          }))
        : stdout
              .trim()
              .split('\n')
              .flatMap((line) => {
                  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\d+)\s*$/.exec(line);
                  return match
                      ? [
                            {
                                pid: Number(match[1]),
                                parent: Number(match[2]),
                                created: match[3],
                                rssBytes: Number(match[4]) * 1024,
                            },
                        ]
                      : [];
              });
    if (onClosedQuery) {
        const owner = rows.find((row) => row.pid === process.pid);
        const query = rows.find((row) => row.pid === queryPID);
        assert(owner && query, 'Owned process query creation identity unavailable');
        onClosedQuery(
            validateProcessQueryProof({
                schema: 1,
                platform: process.platform,
                querySHA256: processQueryDigest(process.platform),
                tableSHA256,
                querySequence,
                ownerPID: owner.pid,
                ownerCreated: owner.created,
                pid: query.pid,
                created: query.created,
                parentPID: query.parent,
                spawn: spawned,
                exit: Boolean(exit),
                close: Boolean(close),
                exitCode: exit?.code,
                exitSignal: exit?.signal,
                closeCode: close?.code,
                closeSignal: close?.signal,
            }),
        );
    }
    processTables.set(rows, { stdoutSHA256: tableSHA256, stdoutBytes: raw.length, querySequence });
    return rows;
}
/** Roots must come from this fixture's launched children, never an ambient process name. */
export class ProcessSampler {
    private identities = new Map<
        string,
        { pid: number; created: string; root: boolean; parentKey?: string }
    >();
    private rootInstances = new Map<number, string>();
    private closedQueries = new Map<string, { proof: any; acceptedSequence: number }>();
    private querySequence = 0;
    private retiredCount = 0;
    private retiredDigest = '0'.repeat(64);
    private witnessedUnseen = 0;
    private tableDigest: string | undefined;
    private tableQuerySequence: number | undefined;
    private tableSource: ReturnType<typeof processTables.get>;
    private failure: unknown;
    private overflow: unknown;
    private lastCensus: any;
    constructor(
        private roots: number[],
        private readTable: () => Promise<Row[]> = readProcessTable,
    ) {}
    /** Called only for durably accepted, bound stage-query closure receipts. */
    acceptClosedQuery(input: unknown, ownerPID: number) {
        if (this.failure) throw this.failure;
        try {
            const proof = validateProcessQueryProof(input);
            assert.equal(proof.ownerPID, ownerPID);
            assert(this.roots.includes(ownerPID), 'Query owner is not this sampler root');
            const key = JSON.stringify([proof.pid, proof.created]);
            assert(!this.closedQueries.has(key), 'Duplicate query closure witness');
            assert(this.closedQueries.size < 256, 'Pending query closure witness bound exceeded');
            this.closedQueries.set(key, { proof, acceptedSequence: this.querySequence });
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }
    historyProof() {
        return {
            querySequence: this.querySequence,
            tableSHA256: this.tableDigest,
            tableQuerySequence: this.tableQuerySequence,
            rawTable: this.tableSource,
            unresolved: this.identities.size,
            pendingClosedQueries: this.closedQueries.size,
            retiredCount: this.retiredCount,
            retiredSHA256: this.retiredDigest,
            witnessedUnseen: this.witnessedUnseen,
            ...(this.overflow ? { overflow: this.overflow } : {}),
            ...(this.failure ? { failure: String(this.failure).slice(0, 512) } : {}),
        };
    }
    async sample() {
        if (this.failure) throw this.failure;
        try {
            return await this.sampleCurrent();
        } catch (error) {
            this.failure ??= error;
            throw this.failure;
        }
    }
    private async sampleCurrent() {
        const sequence = ++this.querySequence;
        const rows = await this.readTable();
        assert(Array.isArray(rows), 'Complete process table unavailable');
        assert(new Set(rows.map((row) => row.pid)).size === rows.length, 'Ambiguous process table');
        this.tableDigest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        this.tableQuerySequence = sequence;
        this.tableSource = processTables.get(rows);
        const key = (row: Pick<Row, 'pid' | 'created'>) => JSON.stringify([row.pid, row.created]);
        for (const pid of this.roots) {
            const row = rows.find((value) => value.pid === pid);
            if (!this.rootInstances.has(pid)) {
                if (!row?.created || Buffer.byteLength(JSON.stringify(row.created)) > 128)
                    throw Error(`Owned root identity unavailable: ${pid}.`);
                this.rootInstances.set(pid, row.created);
                this.identities.set(key(row), { pid, created: row.created, root: true });
                this.checkBound(rows);
            }
        }
        for (const [id, closed] of this.closedQueries) {
            const { proof } = closed;
            // A response from a query already in flight when the receipt arrived is
            // insufficient. Require a subsequently started complete OS observation.
            if (sequence <= closed.acceptedSequence) continue;
            assert.equal(
                this.rootInstances.get(proof.ownerPID),
                proof.ownerCreated,
                'Query owner creation mismatch',
            );
            const samePID = rows.find((row) => row.pid === proof.pid);
            if (samePID && !samePID.created)
                throw Error(`Owned process liveness unknown: ${proof.pid}.`);
            if (samePID?.created === proof.created) continue;
            const tracked = this.identities.get(id);
            if (tracked) {
                assert(!tracked.root, 'Cannot retire immutable root identity');
                assert.equal(
                    tracked.parentKey,
                    JSON.stringify([proof.ownerPID, proof.ownerCreated]),
                    'Query ancestry mismatch',
                );
                this.identities.delete(id);
                this.retiredCount++;
                this.retiredDigest = createHash('sha256')
                    .update(this.retiredDigest + '\0' + JSON.stringify(proof))
                    .digest('hex');
            } else this.witnessedUnseen++;
            this.closedQueries.delete(id);
            assert(
                Number.isSafeInteger(this.retiredCount) &&
                    Number.isSafeInteger(this.witnessedUnseen),
            );
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const row of rows) {
                const parent = rows.find((value) => value.pid === row.parent);
                if (parent && this.identities.has(key(parent)) && !this.identities.has(key(row))) {
                    if (!row.created || Buffer.byteLength(JSON.stringify(row.created)) > 128)
                        throw Error(`Owned descendant identity unavailable: ${row.pid}.`);
                    this.identities.set(key(row), {
                        pid: row.pid,
                        created: row.created,
                        root: false,
                        parentKey: key(parent),
                    });
                    this.checkBound(rows);
                    changed = true;
                }
            }
        }
        const census = [...this.identities.values()].map(({ pid, created, root }) => {
            if (rows.some((value) => value.pid === pid && !value.created))
                throw Error(`Owned process liveness unknown: ${pid}.`);
            const row = rows.find((value) => value.pid === pid && value.created === created);
            return {
                pid,
                created,
                role: root ? 'fixture-root' : 'owned-descendant',
                state: row ? ('running' as const) : ('terminated' as const),
                rssBytes: row?.rssBytes ?? null,
                heapUsedBytes: null,
                externalBytes: null,
                arrayBuffersBytes: null,
                unsupported: [
                    'OS sample has no JS/native allocation breakdown',
                    ...(row && row.rssBytes === null
                        ? ['OS RSS unavailable for a live process']
                        : []),
                ],
            };
        });
        this.lastCensus = {
            observedAt: Number(process.hrtime.bigint() / 1000000n),
            clockDomain: 'node-hrtime-milliseconds',
            sequence,
            tableSHA256: this.tableDigest,
            rawTable: this.tableSource ?? null,
            tuples: census.map((row) => [row.pid, row.created, row.role, row.state]),
        };
        return census;
    }
    /** Complete owned tuples from the last completed admitted read; never opens a query. */
    observationFacts() {
        return this.lastCensus
            ? {
                  ...this.lastCensus,
                  tuples: this.lastCensus.tuples.map((row: any[]) => [...row]),
                  lastReadComplete: true,
                  laterFailure: this.failure ? String(this.failure).slice(0, 512) : null,
              }
            : {
                  lastReadComplete: false,
                  reason: 'No complete owned observation retained.',
                  laterFailure: this.failure ? String(this.failure).slice(0, 512) : null,
              };
    }
    private checkBound(rows: Row[]) {
        if (this.identities.size > 256) {
            const all = [...this.identities.values()].map((id) => [
                id.pid,
                id.created,
                id.root,
                rows.some((row) => row.pid === id.pid && !row.created)
                    ? 'unknown'
                    : rows.some((row) => row.pid === id.pid && row.created === id.created)
                      ? 'running'
                      : 'terminated',
            ]);
            this.overflow = {
                historicalIncludingRetired: this.retiredCount + this.identities.size,
                unresolved: this.identities.size,
                live: all.filter((row) => row[3] === 'running').length,
                terminated: all.filter((row) => row[3] === 'terminated').length,
                unknown: all.filter((row) => row[3] === 'unknown').length,
                tuples: all.slice(0, 257),
                tuplesComplete: this.identities.size <= 257,
                discoveryStoppedAtFirstRejection: true,
                roots: [...this.rootInstances].map(([pid, created]) => [pid, created]),
            };
            this.failure = Error('Owned process identity bound exceeded.');
            throw this.failure;
        }
    }
    async assertExited() {
        const remaining = (await this.sample()).filter((row) => row.state === 'running');
        if (remaining.length)
            throw Error(`Owned descendants still running: ${JSON.stringify(remaining)}`);
    }
}

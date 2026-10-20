import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    processQueryCommand,
    processQueryDigest,
    validateProcessQueryProof,
} from '../../scripts/lib/pilot-process-query.mjs';
export type ProcessRow = {
    pid: number;
    parent: number;
    created: string;
    rssBytes: number | null;
    creationClock?: 'windows-utc-100ns' | 'linux-start-ticks' | 'macos-local-second';
};
/** Exact Win32_Process UTC identity; Date.parse would discard submillisecond ordering. */
export function windowsCreationOrder(created: string): bigint {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/.exec(created);
    assert(match, 'Windows creation chronology unavailable');
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    assert(year >= 1601 && month >= 1 && month <= 12 && day >= 1 && day <= 31);
    assert(hour <= 23 && minute <= 59 && second <= 59);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    assert(
        date.getUTCFullYear() === year &&
            date.getUTCMonth() === month - 1 &&
            date.getUTCDate() === day &&
            date.getUTCHours() === hour &&
            date.getUTCMinutes() === minute &&
            date.getUTCSeconds() === second,
        'Windows creation chronology invalid',
    );
    return BigInt(date.getTime()) * 10000n + BigInt(match[7]);
}
/** Production readers attach the clock domain; opaque injected labels are not authority. */
function creationOrder(row: ProcessRow): bigint {
    assert(
        typeof row.created === 'string' && Buffer.byteLength(JSON.stringify(row.created)) <= 128,
        'Process creation identity unavailable',
    );
    if (row.creationClock === 'windows-utc-100ns') return windowsCreationOrder(row.created);
    if (row.creationClock === 'linux-start-ticks') {
        assert(/^(0|[1-9][0-9]*)$/.test(row.created), 'Linux creation ticks unavailable');
        return BigInt(row.created);
    }
    assert(row.creationClock === 'macos-local-second', 'Process creation clock unavailable');
    // ps lstart has local wall time, no offset/fold, and only second precision.
    // Validate its shape/calendar, but never use its apparent order to exclude custody.
    const m =
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(
            row.created,
        );
    assert(m, 'macOS creation chronology unavailable');
    const month =
        [
            'Jan',
            'Feb',
            'Mar',
            'Apr',
            'May',
            'Jun',
            'Jul',
            'Aug',
            'Sep',
            'Oct',
            'Nov',
            'Dec',
        ].indexOf(m[2]) + 1;
    const iso = `${m[7]}-${String(month).padStart(2, '0')}-${m[3].padStart(2, '0')}T${m[4]}:${m[5]}:${m[6]}.0000000Z`;
    const order = windowsCreationOrder(iso);
    assert(
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
            new Date(Number(order / 10000n)).getUTCDay()
        ] === m[1],
        'macOS creation weekday mismatch',
    );
    return order;
}
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
                    creationClock: 'linux-start-ticks',
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
              creationClock: 'windows-utc-100ns' as const,
              rssBytes: Number(row.WorkingSetSize),
          }))
        : stdout
              .trim()
              .split('\n')
              .map((line) => {
                  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\d+)\s*$/.exec(line);
                  assert(match, 'Incomplete ps process table row');
                  return {
                      pid: Number(match[1]),
                      parent: Number(match[2]),
                      created: match[3],
                      creationClock: 'macos-local-second' as const,
                      rssBytes: Number(match[4]) * 1024,
                  };
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
        {
            pid: number;
            created: string;
            root: boolean;
            parentKey?: string;
            creationClock?: Row['creationClock'];
        }
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
    private ancestry: any;
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
            ...(this.ancestry ? { ancestry: this.ancestry } : {}),
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
        assert(
            this.roots.every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
                new Set(this.roots).size === this.roots.length,
            'Malformed owned root PIDs',
        );
        assert(new Set(rows.map((row) => row.pid)).size === rows.length, 'Ambiguous process table');
        this.tableDigest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        this.tableQuerySequence = sequence;
        this.tableSource = processTables.get(rows);
        const byPID = new Map(rows.map((row) => [row.pid, row]));
        assert(
            rows.every(
                (row) =>
                    Number.isSafeInteger(row.pid) &&
                    row.pid >= 0 &&
                    Number.isSafeInteger(row.parent) &&
                    row.parent >= 0,
            ),
            'Malformed process PID table',
        );
        this.ancestry = {
            tableSequence: sequence,
            tableSHA256: this.tableDigest,
            decisions: [],
            omitted: 0,
            total: 0,
            digest: '0'.repeat(64),
        };
        const decided = new Set<string>();
        const decision = (child: Row, parent: Row, result: string, currentParent?: Row) => {
            const id = JSON.stringify([child.pid, child.created, parent.pid, parent.created]);
            if (decided.has(id)) return;
            decided.add(id);
            const fact = {
                childPID: child.pid,
                childCreated: String(child.created).slice(0, 128),
                parentPID: parent.pid,
                parentCreated: String(parent.created).slice(0, 128),
                domain: child.creationClock ?? null,
                parentDomain: parent.creationClock ?? null,
                result,
                ...(currentParent &&
                (currentParent.created !== parent.created ||
                    currentParent.creationClock !== parent.creationClock)
                    ? {
                          currentParentCreated: String(currentParent.created).slice(0, 128),
                          currentParentDomain: currentParent.creationClock ?? null,
                      }
                    : {}),
            };
            this.ancestry.total++;
            this.ancestry.digest = createHash('sha256')
                .update(this.ancestry.digest + '\0' + JSON.stringify(fact))
                .digest('hex');
            if (this.ancestry.decisions.length < 8) this.ancestry.decisions.push(fact);
            else this.ancestry.omitted++;
        };
        // A tracked generation may disappear; a replacement must still have readable
        // same-domain identity. Backwards generation changes are detectable uncertainty.
        for (const tracked of this.identities.values()) {
            const current = byPID.get(tracked.pid);
            if (!current) continue;
            assert(current.created, `Owned process liveness unknown: ${tracked.pid}.`);
            assert(
                current.creationClock === tracked.creationClock,
                'Identity creation clock changed',
            );
            const order = creationOrder(current);
            if (
                current.created !== tracked.created &&
                tracked.creationClock !== 'macos-local-second'
            )
                assert(
                    order >= creationOrder({ ...current, created: tracked.created }),
                    'Process creation clock discontinuity',
                );
        }
        const key = (row: Pick<Row, 'pid' | 'created'>) => JSON.stringify([row.pid, row.created]);
        for (const pid of this.roots) {
            const row = rows.find((value) => value.pid === pid);
            if (!this.rootInstances.has(pid)) {
                if (!row?.created || Buffer.byteLength(JSON.stringify(row.created)) > 128)
                    throw Error(`Owned root identity unavailable: ${pid}.`);
                creationOrder(row);
                assert(row.parent !== row.pid, 'Owned root is self-parented');
                this.rootInstances.set(pid, row.created);
                this.identities.set(key(row), {
                    pid,
                    created: row.created,
                    root: true,
                    creationClock: row.creationClock,
                });
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
            const owner = this.identities.get(JSON.stringify([proof.ownerPID, proof.ownerCreated]));
            assert(owner, 'Closed query owner clock unavailable');
            assert(
                (owner.creationClock === 'windows-utc-100ns' && proof.platform === 'win32') ||
                    (owner.creationClock === 'macos-local-second' && proof.platform === 'darwin'),
                'Closed query clock/platform mismatch',
            );
            const queryOrder = creationOrder({
                pid: proof.pid,
                parent: proof.ownerPID,
                created: proof.created,
                rssBytes: null,
                creationClock: owner.creationClock,
            });
            const ownerOrder = creationOrder({
                pid: owner.pid,
                parent: 0,
                created: owner.created,
                rssBytes: null,
                creationClock: owner.creationClock,
            });
            if (owner.creationClock !== 'macos-local-second')
                assert(queryOrder >= ownerOrder, 'Closed query predates its owner identity');
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
        // Known ownership survives disappearance of a parent from later tables.
        // Keep every unresolved generation, not just the current PID occupant.
        const ownedByPID = new Map<number, Row[]>();
        const rememberParent = (identity: {
            pid: number;
            created: string;
            creationClock?: Row['creationClock'];
        }) => {
            const versions = ownedByPID.get(identity.pid) ?? [];
            versions.push({ ...identity, parent: 0, rssBytes: null });
            ownedByPID.set(identity.pid, versions);
        };
        for (const identity of this.identities.values()) rememberParent(identity);
        // Discover the complete table's provable owned generations before using
        // remembered generations to diagnose any unresolved edge. A replacement
        // may itself become owned later in an unordered/multi-hop table.
        let discoveryComplete = false;
        for (;;) {
            let changed = false;
            for (const row of rows) {
                if (this.identities.has(key(row))) continue;
                const knownParents = ownedByPID.get(row.parent);
                if (!knownParents) continue;
                const currentParent = byPID.get(row.parent);
                let childOrder: bigint;
                let versions: { parent: Row; order: bigint }[];
                try {
                    childOrder = creationOrder(row);
                    versions = knownParents.map((parent) => {
                        assert(
                            parent.creationClock === row.creationClock,
                            'Ancestry creation clock unavailable',
                        );
                        return { parent, order: creationOrder(parent) };
                    });
                    if (currentParent) {
                        assert(
                            currentParent.creationClock === row.creationClock,
                            'Ancestry creation clock unavailable',
                        );
                        creationOrder(currentParent);
                    }
                } catch (error) {
                    decision(row, knownParents[0], 'ambiguous-identity-or-clock', currentParent);
                    throw error;
                }
                const localClock = row.creationClock === 'macos-local-second';
                const plausible = versions.filter(
                    (version) => localClock || childOrder >= version.order,
                );
                if (!plausible.length) {
                    const earliest = versions.reduce((a, b) => (a.order < b.order ? a : b));
                    decision(row, earliest.parent, 'excluded-strictly-older', currentParent);
                    continue;
                }
                const ownedCurrent = currentParent && this.identities.has(key(currentParent));
                const supportedCurrent =
                    ownedCurrent &&
                    plausible.find((version) => key(version.parent) === key(currentParent));
                if (!supportedCurrent) {
                    // Neither a sticky hold nor an ambient-replacement exclusion
                    // is final until current-table ownership reaches a fixed point.
                    if (!discoveryComplete) continue;
                    // A strictly newer birth after an unowned replacement cannot belong
                    // to an earlier terminated generation. Equality/local wall clocks
                    // cannot establish this exclusion and therefore remain unknown.
                    if (currentParent && !ownedCurrent && !localClock) {
                        const replacementOrder = creationOrder(currentParent);
                        if (
                            childOrder > replacementOrder &&
                            plausible.every((version) => version.order < replacementOrder)
                        ) {
                            decision(
                                row,
                                plausible[0].parent,
                                'excluded-after-unowned-replacement',
                                currentParent,
                            );
                            continue;
                        }
                    }
                    decision(
                        row,
                        plausible[0].parent,
                        currentParent
                            ? 'unresolved-owned-parent-generation'
                            : 'unresolved-owned-parent-absent',
                        currentParent,
                    );
                    throw Error(
                        `Unresolved ancestry for process ${row.pid}: known owned parent ${row.parent} is absent or a different generation`,
                    );
                }
                const parent = supportedCurrent.parent;
                decision(
                    row,
                    parent,
                    localClock
                        ? 'retained-local-clock-ambiguous'
                        : childOrder === supportedCurrent.order
                          ? 'retained-equal-birth'
                          : 'retained-compatible-birth',
                );
                const identity = {
                    pid: row.pid,
                    created: row.created,
                    root: false,
                    parentKey: key(parent),
                    creationClock: row.creationClock,
                };
                this.identities.set(key(row), identity);
                this.checkBound(rows);
                rememberParent(identity);
                changed = true;
            }
            if (changed) continue;
            if (discoveryComplete) break;
            discoveryComplete = true;
        }
        const census = [...this.identities.values()].map(
            ({ pid, created, root, creationClock }) => {
                if (rows.some((value) => value.pid === pid && !value.created))
                    throw Error(`Owned process liveness unknown: ${pid}.`);
                const row = rows.find((value) => value.pid === pid && value.created === created);
                if (row) {
                    assert(row.creationClock === creationClock, 'Identity creation clock changed');
                    creationOrder(row);
                }
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
            },
        );
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

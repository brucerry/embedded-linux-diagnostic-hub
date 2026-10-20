import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import * as queryModule from '../scripts/lib/pilot-process-query.mjs';
import {
    ProcessSampler,
    windowsCreationOrder,
    type ProcessRow,
} from './fixtures/memory-resource-processes';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import { createOwnershipHold } from '../scripts/lib/product-entry-custody.mjs';

const stamp = (fraction = '0000000') => `2026-10-20T03:49:21.${fraction}Z`;
const row = (pid: number, parent: number, created = stamp()): ProcessRow => ({
    pid,
    parent,
    created,
    rssBytes: 1,
    creationClock: 'windows-utc-100ns',
});
const root = row(10, 1);
const older = row(20, 10, '2026-10-20T03:44:01.8529010Z');
const newer = row(30, 10, stamp('0000001'));

test('older reused-parent instance and its subtree never become owned; exact later child still does', async () => {
    let rows = [row(21, 20, stamp('0000002')), older, newer, root];
    const sampler = new ProcessSampler([10], async () => rows);
    assert.deepEqual(
        (await sampler.sample()).map((r) => r.pid),
        [10, 30],
    );
    rows = [older, row(21, 20, stamp('0000002'))];
    await sampler.assertExited();
    assert.equal(sampler.historyProof().unresolved, 2);
    assert.equal(sampler.historyProof().retiredCount, 0);
});
test('chronology applies at every hop, with genuine newer grandchildren retained after reparenting', async () => {
    const parent = row(30, 10, stamp('0000002'));
    const genuine = row(40, 30, stamp('0000003'));
    let rows = [row(50, 30, stamp('0000001')), genuine, parent, root];
    const sampler = new ProcessSampler([10], async () => rows);
    assert.deepEqual((await sampler.sample()).map((r) => r.pid).sort(), [10, 30, 40]);
    rows = [{ ...genuine, parent: 1 }];
    await assert.rejects(sampler.assertExited(), /still running/);
    rows = [];
    await sampler.assertExited();
});
test('root PID reuse cannot enroll a new root instance or its descendants', async () => {
    let rows = [root, newer];
    const sampler = new ProcessSampler([10], async () => rows);
    await sampler.sample();
    rows = [row(10, 1, stamp('0000005')), row(50, 10, stamp('0000006')), { ...newer, parent: 1 }];
    const census = await sampler.sample();
    assert.equal(census.find((r) => r.pid === 10)?.state, 'terminated');
    assert(!census.some((r) => r.pid === 50));
    await assert.rejects(sampler.assertExited(), /still running/);
    rows = rows.slice(0, 2);
    await sampler.assertExited();
});
test('creation ordering retains all seven fractional digits', async () => {
    assert.equal(windowsCreationOrder(stamp('0000001')) - windowsCreationOrder(stamp()), 1n);
    const sampler = new ProcessSampler([10], async () => [
        row(10, 1, stamp('0000001')),
        row(20, 10, stamp()),
        row(30, 10, stamp('0000002')),
    ]);
    assert.deepEqual(
        (await sampler.sample()).map((r) => r.pid),
        [10, 30],
    );
});
test('equal creation instants are conservatively retained, never treated as evidence of unrelatedness', async () => {
    let rows = [root, row(20, 10)];
    const sampler = new ProcessSampler([10], async () => rows);
    assert.equal((await sampler.sample()).length, 2);
    rows = [row(20, 1)];
    await assert.rejects(sampler.assertExited(), /still running/);
});
for (const bad of [
    '',
    'not-a-time',
    '2026-10-20T03:49:21Z',
    '2026-10-20T03:49:21.000000Z',
    '2026-10-20T03:49:21.00000000Z',
    '2026-10-20T03:49:21.0000000+00:00',
    '2026-02-29T03:49:21.0000000Z',
    '2026-04-31T03:49:21.0000000Z',
    '2026-10-20T24:00:00.0000000Z',
    '2026-10-20T03:60:21.0000000Z',
    '2026-10-20T03:49:60.0000000Z',
    '1600-10-20T03:49:21.0000000Z',
    ' 2026-10-20T03:49:21.0000000Z',
]) {
    test(`unavailable/ambiguous Windows creation time holds: ${JSON.stringify(bad)}`, async () => {
        assert.throws(() => windowsCreationOrder(bad));
        let rows = [root, row(20, 10, bad)];
        const sampler = new ProcessSampler([10], async () => rows);
        await assert.rejects(sampler.sample());
        rows = [];
        await assert.rejects(sampler.assertExited());
        await assert.rejects(new ProcessSampler([10], async () => [row(10, 1, bad)]).sample());
    });
}
test('valid leap year and date boundaries compare without local timezone or millisecond rounding', () => {
    assert.equal(
        windowsCreationOrder('2024-03-01T00:00:00.0000000Z') -
            windowsCreationOrder('2024-02-29T23:59:59.9999999Z'),
        1n,
    );
    assert(
        windowsCreationOrder('1601-01-01T00:00:00.0000000Z') <
            windowsCreationOrder('9999-12-31T23:59:59.9999999Z'),
    );
});
for (const target of ['child', 'parent', 'changed-root', 'changed-child']) {
    test(`missing/mixed creation clock holds: ${target}`, async () => {
        let rows = [root, newer];
        const sampler = new ProcessSampler([10], async () => rows);
        if (target.startsWith('changed')) await sampler.sample();
        rows = [
            target.endsWith('root') || target === 'parent'
                ? { ...root, creationClock: undefined }
                : root,
            target.endsWith('child') || target === 'child'
                ? { ...newer, creationClock: undefined }
                : newer,
        ];
        await assert.rejects(sampler.sample(), /creation clock/);
        rows = [];
        await assert.rejects(sampler.assertExited());
    });
}
test('missing root, duplicate PID and missing live identity never become closure proof', async () => {
    await assert.rejects(new ProcessSampler([10], async () => []).sample(), /identity unavailable/);
    await assert.rejects(
        new ProcessSampler([10], async () => [root, root]).sample(),
        /Ambiguous process table/,
    );
    let rows = [root, newer];
    const sampler = new ProcessSampler([10], async () => rows);
    await sampler.sample();
    rows = [{ ...newer, created: '' }];
    await assert.rejects(sampler.assertExited(), /liveness unknown/);
});
test('older creation cannot be retired through an inconsistent closed-query proof', async () => {
    let rows = [root];
    const sampler = new ProcessSampler([10], async () => rows);
    await sampler.sample();
    sampler.acceptClosedQuery(
        {
            schema: 1,
            platform: 'win32',
            querySHA256: queryModule.processQueryDigest('win32'),
            tableSHA256: 'a'.repeat(64),
            querySequence: 1,
            ownerPID: 10,
            ownerCreated: root.created,
            pid: 20,
            created: older.created,
            parentPID: 10,
            spawn: true,
            exit: true,
            close: true,
            exitCode: 0,
            exitSignal: null,
            closeCode: 0,
            closeSignal: null,
        },
        10,
    );
    await assert.rejects(sampler.sample(), /predates its owner/);
    rows = [];
    await assert.rejects(sampler.assertExited());
    assert.equal(sampler.historyProof().retiredCount, 0);
    assert.equal(sampler.historyProof().witnessedUnseen, 0);
});
test('real Windows reader marks every UTC identity before any sampler decision', async () => {
    const text = fs.readFileSync(
        new URL('./fixtures/memory-resource-processes.ts', import.meta.url),
        'utf8',
    );
    const context = vm.createContext({
        process: { platform: 'win32', hrtime: process.hrtime },
        Buffer,
    });
    const fakeExec = (_file: any, _args: any, _options: any, callback: any) => {
        const child = Object.assign(new EventEmitter(), { pid: 55 });
        queueMicrotask(() =>
            callback(
                null,
                Buffer.from(
                    JSON.stringify([
                        {
                            ProcessId: 10,
                            ParentProcessId: 1,
                            Created: root.created,
                            WorkingSetSize: 1,
                        },
                        {
                            ProcessId: 20,
                            ParentProcessId: 10,
                            Created: older.created,
                            WorkingSetSize: 1,
                        },
                    ]),
                ),
            ),
        );
        return child;
    };
    const module = new vm.SourceTextModule(
        transformSync(text, { loader: 'ts', format: 'esm', target: 'es2022' }).code,
        { context },
    );
    await module.link(async (name) => {
        const value =
            name === 'node:child_process'
                ? { execFile: fakeExec }
                : name.endsWith('pilot-process-query.mjs')
                  ? queryModule
                  : await import(name);
        const keys = Object.keys(value);
        return new vm.SyntheticModule(
            keys,
            function () {
                for (const key of keys) this.setExport(key, value[key]);
            },
            { context },
        );
    });
    await module.evaluate();
    const rows = await (module.namespace as any).readProcessTable();
    assert(rows.every((r: ProcessRow) => r.creationClock === 'windows-utc-100ns'));
    const sampler = new (module.namespace as any).ProcessSampler([10], async () => rows);
    assert.deepEqual(
        Array.from(await sampler.sample(), (r: any) => r.pid),
        [10],
    );
});
for (const kind of ['older-unrelated', 'genuine-live', 'unknown-time', 'cancelled-unknown']) {
    test(`real startup controller cleanup/cancellation: ${kind}`, async (t) => {
        let rows = [
            root,
            kind === 'older-unrelated' ? older : kind === 'genuine-live' ? newer : row(20, 10, ''),
        ];
        const abort = new AbortController();
        let held: any, handle: ReturnType<typeof setInterval> | undefined;
        const child: any = Object.assign(new EventEmitter(), {
            pid: 10,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        });
        const manager = new NativePilotStartup({
            signal: abort.signal,
            deadline: Number(process.hrtime.bigint() / 1000000n) + 10000,
            readTable: async () => rows,
            emit: async () => {},
            hold: () => {
                manager.stopQueryAdmission();
                held ??= createOwnershipHold(
                    { releaseAuthorized: false },
                    () => {
                        throw Error('persistence failed');
                    },
                    {
                        interval: ((callback: () => void, ms: number) => {
                            handle = setInterval(callback, ms);
                            return handle;
                        }) as typeof setInterval,
                    },
                );
            },
        });
        t.after(() => {
            manager.stopQueryAdmission();
            if (handle) clearInterval(handle);
        });
        manager.adopt('ssh-runtime-build', child, () => {});
        if (kind.includes('unknown'))
            await assert.rejects(manager.children.get(child).identityTask);
        else await manager.children.get(child).identityTask;
        if (kind === 'cancelled-unknown') abort.abort(Error('normal cancellation'));
        rows =
            kind === 'genuine-live'
                ? [{ ...newer, parent: 1 }]
                : kind === 'older-unrelated'
                  ? [older]
                  : [];
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        if (kind === 'older-unrelated') {
            assert.equal((await manager.join()).complete, true);
            assert.equal(held, undefined);
        } else {
            await assert.rejects(manager.join());
            assert(held && handle?.hasRef());
            assert.equal(held.snapshot().referencedHandleCreated, true);
            assert.match(held.snapshot().recordErrors[0], /persistence failed/);
        }
    });
}

for (const difference of [-1n, 0n, 1n]) {
    test(`Linux ticks retain integer precision beyond Number safety: ${difference}`, async () => {
        const tick = 9007199254740993000n;
        let rows: ProcessRow[] = [
            {
                pid: 10,
                parent: 1,
                created: String(tick),
                rssBytes: 1,
                creationClock: 'linux-start-ticks',
            },
            {
                pid: 20,
                parent: 10,
                created: String(tick + difference),
                rssBytes: 1,
                creationClock: 'linux-start-ticks',
            },
        ];
        const sampler = new ProcessSampler([10], async () => rows);
        assert.equal((await sampler.sample()).length, difference < 0n ? 1 : 2);
        rows = rows.slice(1);
        if (difference < 0n) await sampler.assertExited();
        else await assert.rejects(sampler.assertExited(), /still running/);
    });
}
for (const birth of [
    'Tue Oct 20 03:49:20 2026',
    'Tue Oct 20 03:49:21 2026',
    'Tue Oct 20 03:49:22 2026',
]) {
    test(`macOS local/coarse clock conservatively retains relevant birth: ${birth}`, async () => {
        let rows: ProcessRow[] = [
            {
                pid: 10,
                parent: 1,
                created: 'Tue Oct 20 03:49:21 2026',
                rssBytes: 1,
                creationClock: 'macos-local-second',
            },
            {
                pid: 20,
                parent: 10,
                created: birth,
                rssBytes: 1,
                creationClock: 'macos-local-second',
            },
        ];
        const sampler = new ProcessSampler([10], async () => rows);
        assert.equal((await sampler.sample()).length, 2);
        assert.equal(
            sampler.historyProof().ancestry.decisions[0].result,
            'retained-local-clock-ambiguous',
        );
        rows = rows.slice(1);
        await assert.rejects(sampler.assertExited(), /still running/);
    });
}
for (const created of ['1.0', '-1', '01', 'unknown', '9'.repeat(129)]) {
    test(`invalid Linux ticks remain sticky: ${created.slice(0, 20)}`, async () => {
        let rows: ProcessRow[] = [
            { pid: 10, parent: 1, created, rssBytes: 1, creationClock: 'linux-start-ticks' },
        ];
        const sampler = new ProcessSampler([10], async () => rows);
        await assert.rejects(sampler.sample());
        rows = [];
        await assert.rejects(sampler.assertExited());
    });
}
for (const created of [
    'Di Okt 20 03:49:21 2026',
    'Mon Oct 20 03:49:21 2026',
    'Tue Feb 30 03:49:21 2026',
    'Tue Oct 20 03:49:21 PST 2026',
]) {
    test(`unsupported/ambiguous macOS lstart holds: ${created}`, async () => {
        await assert.rejects(
            new ProcessSampler([10], async () => [
                { pid: 10, parent: 1, created, rssBytes: 1, creationClock: 'macos-local-second' },
            ]).sample(),
        );
    });
}
test('unlabelled and mixed clock domains cannot establish initial or descendant authority', async () => {
    await assert.rejects(
        new ProcessSampler([10], async () => [{ ...root, creationClock: undefined }]).sample(),
        /clock/,
    );
    await assert.rejects(
        new ProcessSampler([10], async () => [
            root,
            { ...newer, created: '900', creationClock: 'linux-start-ticks' },
        ]).sample(),
        /clock/,
    );
});
test('backwards tracked PID generation is sticky clock uncertainty, not an exclusion witness', async () => {
    let rows = [root, newer];
    const sampler = new ProcessSampler([10], async () => rows);
    await sampler.sample();
    rows = [root, { ...newer, created: older.created }];
    await assert.rejects(sampler.sample(), /discontinuity/);
    rows = [];
    await assert.rejects(sampler.assertExited());
});
test('equal-birth cyclic PID graph stays bounded and conservatively owned', async () => {
    const sampler = new ProcessSampler([10], async () => [{ ...root, parent: 30 }, row(30, 10)]);
    assert.equal((await sampler.sample()).length, 2);
    await assert.rejects(sampler.assertExited(), /still running/);
    await assert.rejects(
        new ProcessSampler([10], async () => [{ ...root, parent: 10 }]).sample(),
        /self-parented/,
    );
});
for (const pid of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    test(`malformed relevant PID cannot authorize cleanup: ${pid}`, async () => {
        await assert.rejects(
            new ProcessSampler([10], async () => [root, { ...newer, pid }]).sample(),
            /PID/,
        );
    });
}
test('repeated stale exclusions retain only bounded table-bound edge facts, with no history accumulation', async () => {
    const rows = [root, ...Array.from({ length: 30 }, (_, n) => ({ ...older, pid: n + 100 }))];
    const sampler = new ProcessSampler([10], async () => rows);

    for (let n = 0; n < 300; n++) {
        assert.equal((await sampler.sample()).length, 1);
        const history = sampler.historyProof();
        assert.equal(history.unresolved, 1);
        assert.equal(history.ancestry.total, 30);
        assert.equal(history.ancestry.decisions.length, 8);
        assert.equal(history.ancestry.omitted, 22);
        assert.equal(history.ancestry.tableSequence, n + 1);
        assert.equal(history.ancestry.tableSHA256, history.tableSHA256);
        assert(
            history.ancestry.decisions.every(
                (r: any) =>
                    r.result === 'excluded-strictly-older' &&
                    r.childCreated === older.created &&
                    r.parentCreated === root.created,
            ),
        );
        const bytes = Buffer.byteLength(JSON.stringify(history));
        assert(bytes < 4096);
    }
});

for (const kind of [
    'absent',
    'reused',
    'tracked-intermediate-absent',
    'tracked-intermediate-reused',
    'unknown-time',
    'unknown-clock',
    'mixed-clock',
]) {
    test(`late-visible plausible descendant blocks closure: ${kind}`, async () => {
        const intermediate = row(20, 10, stamp('0000001'));
        let rows = kind.startsWith('tracked') ? [root, intermediate] : [root];
        const sampler = new ProcessSampler([10], async () => rows);
        await sampler.sample();
        const late = kind.startsWith('tracked')
            ? row(30, 20, stamp('0000002'))
            : row(20, 10, stamp('0000001'));
        rows = [
            kind === 'unknown-time'
                ? { ...late, created: '' }
                : kind === 'unknown-clock'
                  ? { ...late, creationClock: undefined }
                  : kind === 'mixed-clock'
                    ? { ...late, created: '100', creationClock: 'linux-start-ticks' as const }
                    : late,
        ];
        if (kind === 'reused') rows.unshift(row(10, 1, stamp('0000003')));
        if (kind === 'tracked-intermediate-reused') rows.unshift(row(20, 1, stamp('0000003')));
        await assert.rejects(sampler.assertExited(), /Unresolved ancestry|chronology|clock/);
        const proof = sampler.historyProof();
        assert(
            proof.ancestry.decisions.some(
                (d: any) => d.childPID === late.pid && d.parentPID === late.parent,
            ),
        );
        assert.equal(proof.retiredCount, 0);
        rows = [];
        await assert.rejects(sampler.assertExited());
    });
}
for (const current of ['absent', 'replacement']) {
    test(`provably older late candidate stays unrelated with parent ${current}`, async () => {
        let rows = [root];
        const sampler = new ProcessSampler([10], async () => rows);
        await sampler.sample();
        rows = current === 'absent' ? [older] : [row(10, 1, stamp('0000002')), older];
        await sampler.assertExited();
        assert.equal(sampler.historyProof().unresolved, 1);
        assert.equal(
            sampler.historyProof().ancestry.decisions[0].result,
            'excluded-strictly-older',
        );
    });
}
test('a late candidate between two known owned parent generations is not lost behind the current generation', async () => {
    const priorParent = row(20, 10, stamp('0000001'));
    let rows = [root, priorParent];
    const sampler = new ProcessSampler([10], async () => rows);
    await sampler.sample();
    rows = [root, row(20, 10, stamp('0000003'))];
    await sampler.sample();
    rows = [row(20, 1, stamp('0000003')), row(30, 20, stamp('0000002'))];
    await assert.rejects(sampler.assertExited(), /Unresolved ancestry/);
});
for (const difference of [0, 1]) {
    test(`unowned replacement boundary does not transfer root authority: ${difference}`, async () => {
        let rows = [root];
        const sampler = new ProcessSampler([10], async () => rows);
        await sampler.sample();
        rows = [
            row(10, 1, stamp('0000002')),
            row(20, 10, stamp(difference ? '0000003' : '0000002')),
        ];
        if (difference) {
            await sampler.assertExited();
            assert.equal(sampler.historyProof().unresolved, 1);
            assert.equal(
                sampler.historyProof().ancestry.decisions[0].result,
                'excluded-after-unowned-replacement',
            );
        } else await assert.rejects(sampler.assertExited(), /Unresolved ancestry/);
    });
}
test('late mixed multi-hop discovery retains genuine branch and excludes stale branch before missing-parent refusal', async () => {
    let rows = [root];
    const sampler = new ProcessSampler([10], async () => rows);
    await sampler.sample();
    rows = [
        row(41, 40, stamp('0000003')),
        row(31, 30, stamp('0000003')),
        row(40, 10, stamp('0000002')),
        { ...older, pid: 30 },
        root,
    ];
    const census = await sampler.sample();
    assert.deepEqual(
        census.map((r) => r.pid).sort((a, b) => a - b),
        [10, 40, 41],
    );
    rows = [row(50, 41, stamp('0000004'))];
    await assert.rejects(sampler.assertExited(), /Unresolved ancestry/);
});
for (const clock of ['linux-start-ticks', 'macos-local-second'] as const) {
    test(`missing owned parent stays conservative in ${clock}`, async () => {
        const birth =
            clock === 'linux-start-ticks' ? '9007199254740993000' : 'Tue Oct 20 03:49:21 2026';
        const later =
            clock === 'linux-start-ticks' ? '9007199254740993001' : 'Tue Oct 20 03:49:20 2026';
        let rows: ProcessRow[] = [
            { pid: 10, parent: 1, created: birth, rssBytes: 1, creationClock: clock },
        ];
        const sampler = new ProcessSampler([10], async () => rows);
        await sampler.sample();
        rows = [{ pid: 20, parent: 10, created: later, rssBytes: 1, creationClock: clock }];
        await assert.rejects(sampler.assertExited(), /Unresolved ancestry/);
    });
}
for (const kind of [
    'absent',
    'reused',
    'late-grandchild',
    'unknown-time-cancel',
    'unknown-clock-expiry',
]) {
    test(`shipped startup controller holds late ancestry through closure and ${kind}`, async (t) => {
        let rows = kind === 'late-grandchild' ? [root, row(20, 10, stamp('0000001'))] : [root];
        const abort = new AbortController();
        let handle: ReturnType<typeof setInterval> | undefined, held: any;
        const child: any = Object.assign(new EventEmitter(), {
            pid: 10,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        });
        const manager = new NativePilotStartup({
            signal: abort.signal,
            deadline: Number(process.hrtime.bigint() / 1000000n) + 100,
            readTable: async () => rows,
            emit: async () => {},
            hold: () => {
                manager.stopQueryAdmission();
                held ??= createOwnershipHold(
                    { releaseAuthorized: false },
                    () => {
                        throw Error('hold reporting failed');
                    },
                    {
                        interval: ((callback: () => void, ms: number) => {
                            handle = setInterval(callback, ms);
                            return handle;
                        }) as typeof setInterval,
                    },
                );
            },
        });
        t.after(() => {
            manager.stopQueryAdmission();
            if (handle) clearInterval(handle);
        });
        manager.adopt('ssh-runtime-build', child, () => {});
        await manager.children.get(child).identityTask;
        rows =
            kind === 'late-grandchild'
                ? [row(30, 20, stamp('0000002'))]
                : [
                      kind === 'unknown-time-cancel'
                          ? row(20, 10, '')
                          : kind === 'unknown-clock-expiry'
                            ? { ...row(20, 10), creationClock: undefined }
                            : row(20, 10, stamp('0000001')),
                  ];
        if (kind === 'reused') rows.unshift(row(10, 1, stamp('0000003')));
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        await assert.rejects(manager.join());
        assert(held && handle?.hasRef());
        rows = [];
        abort.abort(Error('normal cancellation'));
        if (kind === 'unknown-clock-expiry') await new Promise((r) => setTimeout(r, 110));
        await assert.rejects(manager.join());
        assert.match(held.snapshot().recordErrors[0], /reporting failed/);
        assert(handle?.hasRef());
    });
}

function permutations<T>(values: T[]): T[][] {
    return values.length
        ? values.flatMap((value, index) =>
              permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]),
          )
        : [[]];
}
function convergentFamily(domain: string) {
    const clock: ProcessRow['creationClock'] = domain.startsWith('macos')
        ? 'macos-local-second'
        : domain.startsWith('linux')
          ? 'linux-start-ticks'
          : 'windows-utc-100ns';
    const time = (n: number) =>
        clock === 'macos-local-second'
            ? `Tue Oct 20 03:49:2${n} 2026`
            : clock === 'linux-start-ticks'
              ? String(9007199254740993000n + BigInt(n))
              : stamp(String(n).padStart(7, '0'));
    const make = (pid: number, parent: number, n: number): ProcessRow => ({
        pid,
        parent,
        created: time(n),
        creationClock: clock,
        rssBytes: 1,
    });
    return {
        make,
        root: make(10, 1, 0),
        oldParent: make(20, 10, 1),
        parent: make(20, 10, 3),
        grandchild: make(30, 20, domain.endsWith('later') ? 4 : 3),
    };
}
for (const domain of [
    'windows-equal',
    'windows-later',
    'linux-equal',
    'macos-equal',
    'macos-later',
]) {
    for (const order of permutations([0, 1, 2])) {
        test(`reused owned family reaches the same fixed point: ${domain} ${order.join('')}`, async () => {
            const f = convergentFamily(domain);
            let rows = [f.root, f.oldParent];
            const sampler = new ProcessSampler([10], async () => rows);
            await sampler.sample();
            const family = [f.root, f.parent, f.grandchild];
            rows = order.map((i) => family[i]);
            const census = await sampler.sample();
            assert.equal(census.length, 4);
            assert.equal(census.find((r) => r.pid === 30)?.state, 'running');
            assert.equal(
                census.find((r) => r.pid === 20 && r.created === f.oldParent.created)?.state,
                'terminated',
            );
            assert.equal(
                census.find((r) => r.pid === 20 && r.created === f.parent.created)?.state,
                'running',
            );
            const decisions = sampler.historyProof().ancestry.decisions;
            assert(
                !decisions.some(
                    (d: any) =>
                        d.result.startsWith('unresolved') ||
                        d.result === 'excluded-after-unowned-replacement',
                ),
            );
            assert(
                decisions.some(
                    (d: any) =>
                        d.childPID === 30 &&
                        d.parentCreated === f.parent.created &&
                        d.result.startsWith('retained'),
                ),
            );
            rows = [{ ...f.grandchild, parent: 1 }];
            await assert.rejects(sampler.assertExited(), /still running/);
            rows = [];
            await sampler.assertExited();
        });
    }
}
for (const domain of ['windows-equal', 'linux-equal', 'macos-equal']) {
    for (const order of permutations([0, 1, 2, 3])) {
        test(`multiple reused intermediates converge without row-order authority: ${domain} ${order.join('')}`, async () => {
            const f = convergentFamily(domain),
                oldMiddle = f.make(30, 20, 2),
                middle = f.make(30, 20, 3),
                leaf = f.make(40, 30, 3);
            let rows = [f.root, f.oldParent, oldMiddle];
            const sampler = new ProcessSampler([10], async () => rows);
            await sampler.sample();
            const family = [f.root, f.parent, middle, leaf];
            rows = order.map((i) => family[i]);
            const census = await sampler.sample();
            assert.equal(census.length, 6);
            assert.equal(census.filter((r) => r.state === 'running').length, 4);
            assert.equal(census.find((r) => r.pid === 40)?.role, 'owned-descendant');
            rows = [{ ...leaf, parent: 1 }];
            await assert.rejects(sampler.assertExited(), /still running/);
            rows = [];
            await sampler.assertExited();
        });
    }
    test(`full-table convergence still latches a genuinely unresolved sibling: ${domain}`, async () => {
        const f = convergentFamily(domain),
            missing = f.make(50, 10, 1),
            uncertain = f.make(60, 50, 4);
        let rows = [f.root, f.oldParent, missing];
        const sampler = new ProcessSampler([10], async () => rows);
        await sampler.sample();
        rows = [uncertain, f.grandchild, f.parent, f.root];
        await assert.rejects(sampler.sample(), /Unresolved ancestry for process 60/);
        assert.equal(sampler.historyProof().unresolved, 5);
        assert(
            sampler
                .historyProof()
                .ancestry.decisions.some(
                    (d: any) => d.childPID === 30 && d.result.startsWith('retained'),
                ),
        );
        rows = [];
        await assert.rejects(sampler.assertExited(), /Unresolved ancestry for process 60/);
    });
}
for (const domain of [
    'windows-equal',
    'windows-later',
    'linux-equal',
    'macos-equal',
    'macos-later',
]) {
    for (const order of ['parent-first', 'grandchild-first'])
        for (const outcome of ['all-gone', 'genuine-survivor']) {
            test(`shipped periodic ownership and join are order-independent: ${domain} ${order} ${outcome}`, async (t) => {
                const f = convergentFamily(domain);
                let rows = [f.root, f.oldParent],
                    held = false,
                    reads = 0;
                let observed!: () => void;
                const periodic = new Promise<void>((r) => {
                    observed = r;
                });
                const child: any = Object.assign(new EventEmitter(), {
                    pid: 10,
                    stdout: new EventEmitter(),
                    stderr: new EventEmitter(),
                });
                const manager = new NativePilotStartup({
                    signal: new AbortController().signal,
                    deadline: Number(process.hrtime.bigint() / 1000000n) + 5000,
                    readTable: async () => {
                        if (++reads === 2) observed();
                        return rows;
                    },
                    emit: async () => {},
                    hold: () => {
                        held = true;
                        manager.stopQueryAdmission();
                    },
                });
                t.after(() => manager.stopQueryAdmission());
                manager.adopt('ssh-runtime-build', child, () => {});
                await manager.children.get(child).identityTask;
                rows =
                    order === 'parent-first'
                        ? [f.root, f.parent, f.grandchild]
                        : [f.grandchild, f.parent, f.root];
                await periodic;
                await new Promise<void>((r) => setImmediate(r));
                assert.equal(held, false);
                const sampler = manager.children.get(child).sampler as ProcessSampler;
                assert.equal(
                    sampler.observationFacts().tuples.find((r: any[]) => r[0] === 30)?.[3],
                    'running',
                );
                rows = outcome === 'all-gone' ? [] : [{ ...f.grandchild, parent: 1 }];
                child.emit('exit', 0, null);
                child.emit('close', 0, null);
                if (outcome === 'all-gone') {
                    assert.equal((await manager.join()).complete, true);
                    assert.equal(held, false);
                } else {
                    await assert.rejects(manager.join(), /still running/);
                    assert.equal(held, true);
                    rows = [];
                    await assert.rejects(manager.join());
                }
            });
        }
}

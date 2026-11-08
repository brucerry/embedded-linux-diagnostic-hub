/** Modeled schema2 records only: no product journal, PTY, ACK, browser or host resource is created. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bytesBase64, frameCrc } from '../shared/capture-store';
import {
    applyConsoleRecord,
    newConsoleCursor,
    type ConsoleHeader,
    type ConsoleRecord,
    type ConsoleSegment,
    type ConsoleSnapshot,
} from '../shared/console-journal';
import { sshInputBytes } from '../shared/ssh-console';
import type { ConsoleArchive, ConsoleRead } from '../shared/console-storage';
import {
    catalogConsoleArchive,
    consoleRawCrc,
    summarizeConsoleRead,
} from './fixtures/memory-product-console-read';
import {
    assertConsoleJournalSummary,
    assertLiveConsoleTarget,
    validateConsoleUiPlan,
    type ConsoleTargetSnapshot,
    type ConsoleUiPlan,
} from './fixtures/memory-product-console-ui';

const id = '12345678-1234-4123-8123-123456789abc',
    secondId = '22345678-1234-4123-8123-123456789abc';
const at = '2026-10-15T00:00:00.000Z',
    encoded = (value: string) => new TextEncoder().encode(value);
const limits = { maxCatalogRows: 10, maxMetadataRows: 100, maxTargetRequests: 20 };
const plan: ConsoleUiPlan = {
    shellPrompts: ['model# '],
    steps: [
        {
            name: 'Script',
            intent: 'script',
            command: ' cd /\npwd ',
            completion: { role: 'shell-prompt', literals: ['model# '] },
        },
        { name: 'Enter', intent: 'send-enter', command: '' },
    ],
};
function model() {
    const header: ConsoleHeader = {
        schema: 2,
        id,
        flowId: 'modeled-console-flow',
        startedAt: at,
        receiveTimeSource: 'gateway',
        target: { endpoint: 'model-only', username: 'model' },
        ready: { role: 'shell-prompt', literals: [...plan.shellPrompts] },
    };
    const cursor = newConsoleCursor(),
        records: ConsoleRecord[] = [],
        raw: Uint8Array[] = [],
        commandRaw: Uint8Array[] = [];
    const push = (input: object) => {
        const record = applyConsoleRecord(
            cursor,
            { schema: 2, sequence: records.length, ...input },
            header,
        );
        records.push(record);
        return record;
    };
    const context = (phase: 'startup' | 'idle' | 'shutdown') =>
        push({
            kind: 'segment-start',
            index: cursor.segments,
            at,
            segment: { kind: 'context', phase },
        });
    const observation = (bytes: Uint8Array, origin: 'channel' | 'extended' = 'channel') => {
        push({
            kind: 'observation',
            index: cursor.active!.index,
            observation: cursor.observations,
            stream: 'pty',
            origin,
            receivedAt: at,
            offset: 0,
            totalBytes: bytes.length,
            base64: bytesBase64(bytes),
            crc32: frameCrc(bytes),
        });
        raw.push(bytes);
    };
    const end = (reason: string, match: object | null = null) =>
        push({ kind: 'segment-end', index: cursor.active!.index, at, reason, match });
    context('startup');
    observation(encoded('banner\r\nmodel# '));
    const match = { role: 'shell-prompt', literal: 'model# ' };
    end('ready', match);
    const stepIds = ['model-step-a', 'model-step-b'];
    for (let index = 0; index < plan.steps.length; index++) {
        context('idle');
        const item = plan.steps[index],
            idle = cursor.active!.index,
            commandIndex = cursor.segments;
        const segment: ConsoleSegment = {
            kind: 'command',
            runId: 'model-iteration-run',
            stepId: stepIds[index],
            ordinal: index + 1,
            name: item.name,
            input: { intent: item.intent, command: item.command },
            requestBase64: bytesBase64(
                sshInputBytes('console', { intent: item.intent, command: item.command }),
            ),
            criterion: item.completion ?? header.ready,
        };
        const preparation = push({ kind: 'preparation', index: commandIndex, at, segment });
        push({
            kind: 'segment-start',
            index: commandIndex,
            at,
            segment,
            inputSent: {
                preparation: preparation.sequence,
                contextIndex: idle,
                disposition: 'write-dispatched',
            },
        });
        const output = index
            ? new Uint8Array([0, 255, 13, 10, ...encoded('model# ')])
            : encoded('/\r\nmodel# ');
        commandRaw.push(output);
        observation(output, index ? 'extended' : 'channel');
        end('prompt-observed', match);
        push({
            kind: 'outcome',
            index: commandIndex,
            at,
            completion: 'prompt-observed',
            exitCode: null,
            match,
        });
    }
    context('idle');
    observation(encoded('background'), 'extended');
    end('idle-boundary');
    context('shutdown');
    observation(encoded('bye'));
    end('closed');
    const capture: ConsoleSnapshot = {
        schema: 2,
        header,
        state: 'complete',
        offset: records.reduce(
            (sum, record) => sum + encoded(JSON.stringify(record) + '\n').length,
            0,
        ),
        records: cursor.records,
        bytes: cursor.bytes,
        observations: cursor.observations,
        segments: cursor.segments,
        finalizedAt: at,
        reason: 'complete',
        observedBytes: cursor.bytes,
        failure: null,
        shellClosed: true,
    };
    const all = new Uint8Array(raw.reduce((n, b) => n + b.length, 0));
    let offset = 0;
    for (const bytes of raw) {
        all.set(bytes, offset);
        offset += bytes.length;
    }
    const expected = {
        receiveTimeSource: 'gateway' as const,
        target: header.target,
        raw: { bytes: all.length, crc32: frameCrc(all) },
        commandRaw: commandRaw.map((b) => ({ bytes: b.length, crc32: frameCrc(b) })),
    };
    return { header, capture, records, expected, stepIds, all };
}
async function* events(
    m: ReturnType<typeof model>,
    done?: () => void,
): AsyncGenerator<ConsoleRead> {
    try {
        yield { kind: 'metadata', capture: m.capture };
        for (const record of m.records) yield { kind: 'record', record };
    } finally {
        done?.();
    }
}
test('one actual iteration run ID spans Script and Enter with distinct step provenance', async () => {
    const m = model(),
        summary = await summarizeConsoleRead(id, events(m), limits);
    const commands = summary.segments.filter((item) => item.segment.kind === 'command');
    assert.equal(
        new Set(commands.map((item) => item.segment.kind === 'command' && item.segment.runId)).size,
        1,
    );
    assert.equal(
        new Set(commands.map((item) => item.segment.kind === 'command' && item.segment.stepId))
            .size,
        2,
    );
    assert.deepEqual(
        commands.map((item) => item.segment.kind === 'command' && item.segment.ordinal),
        [1, 2],
    );
    const checked = assertConsoleJournalSummary(summary, { plan, stepIds: m.stepIds }, m.expected);
    assert.equal(checked.runId, 'model-iteration-run');
    assert.deepEqual(checked.intentOrder, ['script', 'send-enter']);
});

test('substituted per-step run ID fails even with matching dispatched preparation metadata', async () => {
    const m = model(),
        summary = await summarizeConsoleRead(id, events(m), limits);
    const second = summary.segments.filter((item) => item.segment.kind === 'command')[1];
    assert.equal(second.segment.kind, 'command');
    if (second.segment.kind !== 'command') throw Error('Expected modeled command.');
    second.segment.runId = 'substituted-iteration';
    const preparation = summary.preparations.find(
        (item) => item.record.sequence === second.inputSent!.preparation,
    )!;
    preparation.record.segment.runId = second.segment.runId;
    assert.throws(
        () => assertConsoleJournalSummary(summary, { plan, stepIds: m.stepIds }, m.expected),
        /one iteration run ID/,
    );
});
test('incremental raw CRC preserves arbitrary binary bytes across every partition', () => {
    const bytes = new Uint8Array([0, 1, 13, 10, 128, 255, ...encoded('Unicode \u4e2d')]);
    for (let width = 1; width <= bytes.length; width++) {
        const crc = consoleRawCrc();
        for (let index = 0; index < bytes.length; index += width)
            crc.add(bytes.subarray(index, index + width));
        assert.deepEqual(crc.summary(), { bytes: bytes.length, crc32: frameCrc(bytes) });
    }
});
test('incremental schema2 replay retains contexts and Script/Enter dispatch provenance without raw output arrays', async () => {
    const m = model(),
        summary = await summarizeConsoleRead(id, events(m), limits);
    const result = assertConsoleJournalSummary(summary, { plan, stepIds: m.stepIds }, m.expected);
    assert.deepEqual(result.intentOrder, ['script', 'send-enter']);
    assert.equal(result.processExitStatus, 'unavailable');
    assert.equal(summary.raw.stream, 'pty');
    assert.equal(summary.raw.bytes, m.all.length);
    assert.ok(summary.segments.some((s) => s.endedBy?.kind === 'input-sent-boundary'));
    assert.equal(Object.hasOwn(summary, 'records'), false);
    assert.equal(Object.hasOwn(summary, 'rawBytes'), false);
});
test('corrupted CRC/raw bytes and reordered sequence reject and naturally return the input iterator', async () => {
    for (const mutate of [
        (m: ReturnType<typeof model>) => {
            (m.records.find((r) => r.kind === 'observation') as any).crc32 = '00000000';
        },
        (m: ReturnType<typeof model>) => {
            (m.records[0] as any).sequence = 99;
        },
        (m: ReturnType<typeof model>) => {
            (m.records.find((r) => r.kind === 'observation') as any).base64 = 'AA==';
        },
    ]) {
        const m = model();
        mutate(m);
        let returned = false;
        await assert.rejects(
            summarizeConsoleRead(
                id,
                events(m, () => {
                    returned = true;
                }),
                limits,
            ),
        );
        assert.equal(returned, true);
    }
});
test('wrong identity, independent capture schema and duplicate metadata cannot be retagged as console', async () => {
    const m = model();
    m.capture.header.id = secondId;
    await assert.rejects(summarizeConsoleRead(id, events(m), limits), /identity/);
    const other = model();
    (other.capture as any).schema = 1;
    await assert.rejects(summarizeConsoleRead(id, events(other), limits));
    const duplicate = model();
    async function* repeated(): AsyncGenerator<ConsoleRead> {
        yield { kind: 'metadata', capture: duplicate.capture };
        yield { kind: 'metadata', capture: duplicate.capture };
    }
    await assert.rejects(summarizeConsoleRead(id, repeated(), limits), /Duplicate/);
});
test('offset/counter mismatch and invented process exit fail instead of publishing a complete summary', async () => {
    for (const mutate of [
        (m: ReturnType<typeof model>) => {
            m.capture.offset++;
        },
        (m: ReturnType<typeof model>) => {
            m.capture.records++;
        },
        (m: ReturnType<typeof model>) => {
            (m.records.find((r) => r.kind === 'outcome') as any).exitCode = 0;
        },
    ]) {
        const m = model();
        mutate(m);
        await assert.rejects(summarizeConsoleRead(id, events(m), limits));
    }
});
test('explicit metadata budget refuses growth without clipping and returns the source iterator', async () => {
    let returned = false;
    await assert.rejects(
        summarizeConsoleRead(
            id,
            events(model(), () => {
                returned = true;
            }),
            { maxMetadataRows: 1 },
        ),
        /nothing was clipped/,
    );
    assert.equal(returned, true);
});
test('console provenance guard rejects substituted step/input/criterion, missing inputSent and fabricated outcome', async () => {
    const m = model(),
        original = await summarizeConsoleRead(id, events(m), limits);
    for (const mutate of [
        (s: any) => {
            s.segments.find((v: any) => v.segment.kind === 'command').segment.stepId = 'different';
        },
        (s: any) => {
            s.segments.find((v: any) => v.segment.kind === 'command').inputSent = null;
        },
        (s: any) => {
            s.segments.find((v: any) => v.segment.kind === 'command').segment.requestBase64 =
                bytesBase64(encoded('different\r'));
        },
        (s: any) => {
            s.segments.find((v: any) => v.segment.kind === 'command').outcome.exitCode = 0;
        },
        (s: any) => {
            s.segments.find((v: any) => v.segment.kind === 'command').segment.criterion.literals = [
                'wrong# ',
            ];
        },
    ]) {
        const changed = structuredClone(original);
        mutate(changed);
        assert.throws(() =>
            assertConsoleJournalSummary(changed, { plan, stepIds: m.stepIds }, m.expected),
        );
    }
});
test('self-consistent journal bytes cannot substitute an independently expected PTY payload', async () => {
    const m = model(),
        summary = await summarizeConsoleRead(id, events(m), limits);
    assert.throws(
        () =>
            assertConsoleJournalSummary(
                summary,
                { plan, stepIds: m.stepIds },
                { ...m.expected, raw: { ...m.expected.raw, crc32: '00000000' } },
            ),
        /independent/,
    );
});
test('catalog consumes real25-row UUID cursor protocol and rejects duplicates/nonadvancing/budget overflow', async () => {
    const one = model().capture,
        two = structuredClone(one);
    two.header.id = secondId;
    const source = {
        async list(after?: string, count?: number) {
            assert.equal(count, 25);
            return after
                ? { captures: [two], next: null, mode: 'indexed' }
                : { captures: [one], next: id, mode: 'indexed' };
        },
    } as unknown as ConsoleArchive;
    assert.deepEqual(
        (await catalogConsoleArchive(source, 2)).captures.map((c) => c.header.id),
        [id, secondId],
    );
    await assert.rejects(catalogConsoleArchive(source, 1), /no rows clipped/);
    const duplicated = {
        async list() {
            return { captures: [one, one], next: null, mode: 'scan' };
        },
    } as unknown as ConsoleArchive;
    await assert.rejects(catalogConsoleArchive(duplicated, 3), /duplicated/);
    const stuck = {
        async list() {
            return { captures: [], next: id, mode: 'scan' };
        },
    } as unknown as ConsoleArchive;
    await assert.rejects(catalogConsoleArchive(stuck, 3), /advance/);
});
test('console plan rejects blank Script, nonempty Send Enter and absent mixed intents before UI changes', () => {
    assert.doesNotThrow(() => validateConsoleUiPlan(plan));
    for (const steps of [
        [{ ...plan.steps[0], command: ' ' }, plan.steps[1]],
        [plan.steps[0], { ...plan.steps[1], command: 'not enter' }],
        [plan.steps[0], plan.steps[0]],
    ])
        assert.throws(() => validateConsoleUiPlan({ ...plan, steps }));
});
function target(): ConsoleTargetSnapshot {
    return {
        source: 'gateway-control',
        connectionIdentity: 'modeled-connection',
        owners: { status: 'supported', value: { ownerIds: ['owner-A'], ptyIds: ['pty-A'] } },
        shells: { status: 'supported', value: { opened: 2, closed: 0 } },
        requests: {
            status: 'supported',
            value: [{ sequence: 0, ownerId: 'owner-A', base64: 'YQ0=' }],
        },
        acknowledgements: {
            status: 'supported',
            value: { count: 3, orderedTraceSHA256: 'a'.repeat(64), pendingIds: ['ack-A'] },
        },
    };
}
test('live control snapshot compares exact PTY/owner/input/ACK identities rather than equal counts', () => {
    assert.equal(
        assertLiveConsoleTarget(target(), structuredClone(target()), limits).checked.length,
        4,
    );
    for (const mutate of [
        (s: any) => {
            s.owners.value.ptyIds = ['pty-B'];
        },
        (s: any) => {
            s.requests.value[0].base64 = 'Yg0=';
        },
        (s: any) => {
            s.acknowledgements.value.pendingIds = ['ack-B'];
        },
        (s: any) => {
            s.connectionIdentity = 'different';
        },
    ]) {
        const changed = target();
        mutate(changed);
        assert.throws(() => assertLiveConsoleTarget(target(), changed, limits));
    }
});
test('missing control evidence remains explicit unsupported and never becomes zero-owned PTY/ACK proof', () => {
    const unknown = target(),
        unsupported = {
            status: 'unsupported' as const,
            reason: 'Actual probe absent in this pure model.',
        };
    unknown.owners = unsupported;
    unknown.shells = unsupported;
    unknown.requests = unsupported;
    unknown.acknowledgements = unsupported;
    const result = assertLiveConsoleTarget(unknown, structuredClone(unknown), limits);
    assert.deepEqual(result.checked, []);
    assert.equal(result.unsupported.length, 4);
});

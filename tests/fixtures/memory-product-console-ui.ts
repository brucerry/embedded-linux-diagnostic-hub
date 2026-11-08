/** Actual persistent SSH console UI only; never creates/retags journal rows or opens a target. */
import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';
import { base64Bytes, bytesBase64 } from '../../shared/capture-store';
import { consoleSnapshot } from '../../shared/console-storage';
import {
    consoleReady,
    consoleStep,
    sshInputBytes,
    type ConsoleCompletion,
} from '../../shared/ssh-console';
import type { ConsoleSnapshot } from '../../shared/console-journal';
import {
    consoleRawCrc,
    type ConsoleCatalogSummary,
    type ConsoleJournalSummary,
    type ConsoleReadLimits,
} from './memory-product-console-read';

type Unsupported = { status: 'unsupported'; reason: string };
type Observed<T> = { status: 'supported'; value: T } | Unsupported;
export interface ConsoleTargetSnapshot {
    source: 'gateway-control' | 'native-main';
    connectionIdentity: string;
    /** Actual automation-console role only; do not count the separate Terminal shell as this owner. */
    owners: Observed<{ ownerIds: readonly string[]; ptyIds: readonly string[] }>;
    shells: Observed<{ opened: number; closed: number }>;
    /** Actual ordered PTY input chunks/dispatch events; transport chunk boundaries are not command boundaries. */
    requests: Observed<readonly { sequence: number; ownerId: string; base64: string }[]>;
    acknowledgements: Observed<{
        count: number;
        orderedTraceSHA256: string;
        pendingIds: readonly string[];
    }>;
}
export interface ConsoleProductHooks {
    /** Real schema2 archive only. Each hook must await its separately opened view's disposal. */
    consoleCatalog(): Promise<ConsoleCatalogSummary>;
    readConsoleSummary(id: string, limits: ConsoleReadLimits): Promise<ConsoleJournalSummary>;
    runnerState(): Promise<{ busy: boolean; cleanupPending: boolean }>;
    targetSnapshot?(): Promise<ConsoleTargetSnapshot>;
}
export interface ConsoleUiPlan {
    shellPrompts: readonly string[];
    steps: readonly {
        name: string;
        intent: 'script' | 'send-enter';
        command: string;
        completion?: ConsoleCompletion;
    }[];
}
export interface ConsoleUiLimits extends ConsoleReadLimits {
    maxCatalogRows: number;
    maxTargetRequests: number;
}
export interface ConsoleExpectedRaw {
    bytes: number;
    crc32: string;
}
export interface ConsoleExpectedFlow {
    receiveTimeSource: 'gateway' | 'local-client';
    target: ConsoleSnapshot['header']['target'];
    /** Independently known target-emitted PTY bytes, including startup/context, not copied from this journal. */
    raw: ConsoleExpectedRaw;
    commandRaw: readonly ConsoleExpectedRaw[];
}
export interface ConsoleStartedRun {
    catalogBefore: ConsoleCatalogSummary;
    targetBefore: ConsoleTargetSnapshot | null;
    stepIds: readonly string[];
    plan: ConsoleUiPlan;
}
function safe(value: number) {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
}
function fixtureLimits(value: ConsoleUiLimits) {
    for (const key of ['maxCatalogRows', 'maxMetadataRows', 'maxTargetRequests'] as const)
        assert.ok(
            Number.isSafeInteger(value[key]) && value[key] > 0,
            'Supply an explicit positive semantic fixture bound: ' + key,
        );
}
function exactIds(actual: readonly string[], expected: readonly string[]) {
    for (const id of [...actual, ...expected]) assert.ok(typeof id === 'string' && id.length > 0);
    assert.equal(new Set(actual).size, actual.length);
    assert.deepEqual([...actual].sort(), [...expected].sort());
}
function raw(actual: ConsoleExpectedRaw, expected: ConsoleExpectedRaw) {
    safe(actual.bytes);
    safe(expected.bytes);
    assert.match(actual.crc32, /^[a-f0-9]{8}$/);
    assert.match(expected.crc32, /^[a-f0-9]{8}$/);
    assert.deepEqual(
        actual,
        expected,
        'Actual ordered PTY bytes/CRC differ from independent target expectation.',
    );
}
export function validateConsoleUiPlan(plan: ConsoleUiPlan) {
    const ready = consoleReady({ role: 'shell-prompt', literals: [...plan.shellPrompts] });
    assert.ok(
        plan.steps.length >= 2 && plan.steps.length <= 20,
        'Use actual Script and Send Enter steps within the existing UI20-step limit.',
    );
    assert.ok(
        plan.steps.some((s) => s.intent === 'script') &&
            plan.steps.some((s) => s.intent === 'send-enter'),
    );
    for (const step of plan.steps) {
        assert.ok(step.name.length > 0 && step.name.length <= 120);
        consoleStep(
            {
                intent: step.intent,
                command: step.command,
                ...(step.completion ? { completion: step.completion } : {}),
            },
            ready,
        );
    }
    return ready;
}
function catalog(value: ConsoleCatalogSummary, limits: ConsoleUiLimits) {
    fixtureLimits(limits);
    assert.equal(value.schema, 2);
    assert.equal(value.mode, 'console');
    assert.ok(value.captures.length <= limits.maxCatalogRows);
    const ids = value.captures.map((c) => consoleSnapshot(c).header.id);
    exactIds(ids, [...new Set(ids)]);
    assert.ok(
        value.pages.length > 0 &&
            value.pages.every(
                (p) =>
                    Number.isSafeInteger(p.rows) &&
                    p.rows >= 0 &&
                    p.rows <= 25 &&
                    ['scan', 'indexed'].includes(p.mode),
            ),
    );
    assert.equal(
        value.pages.reduce((n, p) => n + p.rows, 0),
        ids.length,
    );
    return ids;
}
function target(value: ConsoleTargetSnapshot, limits: ConsoleUiLimits) {
    fixtureLimits(limits);
    assert.ok(['gateway-control', 'native-main'].includes(value.source));
    assert.ok(value.connectionIdentity.length > 0);
    for (const field of ['owners', 'shells', 'requests', 'acknowledgements'] as const)
        if (value[field].status === 'unsupported')
            assert.ok((value[field] as Unsupported).reason.length > 0);
        else assert.equal(value[field].status, 'supported');
    if (value.owners.status === 'supported') {
        exactIds(value.owners.value.ownerIds, [...new Set(value.owners.value.ownerIds)]);
        exactIds(value.owners.value.ptyIds, [...new Set(value.owners.value.ptyIds)]);
    }
    if (value.shells.status === 'supported') {
        safe(value.shells.value.opened);
        safe(value.shells.value.closed);
    }
    if (value.requests.status === 'supported') {
        assert.ok(value.requests.value.length <= limits.maxTargetRequests);
        let previous = -1;
        for (const event of value.requests.value) {
            safe(event.sequence);
            assert.ok(event.sequence > previous && event.ownerId.length > 0);
            assert.ok(base64Bytes(event.base64).length > 0);
            previous = event.sequence;
        }
    }
    if (value.acknowledgements.status === 'supported') {
        safe(value.acknowledgements.value.count);
        assert.match(value.acknowledgements.value.orderedTraceSHA256, /^[a-f0-9]{64}$/);
        exactIds(value.acknowledgements.value.pendingIds, [
            ...new Set(value.acknowledgements.value.pendingIds),
        ]);
    }
}
export function assertLiveConsoleTarget(
    before: ConsoleTargetSnapshot,
    after: ConsoleTargetSnapshot,
    limits: ConsoleUiLimits,
) {
    target(before, limits);
    target(after, limits);
    assert.equal(after.source, before.source);
    assert.equal(after.connectionIdentity, before.connectionIdentity);
    const checked: string[] = [],
        unsupported: string[] = [];
    for (const key of ['owners', 'shells', 'requests', 'acknowledgements'] as const) {
        if (before[key].status === 'supported' && after[key].status === 'supported') {
            assert.deepEqual(
                after[key],
                before[key],
                'Actual live console evidence changed during view-only actions: ' + key,
            );
            checked.push(key);
        } else unsupported.push(key);
    }
    if (before.owners.status === 'supported') {
        assert.equal(
            before.owners.value.ownerIds.length,
            1,
            'Need exactly one actual owned automation console.',
        );
        assert.equal(
            before.owners.value.ptyIds.length,
            1,
            'Need exactly one actual automation PTY identity.',
        );
    }
    return {
        checked,
        unsupported,
        scope: 'actual supplied target trace only; no generated PTY/ACK ownership counts',
    };
}
export function assertConsoleJournalSummary(
    summary: ConsoleJournalSummary,
    started: Pick<ConsoleStartedRun, 'plan' | 'stepIds'>,
    expected: ConsoleExpectedFlow,
) {
    validateConsoleUiPlan(started.plan);
    assert.equal(summary.schema, 2);
    assert.equal(summary.mode, 'console');
    const capture = consoleSnapshot(summary.capture);
    assert.equal(capture.state, 'complete');
    assert.equal(capture.shellClosed, true);
    assert.equal(capture.header.receiveTimeSource, expected.receiveTimeSource);
    assert.deepEqual(capture.header.target, expected.target);
    assert.deepEqual(
        capture.header.ready,
        consoleReady({ role: 'shell-prompt', literals: [...started.plan.shellPrompts] }),
    );
    assert.equal(summary.replay.verified, true);
    assert.equal(summary.replay.complete, true);
    for (const key of ['records', 'offset', 'observations', 'segments'] as const)
        assert.equal(summary.replay[key], capture[key]);
    assert.equal(summary.raw.stream, 'pty');
    raw({ bytes: summary.raw.bytes, crc32: summary.raw.crc32 }, expected.raw);
    assert.equal(summary.raw.bytes, capture.bytes);
    assert.equal(
        summary.raw.origins.channel.bytes + summary.raw.origins.extended.bytes,
        capture.bytes,
    );
    assert.equal(
        summary.segments.reduce((n, s) => n + s.raw.bytes, 0),
        capture.bytes,
    );
    const commands = summary.segments.filter((s) => s.segment.kind === 'command');
    assert.equal(commands.length, started.plan.steps.length);
    assert.equal(started.stepIds.length, commands.length);
    assert.equal(expected.commandRaw.length, commands.length);
    assert.equal(
        summary.preparations.length,
        commands.length,
        'Unsent/discarded preparation cannot stand in for command dispatch.',
    );
    const runIds: string[] = [];
    for (let index = 0; index < commands.length; index++) {
        const actual = commands[index],
            expectedStep = started.plan.steps[index],
            segment = actual.segment;
        assert.equal(segment.kind, 'command');
        if (segment.kind !== 'command') throw Error('Expected actual command segment.');
        const frozen = consoleStep(
            {
                intent: expectedStep.intent,
                command: expectedStep.command,
                ...(expectedStep.completion ? { completion: expectedStep.completion } : {}),
            },
            capture.header.ready,
        );
        assert.equal(segment.ordinal, index + 1);
        assert.equal(segment.stepId, started.stepIds[index]);
        assert.equal(segment.name, expectedStep.name);
        assert.deepEqual(segment.input, { intent: frozen.intent, command: frozen.command });
        assert.equal(segment.requestBase64, bytesBase64(sshInputBytes('console', segment.input)));
        assert.deepEqual(segment.criterion, frozen.completion);
        runIds.push(segment.runId);
        assert.ok(actual.inputSent && actual.inputSent.disposition === 'write-dispatched');
        const preparation = summary.preparations.find(
            (p) => p.record.sequence === actual.inputSent!.preparation,
        );
        assert.ok(preparation && !preparation.discarded);
        assert.equal(preparation.record.index, actual.index);
        assert.deepEqual(preparation.record.segment, segment);
        assert.ok(actual.endedBy?.kind === 'segment-end');
        if (actual.endedBy?.kind !== 'segment-end') throw Error('Actual command seal missing.');
        assert.equal(actual.endedBy.reason, 'prompt-observed');
        assert.ok(actual.outcome);
        assert.equal(actual.outcome.completion, 'prompt-observed');
        assert.equal(
            actual.outcome.exitCode,
            null,
            'PTY prompt does not establish process exit status.',
        );
        assert.deepEqual(actual.outcome.match, actual.endedBy.match);
        assert.ok(
            actual.outcome.match &&
                actual.outcome.match.role === segment.criterion.role &&
                segment.criterion.literals.includes(actual.outcome.match.literal),
        );
        raw(actual.raw, expected.commandRaw[index]);
    }
    assert.ok(runIds.every((id) => typeof id === 'string' && id.length > 0));
    assert.equal(
        new Set(runIds).size,
        1,
        'Console Run once requires one iteration run ID across all steps.',
    );
    exactIds(started.stepIds, [...new Set(started.stepIds)]);
    return {
        id: capture.header.id,
        flowId: capture.header.flowId,
        runId: runIds[0],
        commands: commands.length,
        intentOrder: commands.map((c) =>
            c.segment.kind === 'command' ? c.segment.input.intent : null,
        ),
        bytes: capture.bytes,
        crc32: summary.raw.crc32,
        processExitStatus: 'unavailable' as const,
        schema: 2,
        mode: 'console',
        provenance: 'preparation plus actual inputSent/write-dispatched boundaries',
    };
}

const flow = (page: Page) => page.getByRole('region', { name: 'Automation', exact: true });
const stage = (page: Page, name: string) =>
    flow(page)
        .getByRole('navigation', { name: 'Automation setup steps' })
        .getByRole('button', { name: new RegExp(name) })
        .click();
export async function startProductConsoleUi(
    page: Page,
    plan: ConsoleUiPlan,
    hooks: ConsoleProductHooks,
    limits: ConsoleUiLimits,
): Promise<ConsoleStartedRun> {
    validateConsoleUiPlan(plan);
    fixtureLimits(limits);
    const state = await hooks.runnerState();
    assert.equal(state.busy, false);
    assert.equal(state.cleanupPending, false);
    const catalogBefore = await hooks.consoleCatalog();
    catalog(catalogBefore, limits);
    const targetBefore = hooks.targetSnapshot ? await hooks.targetSnapshot() : null;
    if (targetBefore) target(targetBefore, limits);
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await stage(page, 'Connection');
    await flow(page).getByLabel('Automation transport', { exact: true }).selectOption('ssh');
    await flow(page).getByLabel('SSH execution mode', { exact: true }).selectOption('console');
    await flow(page)
        .getByLabel('SSH shell prompt alternatives', { exact: true })
        .fill(plan.shellPrompts.join('\n'));
    await expect(
        flow(page).getByRole('heading', { name: 'Stored SSH console results', exact: true }),
    ).toBeVisible();
    await stage(page, 'Commands');
    const rows = flow(page).locator('.automation-steps > li');
    while ((await rows.count()) > 1)
        await rows.last().getByRole('button', { name: 'Remove', exact: true }).click();
    for (let index = 0; index < plan.steps.length; index++) {
        if (index)
            await flow(page).getByRole('button', { name: 'Add command', exact: true }).click();
        const step = plan.steps[index],
            prefix = 'Command ' + (index + 1);
        await rows
            .nth(index)
            .locator('.automation-step-heading label input[type=checkbox]')
            .check();
        await flow(page)
            .getByLabel('Step ' + (index + 1) + ' name (optional)', { exact: true })
            .fill(step.name);
        await flow(page)
            .getByLabel(prefix + ' SSH input', { exact: true })
            .selectOption(step.intent);
        const script = flow(page).getByLabel(prefix + ' script', { exact: true });
        if (step.intent === 'script') await script.fill(step.command);
        else {
            await expect(script).toBeDisabled();
            await expect(script).toHaveValue('');
        }
        await flow(page)
            .getByLabel(prefix + ' override completion', { exact: true })
            .setChecked(Boolean(step.completion));
        if (step.completion) {
            await flow(page)
                .getByLabel(prefix + ' completion role', { exact: true })
                .selectOption(step.completion.role);
            await flow(page)
                .getByLabel(prefix + ' completion alternatives', { exact: true })
                .fill(step.completion.literals.join('\n'));
        }
    }
    const stepIds = await rows.evaluateAll((elements) =>
        elements.map((e) => e.getAttribute('data-step-id')!),
    );
    assert.ok(stepIds.every(Boolean));
    exactIds(stepIds, [...new Set(stepIds)]);
    await stage(page, 'Timing');
    await expect(flow(page).getByLabel('Capture device time', { exact: true })).toHaveCount(0);
    await stage(page, 'Review');
    await expect(flow(page)).toContainText('One owned shell spans every step and repeat.');
    await flow(page).getByRole('button', { name: 'Run once', exact: true }).click();
    return { catalogBefore, targetBefore, stepIds, plan: structuredClone(plan) };
}

/** Caller has already stalled the genuine target; caller alone releases it after this function. */
export async function exerciseLiveProductConsole(
    page: Page,
    hooks: ConsoleProductHooks,
    limits: ConsoleUiLimits,
) {
    const before = await hooks.runnerState();
    assert.equal(before.busy, true);
    assert.equal(before.cleanupPending, false);
    const targetBefore = hooks.targetSnapshot ? await hooks.targetSnapshot() : null;
    await flow(page).getByRole('button', { name: 'Show flow', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Automation flow', exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.flow-kind')).toHaveText('Active snapshot');
    await expect(viewer).toContainText('combined PTY');
    await expect(viewer).toContainText('process exit status is unavailable');
    const activeIdentity = await viewer.locator('.flow-identity').innerText();
    assert.notEqual(activeIdentity, 'next-run draft');
    await viewer.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(viewer).toBeHidden();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await page.getByRole('button', { name: 'Automation', exact: true }).click();
    await expect(flow(page).getByLabel('SSH execution mode', { exact: true })).toHaveValue(
        'console',
    );
    const after = await hooks.runnerState();
    assert.deepEqual(after, before, 'Actual run did not remain live through view-only navigation.');
    const targetAfter = hooks.targetSnapshot ? await hooks.targetSnapshot() : null;
    const evidence =
        targetBefore && targetAfter
            ? assertLiveConsoleTarget(targetBefore, targetAfter, limits)
            : {
                  checked: [],
                  unsupported: ['actual PTY/owner/request/ACK trace; target snapshot hook absent'],
              };
    return {
        coverage: ['console-live-viewer-navigation'],
        activeIdentity,
        before,
        after,
        targetBefore,
        targetAfter,
        evidence,
        targetRelease: 'caller-owned; no target release or direct console input from this helper',
    };
}

/** Caller joins the real run first, then this function checks the real durable console journal. */
export async function finishProductConsoleUi(
    page: Page,
    started: ConsoleStartedRun,
    hooks: ConsoleProductHooks,
    limits: ConsoleUiLimits,
    expected: ConsoleExpectedFlow,
) {
    const state = await hooks.runnerState();
    assert.equal(state.busy, false);
    assert.equal(state.cleanupPending, false);
    await expect(flow(page).locator('.automation-state')).toContainText('Flow finished');
    const after = await hooks.consoleCatalog(),
        beforeIds = catalog(started.catalogBefore, limits),
        afterIds = catalog(after, limits);
    for (const old of started.catalogBefore.captures)
        assert.deepEqual(
            after.captures.find((c) => c.header.id === old.header.id),
            old,
        );
    const newIds = afterIds.filter((id) => !beforeIds.includes(id));
    assert.equal(
        newIds.length,
        1,
        'Expected one actual persistent console journal across all steps.',
    );
    const summary = await hooks.readConsoleSummary(newIds[0], {
        maxMetadataRows: limits.maxMetadataRows,
    });
    assert.equal(summary.capture.header.id, newIds[0]);
    const journal = assertConsoleJournalSummary(summary, started, expected);
    const targetAfter = hooks.targetSnapshot ? await hooks.targetSnapshot() : null;
    const targetEvidence: { checked: string[]; unsupported: string[] } = {
        checked: [],
        unsupported: [],
    };
    if (started.targetBefore && targetAfter) {
        const before = started.targetBefore;
        target(before, limits);
        target(targetAfter, limits);
        assert.equal(targetAfter.source, before.source);
        assert.equal(targetAfter.connectionIdentity, before.connectionIdentity);
        if (before.owners.status === 'supported' && targetAfter.owners.status === 'supported') {
            assert.deepEqual(targetAfter.owners, before.owners);
            targetEvidence.checked.push('actual owner/PTY identities returned to baseline');
        } else targetEvidence.unsupported.push('actual owner/PTY identities');
        if (before.shells.status === 'supported' && targetAfter.shells.status === 'supported') {
            assert.equal(targetAfter.shells.value.opened - before.shells.value.opened, 1);
            assert.equal(targetAfter.shells.value.closed - before.shells.value.closed, 1);
            targetEvidence.checked.push('actual one-shell open/close deltas');
        } else targetEvidence.unsupported.push('actual shell lifecycle');
        if (before.requests.status === 'supported' && targetAfter.requests.status === 'supported') {
            assert.deepEqual(
                targetAfter.requests.value.slice(0, before.requests.value.length),
                before.requests.value,
            );
            const writes = targetAfter.requests.value.slice(before.requests.value.length);
            assert.ok(writes.length > 0);
            assert.equal(new Set(writes.map((w) => w.ownerId)).size, 1);
            const actualInput = consoleRawCrc(),
                expectedInput = consoleRawCrc();
            for (const write of writes) actualInput.add(base64Bytes(write.base64));
            for (const step of started.plan.steps)
                expectedInput.add(
                    sshInputBytes('console', { intent: step.intent, command: step.command }),
                );
            raw(actualInput.summary(), expectedInput.summary());
            targetEvidence.checked.push(
                'actual exact Script/Enter write order on one supplied console owner',
            );
        } else targetEvidence.unsupported.push('actual PTY input trace');
        targetEvidence.unsupported.push(
            'final data ACK completeness and OS/process/native ownership require primary probes',
        );
    } else targetEvidence.unsupported.push('actual target/control/main snapshot unavailable');
    return {
        coverage: [
            'console-script-send-enter-provenance',
            'console-journal-incremental-raw-crc',
            'console-null-exit-outcomes',
        ],
        journal,
        summary,
        targetAfter,
        targetEvidence,
        resultsUi:
            'actual console mode selected; journal presence verified through its distinct real archive hook',
        ownership:
            'unassessed; journal shellClosed is durable evidence, not a substitute for actual PTY/ACK/native owner probes',
    };
}

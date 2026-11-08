import { assertCallbackSource } from './fixtures/source-bound-callbacks';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
    bindPage,
    boundSpan,
    activityReleaseSpan,
    cancelLabelExpression,
    type PageContext,
} from './fixtures/automation-page-arm-callbacks';
import { bindPageRunnerChanged } from './fixtures/automation-page-runner-change';
import { bindHeader, clockSpans } from './fixtures/header-clock-callbacks';
import {
    FlowRunner,
    type FlowBackend,
    type FlowState,
    type RunClock,
} from '../src/features/automation/runner';
import type { AutomationPlan } from '../shared/automation';

const pageText = readFileSync('src/features/automation/AutomationPage.tsx', 'utf8');
assertCallbackSource('src/features/automation/AutomationPage.tsx', pageText);
assert.ok(pageText.includes(boundSpan) && pageText.includes(activityReleaseSpan));
const hookText = readFileSync('src/hooks/useDeviceClock.ts', 'utf8');
assertCallbackSource('src/hooks/useDeviceClock.ts', hookText);
assert.ok(hookText.includes(clockSpans[2]));
// Evaluate only the actual source's bounded label expression; no JSX, DOM or React import.
const labelExpression = cancelLabelExpression;
assert.ok(pageText.includes('{' + labelExpression + '}'));
const label = new Function(
    'state',
    'arming',
    'runner',
    'activityFailure',
    'return (' + labelExpression + ');',
);
async function until(check: () => boolean) {
    for (let n = 0; n < 256; n++) {
        if (check()) return;
        await Promise.resolve();
    }
    assert.fail('Bounded Promise turns exhausted.');
}
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

for (const replacementReleaseFails of [false, true])
    test(
        'older Serial release failure cannot steal replacement cancellation; replacement release fails=' +
            replacementReleaseFails,
        async () => {
            const reservation = { current: null as symbol | null };
            let headerState: any = { status: 'unavailable', sample: null };
            const header = bindHeader({
                generation: 1,
                transport: {},
                reset: 0,
                blocked: false,
                visible: true,
                retained: { current: { sample: null } },
                flight: { current: null },
                queued: { current: null },
                refresh: { current: null },
                observed: { current: { uptime: null } },
                document: { visibilityState: 'visible' },
                reservation,
                setState: (value: any) => {
                    headerState = typeof value === 'function' ? value(headerState) : value;
                },
                setInterval: () => 1,
                clearInterval: (id: number) => {
                    assert.equal(id, 1);
                },
            });
            const oldReply = gate(),
                oldRetry = gate(),
                replacementGrant = gate(),
                replacementClose = gate();
            const leaseA = 'serial-overlap-owner-A-0001',
                leaseB = 'serial-overlap-owner-B-0002';
            const liveLeases = new Set<string>(),
                releases: string[] = [];
            let acquires = 0,
                prepares = 0,
                executions = 0,
                finishes = 0,
                replacementReleaseCalls = 0;
            const ui: {
                running: boolean;
                error: string;
                activityFailure: string;
                state: FlowState;
                inspection: any;
                busy: boolean[];
            } = {
                running: false,
                error: '',
                activityFailure: '',
                state: { state: 'idle', message: 'Ready' },
                inspection: null,
                busy: [],
            };
            const clock: RunClock = {
                local: () => Date.UTC(2028, 1, 29),
                mono: () => 0,
                watch: () => () => {},
                sleep: async () => {
                    throw Error('No timer job admitted.');
                },
            };
            const plan: AutomationPlan = {
                transport: 'serial',
                steps: [
                    {
                        id: 'one-step',
                        name: 'No command admitted',
                        enabled: true,
                        command: 'not sent',
                        delaySeconds: 0,
                    },
                ],
                timeoutSeconds: 10,
                repeatSeconds: null,
                start: null,
                serial: { lineEnding: 'CR', prompt: 'memory# ', timestampPrefix: '' },
            };
            const serial = {
                current: { generation: 1, label: 'Synthetic Serial only' },
                framing: 'synthetic',
            };
            const backend: FlowBackend = {
                target: { endpoint: 'Synthetic Serial only' },
                connection: () => '1',
                available: () => true,
                acquire: () => () => {},
                prepare: async () => {
                    prepares++;
                    throw Error('Synthetic readiness failure.');
                },
                execute: async () => {
                    executions++;
                    throw Error('No command admitted.');
                },
                finishFlow: async () => {
                    finishes++;
                    return { failure: 'Retained A evidence after positive transport retirement.' };
                },
            };
            const ctx: any = {
                cleanupClock: { current: undefined },
                pendingClockSamples: { current: 0 },
                manualClockSample: { current: null },
                runner: { current: null },
                arming: { current: false },
                armAttempt: { current: null },
                activityEpoch: { current: 0 },
                flowInspectionId: { current: null },
                cleanupActivity: { current: undefined },
                cleanupConsoleResults: { current: undefined },
                consoleResultsAdmission: { current: null },
                props: {
                    clockAdmission: { quiesce: header.quiesce },
                    connected: true,
                    transport: null,
                    serial,
                    target: null,
                    busy: false,
                    blocked: false,
                    onBusy: (v: boolean) => ui.busy.push(v),
                },
                latest: {
                    current: {
                        transport: null,
                        connected: true,
                        blocked: false,
                        onBusy: (v: boolean) => ui.busy.push(v),
                    },
                },
                fieldIssues: [],
                focusIssue: () => assert.fail(),
                build: () => structuredClone(plan),
                hidden: false,
                connected: true,
                captureActionBusy: false,
                desktop: {
                    async acquireAutomationActivity() {
                        assert.equal(liveLeases.size, 0);
                        const id = ++acquires === 1 ? leaseA : leaseB;
                        liveLeases.add(id);
                        if (id === leaseB) await replacementGrant.promise;
                        return id;
                    },
                    async releaseAutomationActivity(id: string) {
                        releases.push(id);
                        if (id === leaseA) {
                            // A's host effect applies first; only its reply is delayed/lost.
                            liveLeases.delete(id);
                            if (releases.filter((value) => value === leaseA).length === 1) {
                                await oldReply.promise;
                                throw Error('A release reply lost.');
                            }
                            await oldRetry.promise;
                        } else {
                            assert.equal(id, leaseB);
                            if (++replacementReleaseCalls === 1 && replacementReleaseFails)
                                throw Error('B release reply lost.');
                            await replacementClose.promise;
                            liveLeases.delete(id);
                        }
                    },
                },
                setActivityFailure: (v: string) => {
                    ui.activityFailure = v;
                },
                setError: (v: string) => {
                    ui.error = v;
                },
                setRunning: (v: boolean) => {
                    ui.running = v;
                },
                setState: (v: FlowState) => {
                    ui.state = v;
                },
                setFlowInspection: (v: any) => {
                    ui.inspection = typeof v === 'function' ? v(ui.inspection) : v;
                },
                openCaptureRepository: async () => ({}),
                openConsoleJournal: async () => assert.fail(),
                sample: async () => assert.fail(),
                serialCaptureBackend: () => backend,
                sshConsoleBackend: () => assert.fail(),
                sshCaptureBackend: () => assert.fail(),
            };
            const page = bindPage(ctx as PageContext);
            ctx.runner.current = new FlowRunner(
                bindPageRunnerChanged({
                    activityRetirements: ctx.activityRetirements,
                    flowInspectionId: ctx.flowInspectionId,
                    latest: ctx.latest,
                    setState: ctx.setState,
                    setFlowInspection: ctx.setFlowInspection,
                    setRunning: ctx.setRunning,
                }),
                () => assert.fail(),
                clock,
            );
            const tasks: Promise<unknown>[] = [];
            try {
                const first = page.start();
                tasks.push(first);
                await until(() => releases.length === 1 && reservation.current === null).catch(
                    (error) => {
                        throw new Error(
                            'Initial A setup failed: ' +
                                JSON.stringify({
                                    acquires,
                                    prepares,
                                    finishes,
                                    releases,
                                    reserved: reservation.current !== null,
                                    state: ui.state,
                                    error: ui.error,
                                }),
                            { cause: error },
                        );
                    },
                );
                // Cancel A's already-retired flow while its host reply is still pending, then admit B.
                page.cancel();
                const replacement = page.start();
                tasks.push(replacement);
                await until(() => acquires === 2);
                const attemptB = ctx.armAttempt.current,
                    epochB = ctx.activityEpoch.current,
                    reservedB = reservation.current;
                assert.ok(attemptB && reservedB);
                assert.equal(ctx.arming.current, true);
                assert.equal(ctx.runner.current.busy, false);
                oldReply.release();
                await first;
                await until(() => Boolean(ui.activityFailure));
                const beforeLabel = label(ui.state, ctx.arming, ctx.runner, ui.activityFailure);
                page.cancel();
                for (let n = 0; n < 16; n++) await Promise.resolve();
                console.log(
                    JSON.stringify({
                        event: 'cancel-overlap',
                        beforeLabel,
                        armingAfter: ctx.arming.current,
                        attemptInvalidated: ctx.armAttempt.current !== attemptB,
                        epochAdvanced: ctx.activityEpoch.current > epochB,
                        oldReleaseCalls: releases.filter((value) => value === leaseA).length,
                        busyAfter: ui.busy.at(-1),
                    }),
                );
                assert.equal(
                    ctx.arming.current,
                    false,
                    'Cancel must fence the pre-arming replacement, not retry A.',
                );
                assert.equal(ctx.armAttempt.current, null);
                assert.ok(ctx.activityEpoch.current > epochB);
                assert.equal(beforeLabel, 'Cancel run');
                assert.equal(
                    label(ui.state, ctx.arming, ctx.runner, ui.activityFailure),
                    'Retry cleanup',
                );
                assert.equal(ui.running, true);
                assert.equal(ui.busy.at(-1), true);
                assert.match(ui.activityFailure, /A release reply lost/);
                assert.match(ui.state.message, /cancelled before arming/);
                assert.equal(
                    releases.filter((value) => value === leaseA).length,
                    1,
                    'Cancel cannot implicitly retry A.',
                );
                assert.equal(reservation.current, reservedB);
                replacementGrant.release();
                await until(() => releases.includes(leaseB));
                assert.equal(prepares, 1);
                assert.equal(finishes, 1);
                assert.equal(executions, 0);
                if (replacementReleaseFails)
                    await until(() => /2 owned attempts/.test(ui.activityFailure));
                assert.equal(ui.running, true);
                assert.equal(ui.busy.at(-1), true);
                page.cancel();
                page.cancel();
                await until(() => releases.filter((value) => value === leaseA).length === 2);
                if (replacementReleaseFails) await until(() => replacementReleaseCalls === 2);
                oldRetry.release();
                await until(() => !ui.activityFailure.includes('A release reply lost'));
                assert.equal(
                    reservation.current,
                    reservedB,
                    'A acknowledgement cannot release B clock ownership.',
                );
                await assert.rejects(
                    header.quiesce(),
                    /Wait for the current clock reader admission/,
                );
                if (replacementReleaseFails) {
                    assert.match(ui.activityFailure, /B release reply lost/);
                    assert.equal(ui.running, true);
                    assert.equal(ui.busy.at(-1), true);
                    await page.start();
                    assert.equal(acquires, 2);
                }
                replacementClose.release();
                await replacement;
                await until(
                    () =>
                        !ctx.activityRetirements.current.hasFailures &&
                        reservation.current === null,
                );
                assert.equal(ui.running, false);
                assert.equal(ui.busy.at(-1), false);
                assert.equal(liveLeases.size, 0);
                assert.equal(prepares, 1);
                assert.equal(finishes, 1);
                assert.equal(executions, 0);
                assert.equal(releases.filter((value) => value === leaseA).length, 2);
                assert.equal(replacementReleaseCalls, replacementReleaseFails ? 2 : 1);
            } finally {
                oldReply.release();
                oldRetry.release();
                replacementGrant.release();
                replacementClose.release();
                await Promise.allSettled(tasks);
                header.cleanup?.();
            }
        },
    );

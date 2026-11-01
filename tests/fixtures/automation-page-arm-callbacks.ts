// Exact current start/cancel callbacks; lexicals/IO injected, no React/DOM or page import.
import {prepareInspection,type FlowInspection} from '../../src/features/automation/flow/inspection';
import type {FlowRunner,FlowBackend,FlowState} from '../../src/features/automation/runner';
import type {AutomationPlan,AutomationTransport,ClockCalibration} from '../../shared/automation';
import type {DesktopBridge} from '../../shared/types';
type Ref<T>={current:T};
interface ManualClockSample {valid:boolean;active:Partial<AutomationTransport>|null;connection:string|undefined;endpoint:string|undefined;username:string|undefined;connected:boolean}
export interface PageContext {
 cleanupClock:Ref<(()=>void)|undefined>;pendingClockSamples:Ref<number>;manualClockSample:Ref<ManualClockSample|null>;runner:Ref<FlowRunner|null>;arming:Ref<boolean>;armAttempt:Ref<symbol|null>;activityEpoch:Ref<number>;
 flowInspectionId:Ref<string|null>;cleanupActivity:Ref<string|undefined>;cleanupConsoleResults:Ref<(()=>void)|undefined>;
 consoleResultsAdmission:Ref<{quiesce():Promise<()=>void>}|null>;
 props:{clockAdmission:{quiesce():Promise<()=>void>};connected:boolean;transport:Partial<AutomationTransport>|null;serial:{current:{generation:number;label:string};framing:string};target:FlowBackend['target']|null;busy:boolean;blocked:boolean;onBusy(v:boolean):void};
 latest:Ref<{target?:FlowBackend['target']|null;transport:Partial<AutomationTransport>|null;connected:boolean;blocked:boolean;onBusy(v:boolean):void}>;
 fieldIssues:unknown[];focusIssue(value:unknown):void;build():AutomationPlan;
 hidden:boolean;connected:boolean;captureActionBusy:boolean;
 desktop:Pick<DesktopBridge,'acquireAutomationActivity'|'releaseAutomationActivity'>|undefined;
 setTransport?(v:'ssh'|'serial'):void;setClockKind?(v:'local'|'device'):void;setScheduled?(v:boolean):void;setSampling?(v:boolean):void;setCalibration?(v:ClockCalibration|undefined):void;setError(v:string):void;setRunning(v:boolean):void;setState(v:FlowState):void;setFlowInspection(v:FlowInspection|null):void;
 openCaptureRepository():Promise<unknown>;openConsoleJournal():Promise<unknown>;sample(active?:Partial<AutomationTransport>|null):Promise<ClockCalibration>;
 sshConsoleBackend:(...args:unknown[])=>FlowBackend;sshCaptureBackend:(...args:unknown[])=>FlowBackend;serialCaptureBackend:(...args:unknown[])=>FlowBackend;
}
export const boundSpan="    const invalidateManualClockSample = () => {\n        if (manualClockSample.current) manualClockSample.current.valid = false;\n    };\n    const changeTransport = (value: 'ssh' | 'serial') => {\n        invalidateManualClockSample();\n        setTransport(value);\n        setCalibration(undefined);\n    };\n    const changeClockKind = (value: 'local' | 'device') => {\n        invalidateManualClockSample();\n        setClockKind(value);\n    };\n    const changeScheduled = (value: boolean) => {\n        invalidateManualClockSample();\n        setScheduled(value);\n    };\n    const sampleClicked = () => {\n        const attempt: ManualClockSample = {\n            valid: true,\n            active: props.transport,\n            connection: props.transport?.automationConnection?.(),\n            endpoint: props.target?.endpoint,\n            username: props.target?.username,\n            connected: props.connected,\n        };\n        manualClockSample.current = attempt;\n        const epoch = activityEpoch.current;\n        const current = () =>\n            manualClockSample.current === attempt &&\n            attempt.valid &&\n            activityEpoch.current === epoch &&\n            latest.current.transport === attempt.active &&\n            latest.current.connected &&\n            latest.current.target?.endpoint === attempt.endpoint &&\n            latest.current.target?.username === attempt.username &&\n            attempt.active?.automationConnection?.() === attempt.connection;\n        pendingClockSamples.current++;\n        setSampling(true);\n        setError('');\n        void sample()\n            .then((value) => {\n                if (current()) setCalibration(value);\n            })\n            .catch((e) => {\n                if (current()) setError(e.message);\n            })\n            .finally(() => {\n                pendingClockSamples.current--;\n                if (manualClockSample.current === attempt) manualClockSample.current = null;\n                setSampling(pendingClockSamples.current > 0);\n            });\n    };\n    const cancel = () => {\n        if (runner.current?.cleanupPending) {\n            void runner.current\n                .retryCleanup()\n                .then(async () => {\n                    const held = cleanupActivity.current;\n                    const resume = cleanupConsoleResults.current;\n                    const resumeClock = cleanupClock.current;\n                    cleanupActivity.current = undefined;\n                    if (held) await window.diagnosticHub?.releaseAutomationActivity?.(held);\n                    if (cleanupConsoleResults.current === resume)\n                        cleanupConsoleResults.current = undefined;\n                    resume?.();\n                    if (cleanupClock.current === resumeClock) cleanupClock.current = undefined;\n                    resumeClock?.();\n                    const active = arming.current || Boolean(runner.current?.busy);\n                    setRunning(active);\n                    latest.current.onBusy(active);\n                })\n                .catch((error) => setError(error instanceof Error ? error.message : String(error)));\n            return;\n        }\n        activityEpoch.current++;\n        runner.current!.cancel();\n        if (arming.current && !runner.current!.busy) {\n            // A pending host lease cannot be cancelled, but its continuation can be fenced.\n            // Its owner still releases any lease granted after this cancellation.\n            armAttempt.current = null;\n            arming.current = false;\n            flowInspectionId.current = null;\n            setFlowInspection(null);\n            setRunning(false);\n            latest.current.onBusy(false);\n            setState({\n                state: 'paused',\n                message: 'Flow cancelled before arming. Arm explicitly to resume.',\n            });\n        }\n    };\n    const start = async (once = false) => {\n        if (arming.current || runner.current?.busy) return;\n        if (fieldIssues[0]) {\n            focusIssue(fieldIssues[0]);\n            return;\n        }\n        arming.current = true;\n        const attempt = Symbol('automation arming');\n        armAttempt.current = attempt;\n        let inspectionId: string | undefined,\n            flowStarted = false;\n        let lease: string | undefined;\n        let resumeConsoleResults: (() => void) | undefined;\n        let resumeClock: (() => void) | undefined;\n        const desktop = window.diagnosticHub;\n        const epoch = ++activityEpoch.current;\n        setError('');\n        try {\n            const snapshot = build();\n            if (once) {\n                snapshot.repeatSeconds = null;\n            }\n            if (document.hidden || !connected || props.busy || props.blocked || captureActionBusy)\n                throw Error('Wait for the selected transport and current collection.');\n            const inspection = prepareInspection(snapshot);\n            inspectionId = inspection.active.id;\n            flowInspectionId.current = inspectionId;\n            setFlowInspection(inspection);\n            const active = props.transport,\n                serial = props.serial,\n                connection =\n                    snapshot.transport === 'ssh'\n                        ? active!.automationConnection!()\n                        : String(serial.current.generation),\n                target =\n                    snapshot.transport === 'ssh'\n                        ? { ...(props.target ?? { endpoint: 'SSH target' }) }\n                        : { endpoint: serial.current.label, serialSettings: serial.framing };\n            latest.current.onBusy(true);\n            setRunning(true);\n            resumeClock = await props.clockAdmission.quiesce();\n            if (armAttempt.current !== attempt) return;\n            const repository =\n                snapshot.transport === 'ssh' && snapshot.ssh?.mode === 'console'\n                    ? undefined\n                    : await openCaptureRepository();\n            if (armAttempt.current !== attempt) return;\n            const backend: FlowBackend =\n                snapshot.transport === 'serial'\n                    ? serialCaptureBackend(serial, repository!)\n                    : snapshot.ssh?.mode === 'console'\n                      ? sshConsoleBackend(\n                            active!,\n                            window.diagnosticHub ? 'local-client' : 'gateway',\n                            target,\n                            () =>\n                                !latest.current.blocked &&\n                                latest.current.connected &&\n                                latest.current.transport === active,\n                            () => IndexedDbConsoleJournal.open(),\n                            () => sample(active),\n                            async () => {\n                                if (!consoleResultsAdmission.current)\n                                    throw Error(\n                                        'Console results admission is unavailable. Arm explicitly to resume.',\n                                    );\n                                resumeConsoleResults =\n                                    await consoleResultsAdmission.current.quiesce();\n                            },\n                            () => resumeConsoleResults?.(),\n                        )\n                      : sshCaptureBackend(\n                            active!,\n                            repository!,\n                            window.diagnosticHub ? 'local-client' : 'gateway',\n                            target,\n                            () =>\n                                !latest.current.blocked &&\n                                latest.current.connected &&\n                                latest.current.transport === active,\n                            () => sample(active),\n                        );\n            latest.current.onBusy(true);\n            setRunning(true);\n            lease = await desktop?.acquireAutomationActivity?.();\n            if (armAttempt.current !== attempt) return;\n            if (\n                activityEpoch.current !== epoch ||\n                latest.current.blocked ||\n                !backend.available() ||\n                backend.connection() !== connection\n            )\n                throw Error(\n                    'Automation eligibility changed while arming. Arm explicitly to resume.',\n                );\n            const task = runner.current!.start(snapshot, backend);\n            flowStarted = true;\n            await task;\n        } catch (e) {\n            if (armAttempt.current === attempt)\n                setError(e instanceof Error ? e.message : String(e));\n        } finally {\n            if (!flowStarted && inspectionId && flowInspectionId.current === inspectionId) {\n                flowInspectionId.current = null;\n                setFlowInspection(null);\n            }\n            // A cancelled pre-arm continuation must not adopt another run's cleanup.\n            const pending = flowStarted && Boolean(runner.current?.cleanupPending);\n            if (lease) {\n                if (pending) cleanupActivity.current = lease;\n                else await desktop?.releaseAutomationActivity?.(lease).catch(() => {});\n            }\n            if (pending) cleanupConsoleResults.current = resumeConsoleResults;\n            else resumeConsoleResults?.();\n            if (pending) cleanupClock.current = resumeClock;\n            else resumeClock?.();\n            if (armAttempt.current === attempt) {\n                armAttempt.current = null;\n                arming.current = false;\n                setRunning(pending);\n                latest.current.onBusy(pending);\n            }\n        }\n    };\n";
export const pageSourceSHA256='3717d5a6ee75db887b3fc4f6c91af5c24e7231033f9e7186e0f083e42e1a6c6f';
export function bindPage(context:PageContext){
 const {cleanupClock,pendingClockSamples,manualClockSample,runner,arming,armAttempt,activityEpoch,flowInspectionId,cleanupActivity,cleanupConsoleResults,consoleResultsAdmission,props,latest,fieldIssues,focusIssue,build,connected,captureActionBusy,setError,setRunning,setState,setFlowInspection,openCaptureRepository,sample,sshConsoleBackend,sshCaptureBackend,serialCaptureBackend}=context;
 const setTransport=context.setTransport??(()=>{}),setClockKind=context.setClockKind??(()=>{}),setScheduled=context.setScheduled??(()=>{});
 const setSampling=context.setSampling??(()=>{}),setCalibration=context.setCalibration??(()=>{});
 const window={diagnosticHub:context.desktop},document={hidden:context.hidden},IndexedDbConsoleJournal={open:context.openConsoleJournal};
    const invalidateManualClockSample = () => {
        if (manualClockSample.current) manualClockSample.current.valid = false;
    };
    const changeTransport = (value: 'ssh' | 'serial') => {
        invalidateManualClockSample();
        setTransport(value);
        setCalibration(undefined);
    };
    const changeClockKind = (value: 'local' | 'device') => {
        invalidateManualClockSample();
        setClockKind(value);
    };
    const changeScheduled = (value: boolean) => {
        invalidateManualClockSample();
        setScheduled(value);
    };
    const sampleClicked = () => {
        const attempt: ManualClockSample = {
            valid: true,
            active: props.transport,
            connection: props.transport?.automationConnection?.(),
            endpoint: props.target?.endpoint,
            username: props.target?.username,
            connected: props.connected,
        };
        manualClockSample.current = attempt;
        const epoch = activityEpoch.current;
        const current = () =>
            manualClockSample.current === attempt &&
            attempt.valid &&
            activityEpoch.current === epoch &&
            latest.current.transport === attempt.active &&
            latest.current.connected &&
            latest.current.target?.endpoint === attempt.endpoint &&
            latest.current.target?.username === attempt.username &&
            attempt.active?.automationConnection?.() === attempt.connection;
        pendingClockSamples.current++;
        setSampling(true);
        setError('');
        void sample()
            .then((value) => {
                if (current()) setCalibration(value);
            })
            .catch((e) => {
                if (current()) setError(e.message);
            })
            .finally(() => {
                pendingClockSamples.current--;
                if (manualClockSample.current === attempt) manualClockSample.current = null;
                setSampling(pendingClockSamples.current > 0);
            });
    };
    const cancel = () => {
        if (runner.current?.cleanupPending) {
            void runner.current
                .retryCleanup()
                .then(async () => {
                    const held = cleanupActivity.current;
                    const resume = cleanupConsoleResults.current;
                    const resumeClock = cleanupClock.current;
                    cleanupActivity.current = undefined;
                    if (held) await window.diagnosticHub?.releaseAutomationActivity?.(held);
                    if (cleanupConsoleResults.current === resume)
                        cleanupConsoleResults.current = undefined;
                    resume?.();
                    if (cleanupClock.current === resumeClock) cleanupClock.current = undefined;
                    resumeClock?.();
                    const active = arming.current || Boolean(runner.current?.busy);
                    setRunning(active);
                    latest.current.onBusy(active);
                })
                .catch((error) => setError(error instanceof Error ? error.message : String(error)));
            return;
        }
        activityEpoch.current++;
        runner.current!.cancel();
        if (arming.current && !runner.current!.busy) {
            // A pending host lease cannot be cancelled, but its continuation can be fenced.
            // Its owner still releases any lease granted after this cancellation.
            armAttempt.current = null;
            arming.current = false;
            flowInspectionId.current = null;
            setFlowInspection(null);
            setRunning(false);
            latest.current.onBusy(false);
            setState({
                state: 'paused',
                message: 'Flow cancelled before arming. Arm explicitly to resume.',
            });
        }
    };
    const start = async (once = false) => {
        if (arming.current || runner.current?.busy) return;
        if (fieldIssues[0]) {
            focusIssue(fieldIssues[0]);
            return;
        }
        arming.current = true;
        const attempt = Symbol('automation arming');
        armAttempt.current = attempt;
        let inspectionId: string | undefined,
            flowStarted = false;
        let lease: string | undefined;
        let resumeConsoleResults: (() => void) | undefined;
        let resumeClock: (() => void) | undefined;
        const desktop = window.diagnosticHub;
        const epoch = ++activityEpoch.current;
        setError('');
        try {
            const snapshot = build();
            if (once) {
                snapshot.repeatSeconds = null;
            }
            if (document.hidden || !connected || props.busy || props.blocked || captureActionBusy)
                throw Error('Wait for the selected transport and current collection.');
            const inspection = prepareInspection(snapshot);
            inspectionId = inspection.active.id;
            flowInspectionId.current = inspectionId;
            setFlowInspection(inspection);
            const active = props.transport,
                serial = props.serial,
                connection =
                    snapshot.transport === 'ssh'
                        ? active!.automationConnection!()
                        : String(serial.current.generation),
                target =
                    snapshot.transport === 'ssh'
                        ? { ...(props.target ?? { endpoint: 'SSH target' }) }
                        : { endpoint: serial.current.label, serialSettings: serial.framing };
            latest.current.onBusy(true);
            setRunning(true);
            resumeClock = await props.clockAdmission.quiesce();
            if (armAttempt.current !== attempt) return;
            const repository =
                snapshot.transport === 'ssh' && snapshot.ssh?.mode === 'console'
                    ? undefined
                    : await openCaptureRepository();
            if (armAttempt.current !== attempt) return;
            const backend: FlowBackend =
                snapshot.transport === 'serial'
                    ? serialCaptureBackend(serial, repository!)
                    : snapshot.ssh?.mode === 'console'
                      ? sshConsoleBackend(
                            active!,
                            window.diagnosticHub ? 'local-client' : 'gateway',
                            target,
                            () =>
                                !latest.current.blocked &&
                                latest.current.connected &&
                                latest.current.transport === active,
                            () => IndexedDbConsoleJournal.open(),
                            () => sample(active),
                            async () => {
                                if (!consoleResultsAdmission.current)
                                    throw Error(
                                        'Console results admission is unavailable. Arm explicitly to resume.',
                                    );
                                resumeConsoleResults =
                                    await consoleResultsAdmission.current.quiesce();
                            },
                            () => resumeConsoleResults?.(),
                        )
                      : sshCaptureBackend(
                            active!,
                            repository!,
                            window.diagnosticHub ? 'local-client' : 'gateway',
                            target,
                            () =>
                                !latest.current.blocked &&
                                latest.current.connected &&
                                latest.current.transport === active,
                            () => sample(active),
                        );
            latest.current.onBusy(true);
            setRunning(true);
            lease = await desktop?.acquireAutomationActivity?.();
            if (armAttempt.current !== attempt) return;
            if (
                activityEpoch.current !== epoch ||
                latest.current.blocked ||
                !backend.available() ||
                backend.connection() !== connection
            )
                throw Error(
                    'Automation eligibility changed while arming. Arm explicitly to resume.',
                );
            const task = runner.current!.start(snapshot, backend);
            flowStarted = true;
            await task;
        } catch (e) {
            if (armAttempt.current === attempt)
                setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (!flowStarted && inspectionId && flowInspectionId.current === inspectionId) {
                flowInspectionId.current = null;
                setFlowInspection(null);
            }
            // A cancelled pre-arm continuation must not adopt another run's cleanup.
            const pending = flowStarted && Boolean(runner.current?.cleanupPending);
            if (lease) {
                if (pending) cleanupActivity.current = lease;
                else await desktop?.releaseAutomationActivity?.(lease).catch(() => {});
            }
            if (pending) cleanupConsoleResults.current = resumeConsoleResults;
            else resumeConsoleResults?.();
            if (pending) cleanupClock.current = resumeClock;
            else resumeClock?.();
            if (armAttempt.current === attempt) {
                armAttempt.current = null;
                arming.current = false;
                setRunning(pending);
                latest.current.onBusy(pending);
            }
        }
    };

 return {start,cancel,sampleClicked,changeTransport,changeClockKind,changeScheduled};
}

export const samplingLifecycleSpan="    useEffect(\n        () => {\n            const active = props.transport,\n                connection = active?.automationConnection?.(),\n                endpoint = props.target?.endpoint,\n                username = props.target?.username,\n                connected = props.connected;\n            return () => {\n                const attempt = manualClockSample.current;\n                if (\n                    attempt &&\n                    attempt.active === active &&\n                    attempt.connection === connection &&\n                    attempt.endpoint === endpoint &&\n                    attempt.username === username &&\n                    attempt.connected === connected\n                )\n                    attempt.valid = false;\n            };\n        },\n        [\n            props.transport,\n            props.connected,\n            props.target?.endpoint,\n            props.target?.username,\n            props.transport?.automationConnection?.(),\n        ],\n    );";
export function bindSamplingLifecycle(context:PageContext){const {props,manualClockSample}=context;
            const active = props.transport,
                connection = active?.automationConnection?.(),
                endpoint = props.target?.endpoint,
                username = props.target?.username,
                connected = props.connected;
            return () => {
                const attempt = manualClockSample.current;
                if (
                    attempt &&
                    attempt.active === active &&
                    attempt.connection === connection &&
                    attempt.endpoint === endpoint &&
                    attempt.username === username &&
                    attempt.connected === connected
                )
                    attempt.valid = false;
            };
}

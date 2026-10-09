import { useEffect, useRef, useState } from 'react';
import { draftProfile, validateProfile } from '../../../shared/testing/profile';
import { parseDirectRequest } from '../../../shared/testing/direct';
import { createSimulation, sampleProfile } from '../../../shared/testing/simulation';
import {
    createTestReport,
    parseTestReport,
    reportHtml,
    validateRun,
} from '../../../shared/testing/report';
import { blankEvidence, refreshVerdicts } from '../../../shared/testing/runner';
import {
    activeRun,
    PROFILE_BYTES,
    REPORT_BYTES,
    type BoardProfile,
    type Inventory,
    type Readiness,
    type ReportFormat,
    type StartTests,
    type TestPlan,
    type TestRun,
    type TestingTransport,
} from '../../../shared/testing/types';

interface Options {
    transport: Partial<TestingTransport> | null;
    generation?: number;
    connected: boolean;
    blocked: boolean;
    collecting: boolean;
    reset: number;
    activity(active: boolean): boolean;
}
const errorText = (error: unknown) =>
    error instanceof Error ? error.message : 'Testing operation failed.';
function interrupted(run: TestRun): TestRun {
    const r = structuredClone(run),
        now = new Date().toISOString();
    r.phase = 'cancelled';
    r.finishedAt = now;
    r.interruption = 'Device connection changed before completion.';
    for (const c of r.cases)
        if (c.status !== 'done') {
            const running = c.status === 'running';
            c.status = 'done';
            c.finishedAt = now;
            c.evidence = {
                ...blankEvidence(running ? 'interrupted' : 'skipped', r.interruption),
                cleanup: running ? 'unverified' : 'not-needed',
                cleanupDetail: running
                    ? 'Transport ended before cleanup was verified.'
                    : 'Not executed.',
            };
            c.reason = c.evidence.reason;
        }
    refreshVerdicts(r);
    return r;
}
export function download(content: string, type: string, name: string) {
    const url = URL.createObjectURL(new Blob([content], { type })),
        anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface SourceOptions extends Options {
    simulated: boolean;
    enabled: boolean;
}
function useTestSource(options: SourceOptions) {
    const simulated = options.simulated;
    const [inventory, setInventory] = useState<Inventory | null>(null);
    const [profile, setProfile] = useState<BoardProfile | null>(null),
        [json, setJson] = useState(''),
        [jsonEdited, setJsonEdited] = useState(false);
    const [plan, setPlan] = useState<TestPlan | null>(null),
        [run, setRun] = useState<TestRun | null>(null);
    const [historical, setHistorical] = useState(false),
        [working, setWorking] = useState(false),
        [unconfirmed, setUnconfirmed] = useState(false);
    const [error, setError] = useState(''),
        [notice, setNotice] = useState('');
    const [readiness, setReadiness] = useState<Readiness>({ reviewed: false, fixtures: {} });
    const [selection, setSelection] = useState(''),
        [preview, setPreview] = useState<string | null>(null);
    const [mode, setMode] = useState<'guided' | 'json'>('guided'),
        [directJson, setDirectJson] = useState(''),
        [editor, setEditor] = useState(false);
    const directRun = useRef<string | null>(null);
    const latest = useRef(options);
    latest.current = options;
    const supported = Boolean(
        options.transport?.discoverTests &&
        options.transport.prepareTests &&
        options.transport.startTests &&
        options.transport.readTestRun &&
        options.transport.cancelTests &&
        options.transport.confirmTest,
    );
    const transport =
        options.enabled && supported && (simulated || options.connected)
            ? (options.transport as TestingTransport)
            : null;
    const key = `${simulated ? 'sim' : 'ssh'}-${options.generation ?? 'none'}-${options.reset}`;
    const current = useRef(key);
    const previousKey = useRef(key);
    current.current = key;
    const changing = useRef<string | null>(null);
    const currentRun = useRef({ run, historical });
    currentRun.current = { run, historical };
    const lastReset = useRef(options.reset);
    const active = !historical && activeRun(run),
        locked = working || active || unconfirmed || options.blocked;
    const valid = (token: string) => token === current.current && latest.current.enabled;
    function edit(value: BoardProfile) {
        setProfile(value);
        setJson(JSON.stringify(value, null, 4));
        setJsonEdited(false);
        setPlan(null);
        setReadiness({ reviewed: false, fixtures: {} });
        setError('');
    }
    function editJson(value: string) {
        setJson(value);
        setJsonEdited(true);
        setPlan(null);
        setReadiness({ reviewed: false, fixtures: {} });
        setError('');
        try {
            setProfile(validateProfile(JSON.parse(value)));
        } catch {
            /* Keep the last valid form while JSON is being edited. */
        }
    }
    async function receive(target: TestingTransport, next: TestRun, token: string) {
        if (!valid(token)) return;
        let result = validateRun(next);
        if (directRun.current === result.id && result.phase === 'review') {
            for (const c of result.cases)
                if (
                    c.test.adapter === 'led.pattern' &&
                    c.evidence?.execution === 'ok' &&
                    !c.feedback
                ) {
                    if (!valid(token)) return;
                    result = validateRun(
                        await target.confirmTest({
                            runId: result.id,
                            testId: c.test.id,
                            value: 'unobserved',
                        }),
                    );
                }
        }
        if (!valid(token)) return;
        setRun(result);
        setHistorical(false);
        if (!activeRun(result)) latest.current.activity(false);
    }
    useEffect(() => {
        const changed = previousKey.current !== key;
        previousKey.current = key;
        changing.current = null;
        setInventory(null);
        setPlan(null);
        setProfile(null);
        setJson('');
        setJsonEdited(false);
        directRun.current = null;
        setDirectJson('');
        setSelection('');
        setError('');
        setNotice('');
        setPreview(null);
        setWorking(false);
        setUnconfirmed(false);
        setReadiness({ reviewed: false, fixtures: {} });
        const resetChanged = lastReset.current !== latest.current.reset;
        if (resetChanged || simulated) {
            setRun(null);
            setHistorical(false);
            lastReset.current = latest.current.reset;
        } else
            setRun((r) => {
                if (r && changed) setHistorical(true);
                if (activeRun(r)) {
                    setHistorical(true);
                    return interrupted(r!);
                }
                return r;
            });
        if (resetChanged || !simulated) {
            setMode('guided');
            setEditor(false);
        }
        if (latest.current.enabled) latest.current.activity(false);
        if (simulated && options.transport) {
            const token = key,
                target = options.transport as TestingTransport;
            void (async () => {
                if (resetChanged) await target.clearTests?.();
                const inv = await target.discoverTests();
                if (current.current !== token) return;
                const p = sampleProfile();
                setInventory(inv);
                edit(p);
                setDirectJson(JSON.stringify(p, null, 4));
                setNotice('Simulated board only. No hardware commands will be sent.');
            })().catch((e) => {
                if (current.current === token) setError(errorText(e));
            });
        }
    }, [key]);
    useEffect(() => {
        if (!active || !transport || historical) return;
        const token = key;
        let stopped = false,
            timer: ReturnType<typeof setTimeout>;
        async function poll() {
            try {
                const next = await transport!.readTestRun();
                if (stopped || !valid(token)) return;
                if (next) {
                    await receive(transport!, next, token);
                } else {
                    setError(
                        'No active run was returned. Reconnect and review device state before continuing.',
                    );
                }
            } catch (e) {
                if (!stopped && valid(token)) setError(errorText(e));
            }
            if (!stopped && valid(token)) timer = setTimeout(poll, 1000);
        }
        timer = setTimeout(poll, 150);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [active, run?.id, key, transport, historical]);
    useEffect(
        () => () => {
            const latestRun = currentRun.current;
            if (
                !latestRun.historical &&
                latestRun.run?.id === run?.id &&
                activeRun(latestRun.run) &&
                transport
            )
                void transport.cancelTests(latestRun.run!.id).catch(() => {});
        },
        [transport, run?.id],
    );
    async function operate(operation: (target: TestingTransport, token: string) => Promise<void>) {
        if (!transport || locked || changing.current) return;
        const token = key;
        changing.current = token;
        setWorking(true);
        setError('');
        setNotice('');
        try {
            await operation(transport, token);
        } catch (e) {
            if (valid(token)) setError(errorText(e));
        } finally {
            if (changing.current === token) {
                changing.current = null;
                if (valid(token)) setWorking(false);
            }
        }
    }
    async function discover() {
        if (simulated) return;
        await operate(async (target, token) => {
            const next = await target.discoverTests();
            if (!valid(token)) return;
            setInventory(next);
            setPlan(null);
            edit(draftProfile(next));
            setNotice(
                'Current board inventory discovered. Review mappings and complete test intent.',
            );
        });
    }
    async function prepare() {
        await operate(async (target, token) => {
            const p = validateProfile(JSON.parse(json)),
                next = await target.prepareTests(p);
            if (!valid(token)) return;
            setProfile(p);
            setPlan(next);
            setInventory(next.inventory);
            setSelection(p.sequences[0]?.id || p.tests[0]?.id || '');
            setReadiness({
                reviewed: false,
                fixtures: Object.fromEntries(
                    p.tests.map((t) => [
                        t.id,
                        { ready: simulated, identity: simulated ? 'Simulated fixture' : '' },
                    ]),
                ),
            });
        });
    }
    async function submit(
        target: TestingTransport,
        request: StartTests,
        token: string,
        direct = false,
    ) {
        const previous = await target.readTestRun();
        if (!valid(token)) return;
        try {
            const next = await target.startTests(request);
            if (valid(token)) {
                directRun.current = direct ? next.id : null;
                await receive(target, next, token);
            }
        } catch (e) {
            if (!valid(token)) return;
            setError(errorText(e));
            try {
                const recovered = await target.readTestRun();
                if (valid(token)) {
                    if (recovered && recovered.id !== previous?.id) {
                        directRun.current = direct ? recovered.id : null;
                        await receive(target, recovered, token);
                        setNotice(
                            'Backend run recovered. Review its recorded state before retrying.',
                        );
                    }
                    if (!activeRun(recovered)) latest.current.activity(false);
                }
            } catch {
                if (valid(token)) {
                    setUnconfirmed(true);
                    setError(
                        'Run status could not be confirmed. Disconnect to cancel backend work, then reconnect and review device recovery.',
                    );
                }
            }
        }
    }
    async function start() {
        if (!plan || options.collecting) return;
        await operate(async (target, token) => {
            if (!latest.current.activity(true))
                throw Error('Wait for collection or reset to finish.');
            const sequence = plan.profile.sequences.find((s) => s.id === selection);
            try {
                await submit(
                    target,
                    {
                        profile: plan.profile,
                        inventoryId: plan.inventory.id,
                        testIds: sequence?.tests ?? [selection],
                        sequence: sequence?.id || '',
                        readiness,
                    },
                    token,
                );
            } catch (e) {
                if (valid(token)) latest.current.activity(false);
                throw e;
            }
        });
    }
    async function startJson() {
        if (options.collecting) return;
        await operate(async (target, token) => {
            const request = parseDirectRequest(directJson);
            if (!latest.current.activity(true))
                throw Error('Wait for collection or reset to finish.');
            try {
                // Simulation already supplies its inventory and never borrows device discovery.
                const inv = simulated ? inventory! : await target.discoverTests();
                if (!valid(token)) return;
                const prepared = await target.prepareTests(request.profile);
                if (!valid(token)) return;
                setInventory(inv);
                edit(request.profile);
                setPlan(prepared);
                setSelection(request.sequence || request.testIds[0]);
                setReadiness(request.readiness);
                await submit(
                    target,
                    { ...request, inventoryId: prepared.inventory.id },
                    token,
                    true,
                );
            } catch (e) {
                if (valid(token)) latest.current.activity(false);
                throw e;
            }
        });
    }
    async function cancel() {
        if (!transport || !run || historical || changing.current) return;
        const token = key;
        setWorking(true);
        changing.current = token;
        setError('');
        try {
            const next = await transport.cancelTests(run.id);
            if (valid(token)) {
                setRun(validateRun(next));
                latest.current.activity(false);
            }
        } catch (e) {
            if (valid(token)) setError(errorText(e));
        } finally {
            if (changing.current === token) {
                changing.current = null;
                if (valid(token)) setWorking(false);
            }
        }
    }
    async function confirm(testId: string, value: 'yes' | 'no' | 'unobserved') {
        if (!transport || !run || historical || active || working) return;
        const token = key;
        setWorking(true);
        try {
            const next = await transport.confirmTest({ runId: run.id, testId, value });
            if (valid(token)) setRun(validateRun(next));
        } catch (e) {
            if (valid(token)) setError(errorText(e));
        } finally {
            if (valid(token)) setWorking(false);
        }
    }
    async function importProfile(file: File) {
        if (locked || changing.current) return;
        const token = key;
        changing.current = token;
        setWorking(true);
        try {
            if (file.size > PROFILE_BYTES) throw Error('Profile exceeds 128 KiB.');
            const next = validateProfile(JSON.parse(await file.text()));
            if (valid(token)) edit(next);
        } catch (e) {
            if (valid(token)) setError(errorText(e));
        } finally {
            if (changing.current === token) {
                changing.current = null;
                if (valid(token)) setWorking(false);
            }
        }
    }
    async function importReport(file: File) {
        if (locked || changing.current) return;
        if (run?.phase === 'review' && !historical) {
            setError(
                'Record or dismiss pending operator observations before importing another report.',
            );
            return;
        }
        const token = key;
        changing.current = token;
        setWorking(true);
        try {
            if (file.size > REPORT_BYTES) throw Error('Test report exceeds 16 MiB.');
            const report = await parseTestReport(await file.text());
            if (!valid(token)) return;
            setRun(report.run);
            setHistorical(true);
            setPlan(null);
            setPreview(null);
            setNotice('Historical test report opened locally. No device operations started.');
        } catch (e) {
            if (valid(token)) setError(errorText(e));
        } finally {
            if (changing.current === token) {
                changing.current = null;
                if (valid(token)) setWorking(false);
            }
        }
    }
    async function exportReport(format: ReportFormat) {
        if (!run || working) return;
        const token = key;
        try {
            const report = createTestReport(run, historical),
                native = window.diagnosticHub;
            if (native?.exportTestReport) {
                const supplied = historical || run.mode === 'simulated' || !options.connected;
                const saved = await native.exportTestReport(format, supplied ? report : undefined);
                if (saved && valid(token)) setNotice(`Test ${format.toUpperCase()} report saved.`);
            } else if (format === 'pdf') setPreview(reportHtml(report));
            else
                download(
                    format === 'json' ? JSON.stringify(report, null, 4) : reportHtml(report),
                    format === 'json' ? 'application/json' : 'text/html',
                    `board-test-${run.mode}-${run.id}.${format}`,
                );
        } catch (e) {
            if (valid(token)) setError(errorText(e));
        }
    }
    return {
        inventory,
        profile,
        json,
        jsonEdited,
        setJson: editJson,
        edit,
        plan,
        run,
        historical,
        working,
        locked,
        active,
        simulated,
        supported,
        error,
        notice,
        readiness,
        setReadiness,
        selection,
        setSelection,
        preview,
        setPreview,
        discover,
        prepare,
        start,
        mode,
        editor,
        setEditor,
        isBusy: () => locked || Boolean(changing.current),
        setMode: (value: 'guided' | 'json') => {
            if (locked || (!historical && run?.phase === 'review') || value === mode) return;
            setMode(value);
            if (value === 'json') setDirectJson(json);
        },
        directJson,
        setDirectJson: (value: string) => {
            setDirectJson(value);
            setError('');
        },
        startJson,
        cancel,
        confirm,
        importProfile,
        importReport,
        exportReport,
        exportProfile: () => {
            try {
                const p = validateProfile(JSON.parse(json));
                download(JSON.stringify(p, null, 4), 'application/json', `${p.id}.json`);
            } catch (e) {
                setError(errorText(e));
            }
        },
    };
}
export function useBoardTests(options: Options) {
    const [simulated, setSimulated] = useState(false);
    const [simulation, setSimulation] = useState(() => ({
        fault: false,
        generation: 0,
        transport: createSimulation(),
    }));
    const device = useTestSource({ ...options, simulated: false, enabled: !simulated });
    const demo = useTestSource({
        ...options,
        simulated: true,
        enabled: simulated,
        generation: simulation.generation,
        transport: simulation.transport,
    });
    const selected = simulated ? demo : device;
    const canSwitch = () =>
        !device.isBusy() &&
        !demo.isBusy() &&
        (selected.historical || selected.run?.phase !== 'review');
    return {
        ...selected,
        fault: simulation.fault,
        sourceLocked: !canSwitch(),
        setSimulation: (enabled: boolean) => {
            if (canSwitch()) setSimulated(enabled);
        },
        setFault: (fault: boolean) => {
            if (!simulated || !canSwitch()) return;
            setSimulation((previous) => ({
                fault,
                generation: previous.generation + 1,
                transport: createSimulation({ uartFault: fault }),
            }));
        },
    };
}
export type BoardTestsState = ReturnType<typeof useBoardTests>;

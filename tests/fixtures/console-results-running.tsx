import { createElement, createRef, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import StoredConsoleResults from '../../src/features/automation/capture/StoredConsoleResults';
import type { ConsoleResultsAdmission } from '../../src/features/automation/capture/use-console-results';

export function mountConsoleRunningRegression(holdInitial = false) {
    const previous = window.diagnosticHub;
    const element = document.createElement('div');
    document.body.append(element);
    let held: (() => void) | undefined;
    const admission = createRef<ConsoleResultsAdmission>();
    let resume: (() => void) | undefined, previousResume: (() => void) | undefined;
    const state = {
        lists: 0,
        busy: false,
        phase: 'initial',
        holdNext: holdInitial,
        quiescing: false,
        admitted: false,
        failure: '',
        setRunning: (_value: boolean) => {},
        release: () => held?.(),
        quiesce() {
            state.quiescing = true;
            state.admitted = false;
            void admission
                .current!.quiesce()
                .then((release) => {
                    previousResume = resume;
                    resume = release;
                    state.admitted = true;
                })
                .catch((error) => {
                    state.failure = String(error);
                });
        },
        resume: () => resume?.(),
        staleResume: () => previousResume?.(),
    };
    window.diagnosticHub = {
        consoleStorage: async (request: { op: string }) => {
            if (request.op !== 'list') throw Error('Unexpected catalog-only fixture operation');
            state.lists++;
            if (state.holdNext) {
                state.holdNext = false;
                await new Promise<void>((resolve) => (held = resolve));
                held = undefined;
            }
            return { ok: true, value: { captures: [], next: null, mode: 'scan' } };
        },
    } as unknown as typeof window.diagnosticHub;
    function View() {
        const [running, setRunning] = useState(false);
        state.setRunning = setRunning;
        useEffect(() => {
            state.phase = running ? 'running' : 'idle';
        }, [running]);
        return createElement(StoredConsoleResults, {
            visible: true,
            running,
            epoch: 0,
            headingRef: null,
            headerOffset: 0,
            onBusy: (value: boolean) => (state.busy = value),
            admissionRef: admission,
        });
    }
    const root = createRoot(element);
    root.render(createElement(View));
    return {
        state,
        async dispose() {
            state.release();
            root.unmount();
            const end = performance.now() + 2500;
            while (state.busy) {
                if (performance.now() >= end)
                    throw Error('Catalog fixture disposal did not settle');
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            if (previous) window.diagnosticHub = previous;
            else delete window.diagnosticHub;
            element.remove();
        },
    };
}

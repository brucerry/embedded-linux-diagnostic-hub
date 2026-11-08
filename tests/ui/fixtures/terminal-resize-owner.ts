import type { Page } from '@playwright/test';
import type { TerminalSize } from '../../../shared/terminal';

interface ResizeRequest extends TerminalSize {
    id: string;
}
interface ResizeOwnerState {
    calls: ResizeRequest[];
    held: ResizeRequest | null;
    pending: boolean;
    armed: boolean;
    rejected: number;
    staleAlertSeen: boolean;
    observationEvents: number;
    observing: boolean;
    arm(id: string, baseline: TerminalSize): void;
    rejectHeld(): void;
    observeAlerts(): void;
    stopObserving(): void;
}
declare global {
    interface Window {
        terminalResizeOwnerTest: ResizeOwnerState;
    }
}

// Install after navigation on the public fake desktop bridge, never on Page/React callbacks.
export async function installTerminalResizeOwner(page: Page) {
    await page.evaluate(() => {
        const bridge = window.diagnosticHub;
        if (!bridge?.resizeTerminal || !window.desktopTest.terminal)
            throw Error('Missing fresh desktop terminal fixture.');
        if (Object.hasOwn(window, 'terminalResizeOwnerTest'))
            throw Error('Resize owner fixture already installed.');
        const original = bridge.resizeTerminal.bind(bridge);
        let reject: ((reason: Error) => void) | undefined;
        let holdId = '',
            baseline: TerminalSize | undefined,
            armedOnce = false;
        let observer: MutationObserver | undefined;
        const validate = (id: string, size: TerminalSize) => {
            if (
                !/^[A-Za-z0-9_-]{16,64}$/.test(id) ||
                !Number.isInteger(size.cols) ||
                size.cols < 2 ||
                size.cols > 500 ||
                !Number.isInteger(size.rows) ||
                size.rows < 1 ||
                size.rows > 300
            )
                throw Error('Invalid synthetic resize identity or dimensions.');
        };
        const state: ResizeOwnerState = {
            calls: [],
            held: null,
            pending: false,
            armed: false,
            rejected: 0,
            staleAlertSeen: false,
            observationEvents: 0,
            observing: false,
            arm(id, size) {
                validate(id, size);
                if (armedOnce || state.pending || id !== window.desktopTest.terminal!.id)
                    throw Error('Resize gate must arm once for the current terminal.');
                armedOnce = true;
                holdId = id;
                baseline = { ...size };
                state.armed = true;
            },
            rejectHeld() {
                if (!reject || !state.pending || state.rejected !== 0)
                    throw Error('No single owned resize rejection is available.');
                const owned = reject;
                reject = undefined;
                state.pending = false;
                state.rejected++;
                owned(Error('Synthetic old resize acknowledgement rejected.'));
            },
            observeAlerts() {
                if (observer) throw Error('Alert observation already installed.');
                const root = document.querySelector('[aria-label="Connected device terminal"]');
                if (!root) throw Error('Missing visible terminal panel.');
                const observe = () => {
                    // Retain only classification/counters, never DOM text, history or credentials.
                    state.observationEvents = Math.min(64, state.observationEvents + 1);
                    if (
                        root.querySelector('.terminal-error')?.textContent?.trim() ===
                        'Terminal resizing failed. Reconnect the device to retry.'
                    )
                        state.staleAlertSeen = true;
                };
                observer = new MutationObserver(observe);
                observer.observe(root, { childList: true, subtree: true, characterData: true });
                state.observing = true;
                observe();
            },
            stopObserving() {
                if (!observer || !state.observing) throw Error('No owned alert observation.');
                observer.disconnect();
                state.observing = false;
            },
        };
        window.terminalResizeOwnerTest = state;
        bridge.resizeTerminal = (id, size) => {
            validate(id, size);
            if (state.calls.length >= 32) throw Error('Synthetic resize request bound exceeded.');
            state.calls.push({ id, cols: size.cols, rows: size.rows });
            if (
                holdId === id &&
                baseline &&
                (baseline.cols !== size.cols || baseline.rows !== size.rows)
            ) {
                if (state.pending || state.held) throw Error('Duplicate held resize.');
                holdId = '';
                state.armed = false;
                state.held = { id, ...size };
                state.pending = true;
                return new Promise<void>((_resolve, no) => {
                    reject = no;
                });
            }
            return original(id, size);
        };
    });
}

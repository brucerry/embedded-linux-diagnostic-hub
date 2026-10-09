import type { Page } from '@playwright/test';
import type { Snapshot, UpdateRecovery, UpdateRequest } from '../../../shared/types';
import { demoSnapshot } from '../../fixtures/snapshots';
import type { TerminalEvent } from '../../../shared/terminal';
import {
    parseDeviceClock,
    type DeviceClockResponse,
} from '../../../shared/diagnostics/device-clock';
import { clockOutput } from '../../fixtures/device-clock';

export interface DesktopTestState {
    requests: UpdateRequest[];
    connects: number;
    disconnects: number;
    collects: number;
    releasesOpened: number;
    acknowledgements: string[];
    clipboard?: string;
    releaseCollection?: () => void;
    holdNextCollection?: boolean;
    closeConnection?: () => void;
    clock: {
        calls: number;
        response: DeviceClockResponse;
        fail: boolean;
        hold: boolean;
        release?: () => void;
    };
    snapshot?: Snapshot;
    terminal?: {
        id: string;
        opens: number;
        closes: number;
        inputs: string[];
        sizes: { cols: number; rows: number }[];
        emit(data: string): Promise<void>;
        end(state?: 'closed' | 'error', id?: string): Promise<void>;
        refuseNextOpen?: boolean;
    };
}

declare global {
    interface Window {
        desktopTest: DesktopTestState;
    }
}

export async function installDesktop(page: Page, recovery: UpdateRecovery | null = null) {
    await page.addInitScript(
        ({ snapshot, recovery, clockSample }) => {
            window.desktopTest = {
                requests: [],
                connects: 0,
                disconnects: 0,
                collects: 0,
                releasesOpened: 0,
                acknowledgements: [],
                clock: {
                    calls: 0,
                    response: { status: 'available', sample: clockSample },
                    fail: false,
                    hold: false,
                },
                snapshot,
            };
            let closed: ((reason?: 'update') => void) | undefined;
            let terminalListener: ((event: TerminalEvent) => void | Promise<void>) | undefined;
            let terminalSequence = 0;
            window.desktopTest.terminal = {
                id: '',
                opens: 0,
                closes: 0,
                inputs: [],
                sizes: [],
                end: async (state = 'closed', id = window.desktopTest.terminal!.id) => {
                    const terminal = window.desktopTest.terminal!;
                    if (id === terminal.id) {
                        terminal.id = '';
                        terminal.closes++;
                    }
                    await terminalListener?.({ id, type: 'state', state });
                },
                emit: async (data) => {
                    const encoded = btoa(
                        Array.from(new TextEncoder().encode(data), (byte) =>
                            String.fromCharCode(byte),
                        ).join(''),
                    );
                    await terminalListener?.({
                        id: window.desktopTest.terminal!.id,
                        type: 'data',
                        sequence: ++terminalSequence,
                        data: encoded,
                    });
                },
            };
            window.desktopTest.closeConnection = () => closed?.();
            window.diagnosticHub = {
                openTerminal: async (request) => {
                    const terminal = window.desktopTest.terminal!;
                    terminal.id = request.id;
                    terminal.opens++;
                    if (terminal.refuseNextOpen) {
                        terminal.refuseNextOpen = false;
                        throw Error('The device refused the terminal.');
                    }
                    terminal.sizes.push(request);
                    await terminalListener?.({ id: request.id, type: 'state', state: 'open' });
                    await terminal.emit('/home/engineer $ ');
                },
                writeTerminal: async (id, data) => {
                    const terminal = window.desktopTest.terminal!;
                    if (id !== terminal.id) throw Error('stale terminal');
                    const text = new TextDecoder().decode(
                        Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
                    );
                    terminal.inputs.push(text);
                    await terminal.emit(text);
                },
                resizeTerminal: async (_id, size) => {
                    window.desktopTest.terminal!.sizes.push(size);
                },
                closeTerminal: async (id) => {
                    const terminal = window.desktopTest.terminal!;
                    if (terminal.id !== id) return;
                    terminal.id = '';
                    terminal.closes++;
                    await terminalListener?.({ id, type: 'state', state: 'closed' });
                },
                acknowledgeTerminal: async () => {},
                onTerminalEvent: (callback) => {
                    terminalListener = callback;
                    return () => {
                        terminalListener = undefined;
                    };
                },
                checkUpdates: async (include) => ({
                    currentVersion: '0.2.0-rc.1',
                    installable: true,
                    release: {
                        version: include ? '0.3.0-rc.1' : '0.3.0',
                        prerelease: include,
                        publishedAt: '',
                        notes: 'New diagnostics.',
                    },
                }),
                startUpdate: async (request) => {
                    window.desktopTest.requests.push(request);
                    window.desktopTest.disconnects++;
                    closed?.('update');
                },
                readUpdateReport: async () => recovery,
                acknowledgeUpdateReport: async (id) => {
                    window.desktopTest.acknowledgements.push(id);
                },
                clearSessionData: async () => {},
                connect: async () => {
                    window.desktopTest.connects++;
                },
                disconnect: async () => {
                    window.desktopTest.disconnects++;
                },
                collect: async () => {
                    window.desktopTest.collects++;
                    if (window.desktopTest.holdNextCollection) {
                        window.desktopTest.holdNextCollection = false;
                        await new Promise<void>((resolve) => {
                            window.desktopTest.releaseCollection = resolve;
                        });
                    }
                    return {
                        ...window.desktopTest.snapshot!,
                        capturedAt: new Date().toISOString(),
                    };
                },
                readDeviceClock: async () => {
                    const clock = window.desktopTest.clock;
                    clock.calls++;
                    const response = structuredClone(clock.response);
                    if (clock.hold) {
                        clock.hold = false;
                        await new Promise<void>((resolve) => {
                            clock.release = resolve;
                        });
                    }
                    if (clock.fail) throw Error('Clock read failed.');
                    return response;
                },
                pickKey: async () => null,
                copyText: async (text) => {
                    window.desktopTest.clipboard = text;
                },
                readClipboard: async () => window.desktopTest.clipboard ?? '',
                openRepository: async () => {},
                openReleases: async () => {
                    window.desktopTest.releasesOpened++;
                },
                exportReport: async () => true,
                onDisconnected: (callback) => {
                    closed = callback;
                    return () => {
                        closed = undefined;
                    };
                },
            };
        },
        {
            snapshot: { ...demoSnapshot(), mode: 'ssh' as const } as Snapshot,
            recovery,
            clockSample: parseDeviceClock(clockOutput()),
        },
    );
}

import type { Page } from '@playwright/test';
import type { Snapshot, UpdateRecovery, UpdateRequest } from '../../../shared/types';
import { demoSnapshot } from '../../fixtures/snapshots';

export interface DesktopTestState {
    requests: UpdateRequest[];
    connects: number;
    disconnects: number;
    collects: number;
    releasesOpened: number;
    acknowledgements: string[];
    releaseCollection?: () => void;
    holdNextCollection?: boolean;
    closeConnection?: () => void;
}

declare global {
    interface Window {
        desktopTest: DesktopTestState;
    }
}

export async function installDesktop(page: Page, recovery: UpdateRecovery | null = null) {
    await page.addInitScript(
        ({ snapshot, recovery }) => {
            window.desktopTest = {
                requests: [],
                connects: 0,
                disconnects: 0,
                collects: 0,
                releasesOpened: 0,
                acknowledgements: [],
            };
            let closed: ((reason?: 'update') => void) | undefined;
            window.desktopTest.closeConnection = () => closed?.();
            window.diagnosticHub = {
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
                    return { ...snapshot, capturedAt: new Date().toISOString() };
                },
                pickKey: async () => null,
                copyText: async () => {},
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
        { snapshot: { ...demoSnapshot(), mode: 'ssh' as const } as Snapshot, recovery },
    );
}

import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { HISTORY_LIMIT, type HistoryFrame } from '../../shared/diagnostics/presentation';
import { createReport, MAX_REPORT_BYTES, parseReport } from '../../shared/report';
import type {
    ConnectOptions,
    HostKeyVerification,
    Snapshot,
    UpdateRecovery,
} from '../../shared/types';
import { GatewayClient, type GatewaySettings } from '../services/GatewayClient';
import { prepareHistory } from '../services/history';

import { message } from '../services/errors';
import { ConnectionOperation } from '../services/connection-operation';

// Own the shared desktop/web session lifecycle and in-memory evidence.
export function useDeviceSession(onResetView: () => void) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [workspaceReady, setWorkspaceReady] = useState(false);
    const [connected, setConnected] = useState(false);
    const [activeDevice, setActiveDevice] = useState<{
        username: string;
        endpoint: string;
        generation: number;
    } | null>(null);
    const [terminalReset, setTerminalReset] = useState(0);
    const [clockReset, setClockReset] = useState(0);
    const connectedRef = useRef(false);
    connectedRef.current = connected;
    const [live, setLiveState] = useState(true);
    // Remember the user selection independently of temporary error/update pauses.
    const livePreference = useRef(true);
    const liveRef = useRef(true);
    liveRef.current = live;
    const [interval, setInterval] = useState(30);
    const [history, setHistory] = useState<HistoryFrame[]>([]);
    const previousFrame = useRef<HistoryFrame | undefined>(undefined);
    const connectionGeneration = useRef(0);
    const collectingRef = useRef(false);
    const dataGeneration = useRef(0);
    const idleWaiters = useRef(new Set<() => void>());
    const resettingRef = useRef(false);
    const [resetting, setResetting] = useState(false);
    const [resetProgress, setResetProgress] = useState('');
    const [updateReport, setUpdateReport] = useState<UpdateRecovery | null>(null);
    const [busy, setBusy] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [connectionProgress, setConnectionProgress] = useState('');
    const connectionOperation = useRef<ConnectionOperation | null>(null);
    if (!connectionOperation.current) connectionOperation.current = new ConnectionOperation();
    useEffect(
        () => () => {
            dataGeneration.current++;
            void connectionOperation.current?.cancel().catch(() => {});
        },
        [],
    );
    const [disconnecting, setDisconnecting] = useState(false);
    const disconnectingRef = useRef(false);
    const [showConnect, setShowConnect] = useState(false);
    const [hostVerification, setHostVerification] = useState<HostKeyVerification | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [imported, setImported] = useState(false);
    const [gateway, setGateway] = useState<GatewayClient | null>(null);
    const importInput = useRef<HTMLInputElement>(null);
    const bridge = window.diagnosticHub;
    const transport = bridge ?? gateway;

    useEffect(() => {
        if (!bridge) return;
        let cancelled = false;
        const generation = dataGeneration.current;
        void (async () => {
            try {
                const recovery = await bridge.readUpdateReport();
                if (cancelled || !recovery) return;
                if (generation !== dataGeneration.current) {
                    await bridge.acknowledgeUpdateReport(recovery.id);
                    return;
                }
                setUpdateReport(recovery);
                setConnected(false);
                setLiveState(false);
                if (recovery.mode === 'smart' && recovery.snapshot) {
                    setWorkspaceReady(true);
                    setSnapshot(recovery.snapshot);
                    setImported(true);
                    setHistory([]);
                    setNotice(
                        `Update complete · report reopened locally. Backup: ${recovery.reportPath}`,
                    );
                } else {
                    setNotice(`Update complete · report saved: ${recovery.reportPath}`);
                }
                await bridge.acknowledgeUpdateReport(recovery.id);
            } catch (err) {
                if (!cancelled)
                    setError(`Could not reopen the saved update report: ${message(err)}`);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [bridge]);

    useEffect(() => bridge?.onHostKeyVerification?.(setHostVerification), [bridge]);
    useEffect(
        () =>
            transport?.onDisconnected((reason?: 'update') => {
                const wasConnected = connectedRef.current;
                setActiveDevice(null);
                connectedRef.current = false;
                if (reason === 'update') {
                    setConnected(false);
                    pauseLiveUpdates();
                    setError('');
                    return;
                }
                if (!wasConnected || disconnectingRef.current) return;
                setConnected(false);
                setError('SSH closed unexpectedly. Reconnect to resume updates.');
                void transport.disconnect().catch(() => {});
            }),
        [transport, connected],
    );
    useEffect(() => {
        if (!live || !connected || imported || busy || connecting || resetting || showConnect)
            return;
        const timer = setTimeout(() => {
            void refresh(true);
        }, interval * 1000);
        return () => clearTimeout(timer);
    }, [
        live,
        connected,
        imported,
        busy,
        connecting,
        resetting,
        showConnect,
        interval,
        snapshot,
        transport,
    ]);
    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(''), 4500);
        return () => clearTimeout(timer);
    }, [notice]);

    function setLive(value: SetStateAction<boolean>) {
        const next = typeof value === 'function' ? value(liveRef.current) : value;
        livePreference.current = next;
        liveRef.current = next;
        setLiveState(next);
    }

    function pauseLiveUpdates() {
        liveRef.current = false;
        setLiveState(false);
    }

    async function retainSnapshot(data: Snapshot, previous?: HistoryFrame) {
        const frame = {
            ...(await prepareHistory(data, previous)),
            source: data.endpoint,
            connection: connectionGeneration.current,
        };
        previousFrame.current = frame;
        setWorkspaceReady(true);
        setSnapshot(data);
        setHistory((retained) => [...retained, frame].slice(-HISTORY_LIMIT));
    }

    async function refresh(
        automatic = false,
        options?: import('../../shared/diagnostics/network/evidence').CollectOptions,
    ): Promise<boolean> {
        if (
            resettingRef.current ||
            collectingRef.current ||
            disconnectingRef.current ||
            (!automatic && live)
        )
            return false;
        const generation = dataGeneration.current;
        collectingRef.current = true;
        setBusy(true);
        setError('');
        try {
            if (transport && connected && !imported) {
                const data = await transport.collect(options);
                await retainSnapshot(data, previousFrame.current);
            } else throw new Error('Reconnect to collect a new snapshot.');
            if (!automatic) setNotice('Device snapshot collected');
            return generation === dataGeneration.current;
        } catch (err) {
            liveRef.current = false;
            setLiveState(false);
            setError(`${message(err)} Live updates paused; the last snapshot is retained.`);
            return false;
        } finally {
            collectingRef.current = false;
            setBusy(false);
            idleWaiters.current.forEach((resolve) => resolve());
            idleWaiters.current.clear();
        }
    }

    async function connect(options: ConnectOptions, settings?: GatewaySettings) {
        if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;
        collectingRef.current = true;
        const generation = ++dataGeneration.current;
        setConnecting(true);
        setConnectionProgress('');
        setActiveDevice(null);
        setError('');
        try {
            connectedRef.current = false;
            if (connected && transport) await transport.disconnect();
            setConnected(false);
            const active = bridge ?? (settings ? new GatewayClient(settings) : null);
            if (!active) throw new Error('Enter your gateway address and access token.');
            if (active instanceof GatewayClient) setGateway(active);
            const authenticated = await connectionOperation.current!.connect(
                active,
                options,
                (progress) => {
                    if (generation === dataGeneration.current)
                        setConnectionProgress(progress.message);
                },
            );
            options.password = undefined;
            options.passphrase = undefined;
            options.privateKey = undefined;
            if (!authenticated || generation !== dataGeneration.current) return;
            connectedRef.current = true;
            setConnected(true);
            connectionGeneration.current++;
            setActiveDevice({
                username: options.username,
                endpoint: `${options.host}:${options.port}`,
                generation: connectionGeneration.current,
            });
            setImported(false);
            setUpdateReport(null);
            setConnecting(false);
            setWorkspaceReady(true);
            setBusy(true);
            onResetView();
            try {
                const data = await active.collect();
                if (generation !== dataGeneration.current) return;
                await retainSnapshot(data);
                liveRef.current = livePreference.current;
                setLiveState(livePreference.current);
                setNotice('SSH connected — diagnostic snapshot collected');
            } catch (err) {
                if (generation === dataGeneration.current) {
                    pauseLiveUpdates();
                    setError(
                        `SSH is connected, but diagnostic collection failed: ${message(err)} The last snapshot is retained; collect again when ready.`,
                    );
                }
            } finally {
                if (generation === dataGeneration.current) setShowConnect(false);
            }
        } catch (err) {
            if (generation === dataGeneration.current) setError(message(err));
        } finally {
            options.password = undefined;
            options.passphrase = undefined;
            options.privateKey = undefined;
            collectingRef.current = false;
            setConnecting(false);
            setBusy(false);
            idleWaiters.current.forEach((resolve) => resolve());
            idleWaiters.current.clear();
        }
    }

    async function cancelConnection() {
        if (!connectionOperation.current!.running) {
            setShowConnect(false);
            return;
        }
        dataGeneration.current++;
        try {
            await connectionOperation.current!.cancel();
            setConnectionProgress('');
            setShowConnect(false);
        } catch (err) {
            setError(message(err));
        }
    }

    async function disconnect() {
        if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;
        disconnectingRef.current = true;
        setDisconnecting(true);
        try {
            await transport?.disconnect();
            setNotice('Disconnected · last SSH snapshot retained');
        } catch (err) {
            setError(message(err));
        } finally {
            setConnected(false);
            setActiveDevice(null);
            setGateway(null);
            disconnectingRef.current = false;
            setDisconnecting(false);
        }
    }

    async function resetData() {
        if (resettingRef.current || connecting || disconnectingRef.current) return;
        resettingRef.current = true;
        dataGeneration.current++;
        const started = performance.now();
        setResetting(true);
        setResetProgress(
            collectingRef.current
                ? 'Waiting for the current collection to finish…'
                : 'Clearing the snapshot and graph history…',
        );
        const resume = live && connected && !imported;
        try {
            if (collectingRef.current)
                await new Promise<void>((resolve) => idleWaiters.current.add(resolve));
            setResetProgress('Clearing the snapshot and graph history…');
            await transport?.clearSessionData();
            setWorkspaceReady(true);
            setSnapshot(null);
            previousFrame.current = undefined;
            setHistory([]);
            setTerminalReset((value) => value + 1);
            setImported(false);
            if (!resume || liveRef.current) setError('');
            setUpdateReport(null);
            // Keep the existing page layout beneath the cover while collecting the first
            // sample. Both the old snapshot and numeric history have already been cleared.
            if (resume && connectedRef.current && liveRef.current && transport) {
                setResetProgress('Collecting the first snapshot of the fresh record…');
                collectingRef.current = true;
                setBusy(true);
                try {
                    const data = await transport.collect();
                    await retainSnapshot(data);
                } catch (err) {
                    liveRef.current = false;
                    setLiveState(false);
                    setError(`Session data cleared. ${message(err)} Live updates paused.`);
                } finally {
                    collectingRef.current = false;
                    setBusy(false);
                    idleWaiters.current.forEach((resolve) => resolve());
                    idleWaiters.current.clear();
                }
            }
            setNotice('Session data cleared from RAM · saved report files are unchanged');
        } catch (err) {
            setError(`Could not reset session data: ${message(err)}`);
        } finally {
            // Even a fast RAM-only reset must paint its cover instead of flashing a new page.
            const remaining = 300 - (performance.now() - started);
            if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
            resettingRef.current = false;
            setResetting(false);
            setResetProgress('');
            setClockReset((value) => value + 1);
        }
    }

    async function exportReport() {
        if (!snapshot) return;
        try {
            if (bridge) {
                if (await bridge.exportReport(snapshot)) setNotice('Diagnostic report saved');
            } else {
                const url = URL.createObjectURL(
                    new Blob([JSON.stringify(createReport(snapshot), null, 2)], {
                        type: 'application/json',
                    }),
                );
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `diagnostic-${snapshot.mode}-${new Date().toISOString().slice(0, 10)}.json`;
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setNotice('Diagnostic report downloaded');
            }
        } catch (err) {
            setError(message(err));
        }
    }

    async function importReport(file: File) {
        if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;
        setError('');
        const generation = dataGeneration.current;
        try {
            if (file.size > MAX_REPORT_BYTES)
                throw new Error('The report exceeds the 16 MiB import limit.');
            const data = parseReport(await file.text());
            const frame = await prepareHistory(data);
            if (generation !== dataGeneration.current) return;
            if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;
            if (connected && transport) await transport.disconnect();
            setConnected(false);
            setActiveDevice(null);
            setLiveState(false);
            previousFrame.current = undefined;
            const connection = ++connectionGeneration.current;
            setHistory((retained) =>
                [
                    ...retained,
                    {
                        ...frame,
                        source: data.endpoint,
                        connection,
                    },
                ].slice(-HISTORY_LIMIT),
            );
            setGateway(null);
            setWorkspaceReady(true);
            setSnapshot(data);
            setImported(true);
            setUpdateReport(null);
            onResetView();
            setNotice('Report opened locally · no device connection');
        } catch (err) {
            setError(message(err));
        } finally {
            if (importInput.current) importInput.current.value = '';
        }
    }

    return {
        activeDevice,
        terminalReset,
        clockReset,
        transport,
        snapshot,
        workspaceReady,
        connected,
        live,
        setLive,
        pauseLiveUpdates,
        interval,
        setInterval,
        history,
        busy,
        connecting,
        connectionProgress,
        disconnecting,
        resetting,
        resetProgress,
        updateReport,
        showConnect,
        setShowConnect,
        hostVerification,
        error,
        setError,
        notice,
        imported,
        importInput,
        bridge,
        refresh,
        refreshCapabilities: () => refresh(true, { forceNetworkCapabilities: true }),
        connect,
        cancelConnection,
        disconnect,
        resetData,
        exportReport,
        importReport,
    };
}

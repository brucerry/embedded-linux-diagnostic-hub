import { useEffect, useRef, useState } from 'react';
import {
    HISTORY_LIMIT,
    historyFrame,
    type HistoryFrame,
} from '../../shared/diagnostics/presentation';
import { createReport, MAX_REPORT_BYTES, parseReport } from '../../shared/report';
import type { ConnectOptions, HostKeyVerification, Snapshot } from '../../shared/types';
import { GatewayClient, type GatewaySettings } from '../services/GatewayClient';

import { message } from '../services/errors';

// Own the shared desktop/web session lifecycle and in-memory evidence.
export function useDeviceSession(onResetView: () => void) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [connected, setConnected] = useState(false);
    const [live, setLive] = useState(true);
    const [interval, setInterval] = useState(30);
    const [history, setHistory] = useState<HistoryFrame[]>([]);
    const collectingRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [connecting, setConnecting] = useState(false);
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

    useEffect(() => bridge?.onHostKeyVerification?.(setHostVerification), [bridge]);
    useEffect(
        () =>
            transport?.onDisconnected(() => {
                if (!connected) return;
                setConnected(false);
                setLive(false);
                setError('SSH closed unexpectedly. Reconnect to resume updates.');
                void transport.disconnect().catch(() => {});
            }),
        [transport, connected],
    );
    useEffect(() => {
        if (!live || !connected || imported || busy || connecting || showConnect) return;
        const timer = setTimeout(() => {
            void refresh(true);
        }, interval * 1000);
        return () => clearTimeout(timer);
    }, [live, connected, imported, busy, connecting, showConnect, interval, snapshot, transport]);
    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(''), 4500);
        return () => clearTimeout(timer);
    }, [notice]);

    async function refresh(automatic = false) {
        if (collectingRef.current || disconnectingRef.current || (!automatic && live)) return;
        collectingRef.current = true;
        setBusy(true);
        setError('');
        try {
            if (transport && connected && !imported) {
                const data = await transport.collect();
                setSnapshot(data);
                setHistory((previous) =>
                    [...previous, historyFrame(data, previous.at(-1))].slice(-HISTORY_LIMIT),
                );
            } else throw new Error('Reconnect to collect a new snapshot.');
            if (!automatic) setNotice('Device snapshot collected');
        } catch (err) {
            setLive(false);
            setError(`${message(err)} Live updates paused; the last snapshot is retained.`);
        } finally {
            collectingRef.current = false;
            setBusy(false);
        }
    }

    async function connect(options: ConnectOptions, settings?: GatewaySettings) {
        if (collectingRef.current || disconnectingRef.current) return;
        collectingRef.current = true;
        setConnecting(true);
        setError('');
        try {
            if (connected && transport) await transport.disconnect();
            setConnected(false);
            const active = bridge ?? (settings ? new GatewayClient(settings) : null);
            if (!active) throw new Error('Enter your gateway address and access token.');
            if (active instanceof GatewayClient) setGateway(active);
            await active.connect(options);
            setConnected(true);
            try {
                const data = await active.collect();
                setSnapshot(data);
                setHistory([historyFrame(data)]);
                setImported(false);
                setShowConnect(false);
                onResetView();
                setNotice('SSH connected · diagnostic snapshot collected');
            } catch (err) {
                await active.disconnect().catch(() => {});
                setConnected(false);
                throw err;
            }
        } catch (err) {
            setError(message(err));
        } finally {
            collectingRef.current = false;
            setConnecting(false);
        }
    }

    async function disconnect() {
        if (collectingRef.current || disconnectingRef.current) return;
        disconnectingRef.current = true;
        setDisconnecting(true);
        try {
            await transport?.disconnect();
            setNotice('Disconnected · last SSH snapshot retained');
        } catch (err) {
            setError(message(err));
        } finally {
            setConnected(false);
            setLive(false);
            setGateway(null);
            disconnectingRef.current = false;
            setDisconnecting(false);
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
        if (collectingRef.current || disconnectingRef.current) return;
        setError('');
        try {
            if (file.size > MAX_REPORT_BYTES)
                throw new Error('The report exceeds the 16 MiB import limit.');
            const data = parseReport(await file.text());
            if (collectingRef.current || disconnectingRef.current) return;
            if (connected && transport) await transport.disconnect();
            setConnected(false);
            setLive(false);
            setHistory([]);
            setGateway(null);
            setSnapshot(data);
            setImported(true);
            onResetView();
            setNotice('Report opened locally · no device connection');
        } catch (err) {
            setError(message(err));
        } finally {
            if (importInput.current) importInput.current.value = '';
        }
    }

    return {
        snapshot,
        connected,
        live,
        setLive,
        interval,
        setInterval,
        history,
        busy,
        connecting,
        disconnecting,
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
        connect,
        disconnect,
        exportReport,
        importReport,
    };
}

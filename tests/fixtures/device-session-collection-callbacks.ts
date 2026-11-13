// Verbatim active hook callbacks bound to explicit memory-only desktop IO.
import { message } from '../../src/services/errors';
import type { ConnectOptions } from '../../shared/types';
import type { GatewaySettings } from '../../src/services/GatewayClient';
export const spans = [
    "    async function connect(options: ConnectOptions, settings?: GatewaySettings) {\n        if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;\n        collectingRef.current = true;\n        const generation = ++dataGeneration.current;\n        setConnecting(true);\n        setConnectionProgress('');\n        setError('');\n        try {\n            if (connected && transport)\n                await (transport instanceof GatewayClient\n                    ? transport.disconnect(true)\n                    : transport.disconnect());\n            connectedRef.current = false;\n            setActiveDevice(null);\n            setConnected(false);\n            const active = bridge ?? (settings ? new GatewayClient(settings) : null);\n            if (!active) throw new Error('Enter your gateway address and access token.');\n            if (active instanceof GatewayClient) setGateway(active);\n            const authenticated = await connectionOperation.current!.connect(\n                active,\n                options,\n                (progress) => {\n                    if (generation === dataGeneration.current)\n                        setConnectionProgress(progress.message);\n                },\n            );\n            options.password = undefined;\n            options.passphrase = undefined;\n            options.privateKey = undefined;\n            if (!authenticated || generation !== dataGeneration.current) return;\n            connectedRef.current = true;\n            setConnected(true);\n            connectionGeneration.current++;\n            setActiveDevice({\n                username: options.username,\n                endpoint: `${options.host}:${options.port}`,\n                generation: connectionGeneration.current,\n            });\n            setImported(false);\n            setUpdateReport(null);\n            setConnecting(false);\n            setWorkspaceReady(true);\n            setBusy(true);\n            onResetView();\n            try {\n                const data = await active.collect();\n                if (generation !== dataGeneration.current) return;\n                await retainSnapshot(data);\n                liveRef.current = livePreference.current;\n                setLiveState(livePreference.current);\n                setNotice(\n                    connectedRef.current\n                        ? 'SSH connected \u2014 diagnostic snapshot collected'\n                        : 'Diagnostic snapshot collected; SSH is disconnected.',\n                );\n            } catch (err) {\n                if (generation === dataGeneration.current) {\n                    pauseLiveUpdates();\n                    const stillConnected = connectedRef.current;\n                    setError(\n                        (stillConnected\n                            ? 'SSH is connected, but diagnostic collection failed: '\n                            : 'SSH disconnected before diagnostic collection completed: ') +\n                            message(err) +\n                            ' The previous snapshot, if any, is unchanged; ' +\n                            (stillConnected\n                                ? 'collect again when ready.'\n                                : 'reconnect to collect again.'),\n                    );\n                }\n            } finally {\n                if (generation === dataGeneration.current) setShowConnect(false);\n            }\n        } catch (err) {\n            if (generation === dataGeneration.current) setError(message(err));\n        } finally {\n            options.password = undefined;\n            options.passphrase = undefined;\n            options.privateKey = undefined;\n            collectingRef.current = false;\n            setConnecting(false);\n            setBusy(false);\n            idleWaiters.current.forEach((resolve) => resolve());\n            idleWaiters.current.clear();\n        }\n    }\n\n",
    "(reason?: 'update') => {\n                const wasConnected = connectedRef.current;\n                setActiveDevice(null);\n                connectedRef.current = false;\n                setConnected(false);\n                if (reason === 'update') {\n                    pauseLiveUpdates();\n                    setError('');\n                    return;\n                }\n                if (!wasConnected || disconnectingRef.current) return;\n                setError('SSH closed unexpectedly. Reconnect to resume updates.');\n                void transport.disconnect().catch(() => {});\n            }",
    '    function pauseLiveUpdates() {\n        liveRef.current = false;\n        setLiveState(false);\n    }\n\n',
];
export const disposalSpan =
    '            dataGeneration.current++;\n            void connectionOperation.current?.cancel().catch(() => {});';
export function bind(context: {
    [key: string]: any;
    connectionOperation: {
        current: import('../../src/services/connection-operation').ConnectionOperation | null;
    };
    idleWaiters: { current: Set<() => void> };
}) {
    const {
        resettingRef,
        collectingRef,
        disconnectingRef,
        dataGeneration,
        setConnecting,
        setConnectionProgress,
        setActiveDevice,
        setError,
        connectedRef,
        connected,
        transport,
        setConnected,
        bridge,
        setGateway,
        connectionOperation,
        connectionGeneration,
        setImported,
        setUpdateReport,
        setWorkspaceReady,
        setBusy,
        onResetView,
        retainSnapshot,
        liveRef,
        livePreference,
        setLiveState,
        setNotice,
        setShowConnect,
        idleWaiters,
    } = context;
    class GatewayClient {
        constructor(_settings: unknown) {
            throw Error('Gateway construction is outside this desktop memory test');
        }
        disconnect(_forReplacement?: boolean): Promise<void> {
            throw Error('Gateway disconnect is outside this desktop memory test');
        }
    }
    function pauseLiveUpdates() {
        liveRef.current = false;
        setLiveState(false);
    }

    async function connect(options: ConnectOptions, settings?: GatewaySettings) {
        if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;
        collectingRef.current = true;
        const generation = ++dataGeneration.current;
        setConnecting(true);
        setConnectionProgress('');
        setError('');
        try {
            if (connected && transport)
                await (transport instanceof GatewayClient
                    ? transport.disconnect(true)
                    : transport.disconnect());
            connectedRef.current = false;
            setActiveDevice(null);
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
                setNotice(
                    connectedRef.current
                        ? 'SSH connected — diagnostic snapshot collected'
                        : 'Diagnostic snapshot collected; SSH is disconnected.',
                );
            } catch (err) {
                if (generation === dataGeneration.current) {
                    pauseLiveUpdates();
                    const stillConnected = connectedRef.current;
                    setError(
                        (stillConnected
                            ? 'SSH is connected, but diagnostic collection failed: '
                            : 'SSH disconnected before diagnostic collection completed: ') +
                            message(err) +
                            ' The previous snapshot, if any, is unchanged; ' +
                            (stillConnected
                                ? 'collect again when ready.'
                                : 'reconnect to collect again.'),
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

    const unsubscribe = transport?.onDisconnected((reason?: 'update') => {
        const wasConnected = connectedRef.current;
        setActiveDevice(null);
        connectedRef.current = false;
        setConnected(false);
        if (reason === 'update') {
            pauseLiveUpdates();
            setError('');
            return;
        }
        if (!wasConnected || disconnectingRef.current) return;
        setError('SSH closed unexpectedly. Reconnect to resume updates.');
        void transport.disconnect().catch(() => {});
    });
    return {
        connect,
        unsubscribe,
        dispose: () => {
            dataGeneration.current++;
            void connectionOperation.current?.cancel().catch(() => {});
        },
    };
}

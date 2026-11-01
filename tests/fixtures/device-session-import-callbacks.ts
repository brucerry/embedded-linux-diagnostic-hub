import {GatewayClient} from "../../src/services/GatewayClient";
import {parseReport,MAX_REPORT_BYTES} from "../../shared/report";
import {message} from "../../src/services/errors";
import {HISTORY_LIMIT,type HistoryFrame} from "../../shared/diagnostics/presentation";
export const importSpan="    async function importReport(file: File) {\n        if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;\n        setError('');\n        const generation = ++dataGeneration.current;\n        let ownsDisconnect = false;\n        try {\n            if (file.size > MAX_REPORT_BYTES)\n                throw new Error('The report exceeds the 16 MiB import limit.');\n            const data = parseReport(await file.text());\n            const frame = await prepareHistory(data);\n            if (generation !== dataGeneration.current) return;\n            if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;\n            if (connected && transport) {\n                disconnectingRef.current = true;\n                ownsDisconnect = true;\n                setDisconnecting(true);\n                await transport.disconnect();\n            }\n            if (generation !== dataGeneration.current) return;\n            if (resettingRef.current || collectingRef.current) return;\n            setConnected(false);\n            setActiveDevice(null);\n            setLiveState(false);\n            previousFrame.current = undefined;\n            const connection = ++connectionGeneration.current;\n            setHistory((retained) =>\n                [\n                    ...retained,\n                    {\n                        ...frame,\n                        source: data.endpoint,\n                        connection,\n                    },\n                ].slice(-HISTORY_LIMIT),\n            );\n            setGateway(null);\n            setWorkspaceReady(true);\n            setSnapshot(data);\n            setImported(true);\n            setUpdateReport(null);\n            onResetView();\n            setNotice('Report opened locally \u00b7 no device connection');\n        } catch (err) {\n            if (generation === dataGeneration.current) {\n                if (\n                    ownsDisconnect &&\n                    transport instanceof GatewayClient &&\n                    !transport.automationConnection()\n                ) {\n                    setConnected(false);\n                    setActiveDevice(null);\n                    setLiveState(false);\n                }\n                setError(message(err));\n            }\n        } finally {\n            if (ownsDisconnect) {\n                disconnectingRef.current = false;\n                setDisconnecting(false);\n            }\n            if (generation === dataGeneration.current && importInput.current)\n                importInput.current.value = '';\n        }\n    }\n";
export function bindImport(context:{[key:string]:any;setHistory:(f:(xs:HistoryFrame[])=>HistoryFrame[])=>void}){const {resettingRef,collectingRef,disconnectingRef,setError,dataGeneration,prepareHistory,connected,transport,setConnected,setActiveDevice,setLiveState,previousFrame,connectionGeneration,setHistory,setGateway,setWorkspaceReady,setSnapshot,setImported,setUpdateReport,onResetView,setNotice,importInput,setDisconnecting}=context;
    async function importReport(file: File) {
        if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;
        setError('');
        const generation = ++dataGeneration.current;
        let ownsDisconnect = false;
        try {
            if (file.size > MAX_REPORT_BYTES)
                throw new Error('The report exceeds the 16 MiB import limit.');
            const data = parseReport(await file.text());
            const frame = await prepareHistory(data);
            if (generation !== dataGeneration.current) return;
            if (resettingRef.current || collectingRef.current || disconnectingRef.current) return;
            if (connected && transport) {
                disconnectingRef.current = true;
                ownsDisconnect = true;
                setDisconnecting(true);
                await transport.disconnect();
            }
            if (generation !== dataGeneration.current) return;
            if (resettingRef.current || collectingRef.current) return;
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
            if (generation === dataGeneration.current) {
                if (
                    ownsDisconnect &&
                    transport instanceof GatewayClient &&
                    !transport.automationConnection()
                ) {
                    setConnected(false);
                    setActiveDevice(null);
                    setLiveState(false);
                }
                setError(message(err));
            }
        } finally {
            if (ownsDisconnect) {
                disconnectingRef.current = false;
                setDisconnecting(false);
            }
            if (generation === dataGeneration.current && importInput.current)
                importInput.current.value = '';
        }
    }

return importReport;
}

// Verbatim production callbacks/effect/projection, checked against source by memory tests.
// These bindings model state publication and refs; they do not mount React or prove painting.
import {validateDeviceClock,deviceRebooted} from '../../shared/diagnostics/device-clock';
import type {DeviceClockState} from '../../src/hooks/useDeviceClock';
import type {ClockCalibration} from '../../shared/automation';
type HeaderState = DeviceClockState & {generation?:number;reset?:number;transport?:unknown};
export const clockSpans=["        if (generation === undefined || !transport) {\n            retained.current = { sample: null };\n            setState({ status: 'disconnected', sample: null });\n            return;\n        }\n        if (blocked || !visible) return;\n        let disposed = false;\n        let unsupported = !transport.readDeviceClock;\n        let sample =\n            retained.current.transport === transport &&\n            retained.current.generation === generation &&\n            retained.current.reset === reset\n                ? retained.current.sample\n                : null;\n        const publish = (status: DeviceClockState['status']) => {\n            if (!disposed) {\n                retained.current = { sample, generation, reset, transport };\n                setState({ status, sample, generation, reset, transport });\n            }\n        };\n        const run = () => {\n            // Visibility events can precede React's effect cleanup and a due timer callback.\n            if (disposed || unsupported || reservation.current || document.visibilityState === 'hidden') return;\n            if (flight.current) {\n                queued.current = run;\n                return;\n            }\n            const requestedFreshness = freshness.current;\n            publish(sample ? 'stale' : 'loading');\n            const pending = (async () => {\n                try {\n                    const result = validateDeviceClock(await transport.readDeviceClock!());\n                    if (disposed) return;\n                    if (result.status === 'available') {\n                        // A boot change found by this read already carries the fresh device calendar.\n                        if (sample && deviceRebooted(sample, result.sample))\n                            observed.current = { generation, uptime: null };\n                        sample = result.sample;\n                        publish(\n                            requestedFreshness === freshness.current && !reservation.current\n                                ? 'current'\n                                : 'stale',\n                        );\n                    } else {\n                        unsupported = result.reason === 'unsupported';\n                        publish(sample ? 'stale' : 'unavailable');\n                    }\n                } catch {\n                    publish(sample ? 'stale' : 'unavailable');\n                }\n            })();\n            flight.current = pending;\n            void pending.finally(() => {\n                if (flight.current === pending) flight.current = null;\n                const next = queued.current;\n                queued.current = null;\n                next?.();\n            });\n        };\n        refresh.current = run;\n        publish(unsupported ? (sample ? 'stale' : 'unavailable') : sample ? 'stale' : 'loading');\n        run();\n        const timer = setInterval(run, 60_000);\n        return () => {\n            disposed = true;\n            clearInterval(timer);\n            if (refresh.current === run) refresh.current = null;\n            if (queued.current === run) queued.current = null;\n        };", "        const resume = () => {\n            if (document.visibilityState !== 'hidden') refresh.current?.();\n        };", "    const quiesce = async () => {\n        if (reservation.current) throw Error('Wait for the current clock reader admission.');\n        const token = Symbol('header clock admission');\n        reservation.current = token;\n        // A read begun before this admission cannot make the retained sample current.\n        freshness.current++;\n        setState((current) => ({ ...current, status: current.sample ? 'stale' : current.status }));\n        try {\n            await flight.current;\n        } catch (error) {\n            if (reservation.current === token) reservation.current = null;\n            throw error;\n        }\n        return () => {\n            if (reservation.current !== token) return;\n            reservation.current = null;\n            refresh.current?.();\n        };\n    };\n", "    const sample = async (active = props.transport): Promise<ClockCalibration> => {\n        if (transport !== 'ssh' || !active?.readDeviceClock || !active.automationConnection)\n            throw Error(\n                'Device clock: arbitrary Serial timestamp latency cannot establish a verified schedule. Use local time.',\n            );\n        const connection = active.automationConnection(),\n            local = Date.now(),\n            mono = performance.now(),\n            response = await active.readDeviceClock(connection),\n            elapsed = performance.now() - mono;\n        if (\n            response.status !== 'available' ||\n            response.sample.epochSeconds === null ||\n            response.sample.utcOffsetMinutes === null\n        )\n            throw Error('Device clock: target epoch/offset are unavailable.');\n        if (connection !== active.automationConnection())\n            throw Error('Device clock: connection changed.');\n        if (elapsed > 2000 || Math.abs(Date.now() - local - elapsed) > 1000)\n            throw Error('Device clock: sample uncertainty or clock drift is too large.');\n        return {\n            source: 'SSH fixed read-only clock sample (date)',\n            connection,\n            deviceEpochMs: response.sample.epochSeconds * 1000,\n            sampledLocalMs: local + elapsed / 2,\n            sampledMonoMs: mono + elapsed / 2,\n            uncertaintyMs: 1000 + elapsed / 2,\n            zone:\n                (response.sample.zone ?? 'offset') +\n                ' UTC' +\n                response.sample.utcOffsetMinutes +\n                ' minutes',\n        };\n    };\n"];
export const clockStateSpan="    if (generation === undefined || !transport) return { status: 'disconnected', sample: null, quiesce };\n    if (blocked || state.transport !== transport || state.generation !== generation || state.reset !== reset)\n        return { status: 'loading', sample: null, quiesce };\n    return {\n        ...state,\n        status: reservation.current ? (state.sample ? 'stale' : 'loading') : state.status,\n        quiesce,\n    };";
export function bindHeader(context:any){const {generation,transport,reset,blocked,visible,retained,flight,queued,refresh,observed,document,setInterval,clearInterval,reservation}=context;
const freshness=context.freshness??{current:0};
const setState:(next:HeaderState|((current:HeaderState)=>HeaderState))=>void=context.setState;
    const quiesce = async () => {
        if (reservation.current) throw Error('Wait for the current clock reader admission.');
        const token = Symbol('header clock admission');
        reservation.current = token;
        // A read begun before this admission cannot make the retained sample current.
        freshness.current++;
        setState((current) => ({ ...current, status: current.sample ? 'stale' : current.status }));
        try {
            await flight.current;
        } catch (error) {
            if (reservation.current === token) reservation.current = null;
            throw error;
        }
        return () => {
            if (reservation.current !== token) return;
            reservation.current = null;
            refresh.current?.();
        };
    };

const setup=()=>{
        if (generation === undefined || !transport) {
            retained.current = { sample: null };
            setState({ status: 'disconnected', sample: null });
            return;
        }
        if (blocked || !visible) return;
        let disposed = false;
        let unsupported = !transport.readDeviceClock;
        let sample =
            retained.current.transport === transport &&
            retained.current.generation === generation &&
            retained.current.reset === reset
                ? retained.current.sample
                : null;
        const publish = (status: DeviceClockState['status']) => {
            if (!disposed) {
                retained.current = { sample, generation, reset, transport };
                setState({ status, sample, generation, reset, transport });
            }
        };
        const run = () => {
            // Visibility events can precede React's effect cleanup and a due timer callback.
            if (disposed || unsupported || reservation.current || document.visibilityState === 'hidden') return;
            if (flight.current) {
                queued.current = run;
                return;
            }
            const requestedFreshness = freshness.current;
            publish(sample ? 'stale' : 'loading');
            const pending = (async () => {
                try {
                    const result = validateDeviceClock(await transport.readDeviceClock!());
                    if (disposed) return;
                    if (result.status === 'available') {
                        // A boot change found by this read already carries the fresh device calendar.
                        if (sample && deviceRebooted(sample, result.sample))
                            observed.current = { generation, uptime: null };
                        sample = result.sample;
                        publish(
                            requestedFreshness === freshness.current && !reservation.current
                                ? 'current'
                                : 'stale',
                        );
                    } else {
                        unsupported = result.reason === 'unsupported';
                        publish(sample ? 'stale' : 'unavailable');
                    }
                } catch {
                    publish(sample ? 'stale' : 'unavailable');
                }
            })();
            flight.current = pending;
            void pending.finally(() => {
                if (flight.current === pending) flight.current = null;
                const next = queued.current;
                queued.current = null;
                next?.();
            });
        };
        refresh.current = run;
        publish(unsupported ? (sample ? 'stale' : 'unavailable') : sample ? 'stale' : 'loading');
        run();
        const timer = setInterval(run, 60_000);
        return () => {
            disposed = true;
            clearInterval(timer);
            if (refresh.current === run) refresh.current = null;
            if (queued.current === run) queued.current = null;
        };
};return{quiesce,cleanup:setup()};}
export function bindRestore(context:any){const {document,refresh}=context;
        const resume = () => {
            if (document.visibilityState !== 'hidden') refresh.current?.();
        };
return resume;}
export function bindSample(context:any){const {props,transport,Date,performance}=context;
    const sample = async (active = props.transport): Promise<ClockCalibration> => {
        if (transport !== 'ssh' || !active?.readDeviceClock || !active.automationConnection)
            throw Error(
                'Device clock: arbitrary Serial timestamp latency cannot establish a verified schedule. Use local time.',
            );
        const connection = active.automationConnection(),
            local = Date.now(),
            mono = performance.now(),
            response = await active.readDeviceClock(connection),
            elapsed = performance.now() - mono;
        if (
            response.status !== 'available' ||
            response.sample.epochSeconds === null ||
            response.sample.utcOffsetMinutes === null
        )
            throw Error('Device clock: target epoch/offset are unavailable.');
        if (connection !== active.automationConnection())
            throw Error('Device clock: connection changed.');
        if (elapsed > 2000 || Math.abs(Date.now() - local - elapsed) > 1000)
            throw Error('Device clock: sample uncertainty or clock drift is too large.');
        return {
            source: 'SSH fixed read-only clock sample (date)',
            connection,
            deviceEpochMs: response.sample.epochSeconds * 1000,
            sampledLocalMs: local + elapsed / 2,
            sampledMonoMs: mono + elapsed / 2,
            uncertaintyMs: 1000 + elapsed / 2,
            zone:
                (response.sample.zone ?? 'offset') +
                ' UTC' +
                response.sample.utcOffsetMinutes +
                ' minutes',
        };
    };

return sample;}

export function bindClockState(context:any):DeviceClockState & {quiesce:()=>Promise<()=>void>}{const {generation,transport,reset,blocked,state,reservation,quiesce}=context;
    if (generation === undefined || !transport) return { status: 'disconnected', sample: null, quiesce };
    if (blocked || state.transport !== transport || state.generation !== generation || state.reset !== reset)
        return { status: 'loading', sample: null, quiesce };
    return {
        ...state,
        status: reservation.current ? (state.sample ? 'stale' : 'loading') : state.status,
        quiesce,
    };
}

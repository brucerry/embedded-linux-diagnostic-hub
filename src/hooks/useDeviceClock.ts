import { useEffect, useRef, useState } from 'react';
import {
    deviceRebooted,
    validateDeviceClock,
    type DeviceClockResponse,
    type DeviceClockSample,
} from '../../shared/diagnostics/device-clock';

export interface DeviceClockState {
    status: 'disconnected' | 'loading' | 'unavailable' | 'current' | 'stale';
    sample: DeviceClockSample | null;
}

interface ClockInputs {
    transport: { readDeviceClock?(): Promise<DeviceClockResponse> } | null | undefined;
    generation: number | undefined;
    reset: number;
    blocked: boolean;
    uptime: number | null;
}

export function useDeviceClock({
    transport,
    generation,
    reset,
    blocked,
    uptime,
}: ClockInputs): DeviceClockState {
    const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
    const [state, setState] = useState<DeviceClockState & { generation?: number; reset?: number }>({
        status: 'disconnected',
        sample: null,
    });
    const flight = useRef<Promise<void> | null>(null);
    const queued = useRef<(() => void) | null>(null);
    const refresh = useRef<(() => void) | null>(null);
    const observed = useRef<{ generation?: number; uptime: number | null }>({ uptime: null });
    const retained = useRef<{
        generation?: number;
        reset?: number;
        sample: DeviceClockSample | null;
    }>({ sample: null });

    useEffect(() => {
        const visibility = () => setVisible(document.visibilityState !== 'hidden');
        const resume = () => {
            if (document.visibilityState !== 'hidden') refresh.current?.();
        };
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pageshow', resume);
        window.addEventListener('focus', resume);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pageshow', resume);
            window.removeEventListener('focus', resume);
        };
    }, []);

    useEffect(() => {
        if (generation === undefined || !transport) {
            retained.current = { sample: null };
            setState({ status: 'disconnected', sample: null });
            return;
        }
        if (blocked || !visible) return;
        let disposed = false;
        let unsupported = !transport.readDeviceClock;
        let sample =
            retained.current.generation === generation && retained.current.reset === reset
                ? retained.current.sample
                : null;
        const publish = (status: DeviceClockState['status']) => {
            if (!disposed) {
                retained.current = { sample, generation, reset };
                setState({ status, sample, generation, reset });
            }
        };
        const run = () => {
            if (disposed || unsupported) return;
            if (flight.current) {
                queued.current = run;
                return;
            }
            const pending = (async () => {
                try {
                    const result = validateDeviceClock(await transport.readDeviceClock!());
                    if (disposed) return;
                    if (result.status === 'available') {
                        // A boot change found by this read already carries the fresh device calendar.
                        if (sample && deviceRebooted(sample, result.sample))
                            observed.current = { generation, uptime: null };
                        sample = result.sample;
                        publish('current');
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
        publish(unsupported ? (sample ? 'stale' : 'unavailable') : sample ? 'current' : 'loading');
        run();
        const timer = setInterval(run, 60_000);
        return () => {
            disposed = true;
            clearInterval(timer);
            if (refresh.current === run) refresh.current = null;
            if (queued.current === run) queued.current = null;
        };
    }, [transport, generation, reset, blocked, visible]);

    useEffect(() => {
        const previous = observed.current;
        if (
            previous.generation === generation &&
            deviceRebooted(
                { bootId: null, uptimeSeconds: previous.uptime },
                { bootId: null, uptimeSeconds: uptime },
            )
        )
            refresh.current?.();
        observed.current = { generation, uptime };
    }, [generation, uptime]);

    if (generation === undefined) return { status: 'disconnected', sample: null };
    if (blocked || state.generation !== generation || state.reset !== reset)
        return { status: 'loading', sample: null };
    return state;
}

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
export interface DeviceClockAdmission {
    quiesce(): Promise<() => void>;
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
}: ClockInputs): DeviceClockState & DeviceClockAdmission {
    const [{ visible, resumeRevision }, setVisibility] = useState(() => ({
        visible: document.visibilityState !== 'hidden',
        resumeRevision: 0,
    }));
    const [state, setState] = useState<DeviceClockState & {
        generation?: number;
        reset?: number;
        transport?: ClockInputs['transport'];
    }>({
        status: 'disconnected',
        sample: null,
    });
    const flight = useRef<Promise<void> | null>(null);
    const queued = useRef<(() => void) | null>(null);
    const refresh = useRef<(() => void) | null>(null);
    const reservation = useRef<symbol | null>(null);
    const freshness = useRef(0);
    const observed = useRef<{ generation?: number; uptime: number | null }>({ uptime: null });
    const retained = useRef<{
        generation?: number;
        reset?: number;
        transport?: ClockInputs['transport'];
        sample: DeviceClockSample | null;
    }>({ sample: null });
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

    useEffect(() => {
        const visibility = () => {
            const next = document.visibilityState !== 'hidden';
            setVisibility((current) =>
                current.visible === next
                    ? current
                    : {
                          visible: next,
                          // Preserve a resume even if React batches hidden and visible together.
                          resumeRevision: current.resumeRevision + (next ? 1 : 0),
                      },
            );
        };
        const resume = () => {
            if (document.visibilityState !== 'hidden') refresh.current?.();
        };
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pageshow', resume);
        window.addEventListener('focus', resume);
        const unsubscribe = window.diagnosticHub?.onWindowRestored?.(resume);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pageshow', resume);
            window.removeEventListener('focus', resume);
            unsubscribe?.();
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
    }, [transport, generation, reset, blocked, visible, resumeRevision]);

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

    if (generation === undefined || !transport) return { status: 'disconnected', sample: null, quiesce };
    if (blocked || state.transport !== transport || state.generation !== generation || state.reset !== reset)
        return { status: 'loading', sample: null, quiesce };
    return {
        ...state,
        status: reservation.current ? (state.sample ? 'stale' : 'loading') : state.status,
        quiesce,
    };
}

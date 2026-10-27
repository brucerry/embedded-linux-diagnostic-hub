import { useEffect, useRef } from 'react';
import { localSerial } from '../../shared/serial';
import { SerialSession } from '../features/serial/session';
export function useSerialSession() {
    const owner = useRef<SerialSession | null>(null);
    if (!owner.current) owner.current = new SerialSession(async () => {});
    const session = owner.current;
    useEffect(() => {
        const api = localSerial(),
            bridge = window.diagnosticHub;
        const unplug = (event: Event) => {
            const port = (event as Event & { port?: unknown }).port ?? event.target;
            if (port === session.selectedPort) void session.disconnected().catch(() => {});
        };
        api?.addEventListener('disconnect', unplug);
        const pagehide = () => {
            session.cancelSelection();
            void session.close(true).catch(() => {});
        };
        window.addEventListener('pagehide', pagehide);
        const unsubscribe = bridge?.onSerialQuiesce?.((id) => {
            session.cancelSelection();
            void session
                .close()
                .then(() => bridge.acknowledgeSerialQuiesce?.(id))
                .catch(() => {});
        });
        return () => {
            unsubscribe?.();
            api?.removeEventListener('disconnect', unplug);
            window.removeEventListener('pagehide', pagehide);
            pagehide();
        };
    }, [session]);
    return session;
}

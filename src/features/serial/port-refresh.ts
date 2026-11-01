/**
 * Owns authorized-port list reads for one effect lifetime, not Serial connections.
 * Failed reads keep the last accepted list; superseded/disposed reads cannot publish.
 */
export function createSerialPortRefresh<Port>(
    getPorts: () => Promise<Port[]>,
    publish: (ports: Port[]) => void,
) {
    let disposed = false;
    let latest: object | undefined;
    return {
        async refresh(): Promise<void> {
            if (disposed) return;
            const request = {};
            latest = request;
            try {
                const ports = await getPorts();
                if (!disposed && latest === request) publish(ports);
            } catch {
                // Discovery remains best-effort, as before; never fall back to an older reply.
            }
        },
        dispose(): void {
            disposed = true;
            latest = undefined;
        },
    };
}

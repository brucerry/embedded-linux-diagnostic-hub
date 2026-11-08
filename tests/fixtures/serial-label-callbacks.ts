// Verbatim active label callbacks; injected refs model one component lifetime, not React mounting.
import type { LocalSerialPort } from '../../shared/serial';
export function bindSerialLabels(context: {
    labels: { current: WeakMap<LocalSerialPort, string> };
    labelOrdinal: { current: number };
    pendingLabel: { current: string };
}) {
    const { labels, labelOrdinal, pendingLabel } = context;
    const label = (port: LocalSerialPort) => {
        if (!labels.current.has(port)) {
            const info = port.getInfo();
            labels.current.set(
                port,
                'Authorized port ' +
                    ++labelOrdinal.current +
                    (info.usbVendorId !== undefined
                        ? ' · USB ' +
                          info.usbVendorId.toString(16).padStart(4, '0') +
                          ':' +
                          (info.usbProductId ?? 0).toString(16).padStart(4, '0')
                        : ''),
            );
        }
        return labels.current.get(port)!;
    };
    // Retain the production callback's indentation for the exact byte-restoration check.
    // prettier-ignore
    const chooseLabel = (port: LocalSerialPort) => {
                                        const chosenName = pendingLabel.current;
                                        pendingLabel.current = '';
                                        if (chosenName) {
                                            if (!labels.current.has(port)) labelOrdinal.current++;
                                            labels.current.set(port, chosenName);
                                        }
                                        return label(port);
    };
    return { label, chooseLabel };
}

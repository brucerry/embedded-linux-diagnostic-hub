import { randomUUID } from 'node:crypto';
import type {
    BrowserWindow,
    SerialPort,
    WebContents,
    PermissionCheckHandlerHandlerDetails,
} from 'electron';
import { allowsSerial, SerialSelection, serialOrigin } from './serial-policy';

export function configureSerial(
    window: BrowserWindow,
    documentUrl: string,
    externalBlocked: () => boolean,
) {
    const contents = window.webContents,
        session = contents.session;
    let quiescing = false;
    let pending:
        | {
              id: string;
              resolve: () => void;
              reject: (error: Error) => void;
              timer: ReturnType<typeof setTimeout>;
          }
        | undefined;
    const offered = new Map<string, SerialPort>();
    const choice = (p: SerialPort) => ({
        id: p.portId,
        name: p.portName,
        ...(p.displayName ? { displayName: p.displayName } : {}),
    });
    const added = (_event: unknown, port: SerialPort, owner: WebContents) => {
        if (owner === contents && selection.active) {
            offered.set(port.portId, port);
            selection.update([...offered.values()].map(choice));
        }
    };
    const removed = (_event: unknown, port: SerialPort, owner: WebContents) => {
        if (owner === contents && selection.active) {
            offered.delete(port.portId);
            selection.update([...offered.values()].map(choice));
        }
    };
    const detach = () => {
        session.removeListener('serial-port-added', added);
        session.removeListener('serial-port-removed', removed);
        offered.clear();
    };
    const selection = new SerialSelection((value) => {
        if (!value) detach();
        if (!contents.isDestroyed()) contents.send('hub:serial-chooser', value);
    });
    session.setPermissionCheckHandler(
        (owner, permission, origin, details) =>
            !quiescing &&
            !externalBlocked() &&
            contents.mainFrame.url === documentUrl &&
            allowsSerial(documentUrl, contents, owner, permission, origin, details),
    );
    session.setPermissionRequestHandler((owner, permission, reply, details) => {
        const d = details as PermissionCheckHandlerHandlerDetails;
        // Request details do not supply securityOrigin; the main-frame URL establishes it.
        reply(
            !quiescing &&
                !externalBlocked() &&
                contents.mainFrame.url === documentUrl &&
                allowsSerial(documentUrl, contents, owner, permission, serialOrigin(documentUrl), {
                    ...d,
                    securityOrigin: serialOrigin(documentUrl),
                }),
        );
    });
    session.on('select-serial-port', (event, ports, owner, callback) => {
        event.preventDefault();
        if (
            owner !== contents ||
            contents.mainFrame.url !== documentUrl ||
            quiescing ||
            externalBlocked()
        ) {
            callback('');
            return;
        }
        selection.cancel();
        for (const port of ports) offered.set(port.portId, port);
        selection.start(ports.map(choice), callback);
        session.on('serial-port-added', added);
        session.on('serial-port-removed', removed);
    });
    const stop = () => {
        selection.cancel();
        detach();
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(Error('Serial renderer closed before cleanup acknowledgement.'));
            pending = undefined;
        }
    };
    window.on('closed', stop);
    contents.on('render-process-gone', stop);
    contents.on('will-navigate', () => selection.cancel());
    return {
        select(id: unknown, portId: unknown) {
            selection.select(id, portId);
        },
        acknowledge(id: unknown) {
            if (!pending || id !== pending.id) throw Error('Stale serial cleanup acknowledgement.');
            const current = pending;
            pending = undefined;
            clearTimeout(current.timer);
            current.resolve();
        },
        async quiesce() {
            if (quiescing) throw Error('Serial cleanup is already pending.');
            quiescing = true;
            selection.cancel();
            try {
                await new Promise<void>((resolve, reject) => {
                    const id = randomUUID();
                    const timer = setTimeout(() => {
                        pending = undefined;
                        reject(
                            Error(
                                'Serial cleanup did not finish. Update installation was stopped.',
                            ),
                        );
                    }, 5000);
                    pending = { id, resolve, reject, timer };
                    contents.send('hub:serial-quiesce', id);
                });
            } catch (error) {
                quiescing = false;
                throw error;
            }
        },
        release() {
            quiescing = false;
        },
    };
}

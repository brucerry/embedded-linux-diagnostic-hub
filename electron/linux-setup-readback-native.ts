import { Socket } from 'node:net';
import { physicalFS } from './physical-fs.ts';
import {
    createLinuxMainReadback,
    createLinuxMainQuit,
    type LinuxReadbackPort,
} from './linux-setup-readback.ts';
import type { LinuxSetupReadiness } from '../shared/types.ts';

export const LINUX_SETUP_READBACK_ENV = 'DIAGNOSTIC_HUB_SETUP_READBACK';
export const LINUX_SETUP_QUIT_ENV = 'DIAGNOSTIC_HUB_SETUP_QUIT';
interface Runtime {
    enabled: boolean;
    platform: string;
    layout: string | undefined;
    packaged: boolean;
    uid: number;
    euid: number;
    cooperativeQuit?: boolean;
}
interface NativePortOps {
    stat(): { dev: number; ino: number; uid: number; isSocket(): boolean };
    socket(): LinuxReadbackPort;
    quitStat?(): ReturnType<NativePortOps['stat']>;
    quitSocket?(): LinuxReadbackPort;
}
/** Explicit opt-in only. No listen/connect, pathname endpoint, permissions or FD close fallback.
 * The ownership assumption is the direct launcher's inherited fd3. This is not SO_PEERCRED,
 * immutable executable or hostile same-UID descriptor-race proof, and remains unqualified. */
export function createLinuxNativeSetupReadback(
    runtime: Runtime,
    ops: NativePortOps = {
        stat: () => physicalFS.fstatSync(3),
        socket: () => new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true }),
        quitStat: () => physicalFS.fstatSync(4),
        quitSocket: () =>
            new Socket({ fd: 4, readable: true, writable: true, allowHalfOpen: true }),
    },
    requestNormalQuit?: () => void,
) {
    let owned: LinuxReadbackPort | null = null,
        responder: ReturnType<typeof createLinuxMainReadback> | null = null,
        quitOwned: LinuxReadbackPort | null = null,
        quit: ReturnType<typeof createLinuxMainQuit> | null = null,
        unknown = false;
    if (runtime.cooperativeQuit && !runtime.enabled) unknown = true;
    if (runtime.enabled) {
        try {
            if (
                runtime.platform !== 'linux' ||
                runtime.layout !== 'linux-folder' ||
                runtime.packaged !== true ||
                !Number.isSafeInteger(runtime.uid) ||
                runtime.uid <= 0 ||
                runtime.euid !== runtime.uid
            )
                throw Error();
            const observed = ops.stat();
            if (
                !observed.isSocket() ||
                observed.uid !== runtime.uid ||
                !Number.isSafeInteger(observed.dev) ||
                observed.dev < 0 ||
                !Number.isSafeInteger(observed.ino) ||
                observed.ino <= 0
            )
                throw Error();
            const before = { dev: observed.dev, ino: observed.ino, uid: observed.uid };
            owned = ops.socket(); // Retain before postconstruction checks; never retry an uncertain fd handoff.
            const after = ops.stat();
            if (
                !after.isSocket() ||
                after.uid !== before.uid ||
                after.dev !== before.dev ||
                after.ino !== before.ino
            )
                throw Error();
            responder = createLinuxMainReadback(owned);
            if (runtime.cooperativeQuit) {
                if (typeof requestNormalQuit !== 'function' || !ops.quitStat || !ops.quitSocket)
                    throw Error();
                const current = ops.quitStat();
                if (
                    !current.isSocket() ||
                    current.uid !== runtime.uid ||
                    !Number.isSafeInteger(current.dev) ||
                    current.dev < 0 ||
                    !Number.isSafeInteger(current.ino) ||
                    current.ino <= 0 ||
                    (current.dev === before.dev && current.ino === before.ino)
                )
                    throw Error();
                const identity = { dev: current.dev, ino: current.ino, uid: current.uid };
                quitOwned = ops.quitSocket();
                if (quitOwned === owned) throw Error();
                const afterQuit = ops.quitStat();
                if (
                    !afterQuit.isSocket() ||
                    afterQuit.dev !== identity.dev ||
                    afterQuit.ino !== identity.ino ||
                    afterQuit.uid !== identity.uid
                )
                    throw Error();
                quit = createLinuxMainQuit(quitOwned, requestNormalQuit, Date.now, () => {
                    unknown = true;
                });
            }
        } catch {
            unknown = true;
        }
    }
    return Object.freeze({
        offer(
            value: LinuxSetupReadiness | null,
            refresh: () => Promise<LinuxSetupReadiness | null>,
        ) {
            if (!unknown) {
                responder?.offer(value, refresh);
                quit?.offer(value, refresh);
            }
        },
        async joinClosure() {
            if (unknown) throw Error('LINUX_READBACK_FD_CUSTODY_RETAINED');
            await responder?.joinClosure();
            await quit?.joinClosure();
            if (unknown) throw Error('LINUX_READBACK_FD_CUSTODY_RETAINED');
        },
        summary: () => ({
            enabled: runtime.enabled,
            unknown,
            returnedPortOwned: owned !== null,
            channel: responder?.summary() ?? null,
            quitChannel: quit?.summary() ?? null,
            quitPortOwned: quitOwned !== null,
            nativeQualified: false,
            finalizationAuthority: false,
        }),
    });
}

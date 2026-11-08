import type { App, Dialog } from 'electron';
import { physicalFS } from './physical-fs.ts';
import type { LinuxPromptPort, LinuxPromptReply, LinuxPromptRequest } from './linux-setup-ui';
export interface LinuxPromptClock {
    now(): number;
    set(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    clear(timer: ReturnType<typeof setTimeout>): void;
    wait(ms: number): Promise<void>;
}
const clockDefault: LinuxPromptClock = {
    now: () => performance.now(),
    set: setTimeout,
    clear: clearTimeout,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
/** Native Linux message box, not a BrowserWindow/renderer or subprocess. Only this owned box is aborted. */
export function linuxGuiPrompt(
    app: Pick<App, 'whenReady'>,
    dialog: Pick<Dialog, 'showMessageBox'>,
    displayAvailable: boolean,
    clock = clockDefault,
): LinuxPromptPort {
    const pending = new Set<object>();
    return {
        hasPending: () => pending.size !== 0,
        async review(input) {
            if (!displayAvailable) return { status: 'unavailable' };
            const request = { ...input },
                started = clock.now();
            if (
                !Number.isFinite(started) ||
                !Number.isFinite(request.deadlineMs) ||
                started >= request.deadlineMs
            )
                return { status: 'unknown' };
            const phaseDeadline = Math.min(request.deadlineMs, started + 60000);
            const owner = {
                controller: new AbortController(),
                returned: false,
                actuationFrozen: false,
                ready: null as Promise<void> | null,
                operation: null as Promise<Electron.MessageBoxReturnValue> | null,
            };
            pending.add(owner);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                owner.ready = app.whenReady();
                await owner.ready;
                const sample = clock.now();
                const remaining = phaseDeadline - sample;
                if (!Number.isFinite(sample) || sample < started || !(remaining > 0)) {
                    pending.delete(owner);
                    return { status: 'unknown' };
                }
                timer = clock.set(() => {
                    // An uncertain submission retains custody, but never future UI actuation.
                    if (owner.actuationFrozen || owner.returned) return;
                    try {
                        const now = clock.now();
                        if (!Number.isFinite(now) || now < started || now >= request.deadlineMs) {
                            owner.actuationFrozen = true;
                            return;
                        }
                        if (now < phaseDeadline) return;
                        owner.actuationFrozen = true;
                        owner.controller.abort();
                    } catch {
                        owner.actuationFrozen = true;
                        /* retain unknown; no further action */
                    }
                }, remaining);
                const beforeSubmit = clock.now();
                if (
                    !Number.isFinite(beforeSubmit) ||
                    beforeSubmit < started ||
                    beforeSubmit >= phaseDeadline ||
                    owner.controller.signal.aborted
                ) {
                    owner.actuationFrozen = true;
                    clock.clear(timer);
                    pending.delete(owner);
                    return { status: 'unknown' };
                }
                owner.operation = dialog.showMessageBox({
                    type: 'question',
                    title: 'Diagnostic Hub – Linux setup review',
                    message: 'Review choices only',
                    detail: request.detail,
                    buttons: ['Cancel', 'Finish review'],
                    defaultId: 0,
                    cancelId: 0,
                    noLink: true,
                    checkboxLabel: 'Application menu shortcut',
                    checkboxChecked: request.menu,
                    signal: owner.controller.signal,
                });
                const result = await owner.operation;
                owner.returned = true;
                owner.actuationFrozen = true;
                pending.delete(owner);
                clock.clear(timer);
                const returnedAt = clock.now();
                if (!Number.isFinite(returnedAt) || returnedAt < started)
                    return { status: 'unknown' };
                if (returnedAt >= phaseDeadline || owner.controller.signal.aborted)
                    return { status: 'cancelled' };
                if (result.response === 0) return { status: 'cancelled' };
                if (result.response !== 1 || typeof result.checkboxChecked !== 'boolean')
                    return { status: 'unknown' };
                return { status: 'confirmed', menu: result.checkboxChecked };
            } catch {
                owner.actuationFrozen = true;
                if (owner.returned) pending.delete(owner);
                return { status: 'unknown' };
            }
        },
    };
}
export interface LinuxTTYOps {
    platform: string;
    uid(): number;
    euid(): number;
    fs: Pick<
        typeof physicalFS,
        'constants' | 'openSync' | 'fstatSync' | 'readSync' | 'writeSync' | 'closeSync'
    >;
}
/** No stdin read: /dev/tty is the controlling terminal. Late/failed owned FDs are retained. */
export function linuxTerminalPrompt(clock = clockDefault, supplied?: LinuxTTYOps): LinuxPromptPort {
    const ops = supplied ?? {
            platform: process.platform,
            uid: () => process.getuid!(),
            euid: () => process.geteuid!(),
            fs: physicalFS,
        },
        pending = new Set<number>();
    return {
        hasPending: () => pending.size !== 0,
        async review(request: LinuxPromptRequest): Promise<LinuxPromptReply> {
            if (
                ops.platform !== 'linux' ||
                !Number.isSafeInteger(ops.uid()) ||
                ops.uid() <= 0 ||
                ops.euid() !== ops.uid()
            )
                return { status: 'unavailable' };
            const started = clock.now();
            const phaseDeadline = Math.min(request.deadlineMs, started + 60000),
                fs = ops.fs,
                C = fs.constants;
            const gate = () => {
                const now = clock.now();
                if (
                    !Number.isFinite(now) ||
                    !Number.isFinite(phaseDeadline) ||
                    now < started ||
                    now >= phaseDeadline
                )
                    throw Error('TTY_DEADLINE');
            };
            let fd: number;
            try {
                gate();
                for (const flag of [C.O_NOFOLLOW, C.O_NONBLOCK, C.O_NOCTTY])
                    if (!Number.isInteger(flag) || flag === 0) throw Error('TTY_FLAG');
                fd = fs.openSync('/dev/tty', C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | C.O_NOCTTY);
                pending.add(fd);
                gate();
            } catch {
                return { status: pending.size ? 'unknown' : 'unavailable' };
            }
            try {
                if (!fs.fstatSync(fd).isCharacterDevice()) throw Error('TTY_TYPE');
                gate();
                const bytes = Buffer.from(
                    '\n' +
                        request.detail +
                        '\nType "review menu" or "review no-menu"; Enter/cancel leaves everything unchanged: ',
                );
                if (bytes.length > 16384) throw Error('TTY_BOUND');
                let at = 0;
                while (at < bytes.length) {
                    gate();
                    const count = fs.writeSync(fd, bytes, at, bytes.length - at);
                    gate();
                    if (!Number.isInteger(count) || count <= 0) throw Error('TTY_WRITE');
                    at += count;
                }
                const buffer = Buffer.alloc(1025);
                let total = 0;
                for (;;) {
                    gate();
                    let count = 0,
                        wouldBlock = false;
                    try {
                        count = fs.readSync(fd, buffer, total, buffer.length - total, null);
                    } catch (error) {
                        if (
                            !['EAGAIN', 'EWOULDBLOCK'].includes(
                                (error as NodeJS.ErrnoException).code ?? '',
                            )
                        )
                            throw error;
                        wouldBlock = true;
                    }
                    gate();
                    if (!Number.isInteger(count) || count < 0) throw Error('TTY_READ');
                    if (count === 0 && !wouldBlock) {
                        gate();
                        fs.closeSync(fd);
                        pending.delete(fd);
                        gate();
                        return { status: 'cancelled' };
                    }
                    total += count;
                    if (total > 1024) throw Error('TTY_BOUND');
                    if (buffer.subarray(0, total).includes(10)) break;
                    if (count === 0) await clock.wait(25);
                }
                const line = new TextDecoder('utf-8', { fatal: true }).decode(
                    buffer.subarray(0, total),
                );
                if (!/^[^\r\n]*\r?\n$/.test(line)) throw Error('TTY_MULTILINE');
                gate();
                fs.closeSync(fd);
                pending.delete(fd);
                gate();
                const choice = line.trim();
                if (choice === 'review menu') return { status: 'confirmed', menu: true };
                if (choice === 'review no-menu') return { status: 'confirmed', menu: false };
                return { status: 'cancelled' };
            } catch {
                return { status: 'unknown' };
            }
        },
    };
}

import { valid } from 'semver';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

/** Pure verifier only. A future native reader must obtain kernel facts independently of the reply. */
export interface LinuxSuccessorBinding {
    root: string;
    installationId: string;
    transactionId: string;
    manifestSHA256: string;
    version: string;
    profile: string;
    uid: number;
    pid: number;
    startTicks: string;
    activatedAtMs: number;
    nonce: string;
}
export interface LinuxSuccessorReply extends LinuxSuccessorBinding {
    executable: string;
    observedAtMs: number;
    window: string;
    visible: boolean;
    minimized: boolean;
    responsive: boolean;
    trustedMainFrame: boolean;
    normalInvocation: boolean;
    listenerInode: string;
}
export interface LinuxKernelSuccessor {
    creationTimeMs: number;
    uid: number;
    pid: number;
    startTicks: string;
    executable: string;
    profile: string;
    listenerInode: string;
    normalInvocation: boolean;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const absolute = (text: string) =>
    typeof text === 'string' &&
    text.length <= 240 &&
    text.startsWith('/') &&
    path.posix.normalize(text) === text &&
    !/[\\\x00-\x1f\x7f]/.test(text);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const ticks = (value: string) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function frame(reply: LinuxSuccessorReply) {
    // A fixed field order binds every selected fact; unknown properties cannot enter the signature.
    return JSON.stringify([
        reply.root,
        reply.installationId,
        reply.transactionId,
        reply.manifestSHA256,
        reply.version,
        reply.profile,
        reply.uid,
        reply.pid,
        reply.startTicks,
        reply.activatedAtMs,
        reply.nonce,
        reply.executable,
        reply.observedAtMs,
        reply.window,
        reply.visible,
        reply.minimized,
        reply.responsive,
        reply.trustedMainFrame,
        reply.normalInvocation,
        reply.listenerInode,
    ]);
}
/** No acknowledgement, process request or previous-payload cleanup occurs here. */
export function verifyLinuxSuccessor(
    expected: LinuxSuccessorBinding,
    reply: LinuxSuccessorReply,
    kernel: LinuxKernelSuccessor,
    proof: string,
    key: Uint8Array,
    nowMs: number,
): boolean {
    try {
        if (
            !expected ||
            !reply ||
            !kernel ||
            !(key instanceof Uint8Array) ||
            key.byteLength !== 32 ||
            !Number.isSafeInteger(nowMs) ||
            !Number.isSafeInteger(expected.activatedAtMs) ||
            expected.activatedAtMs < 0 ||
            !absolute(expected.root) ||
            !absolute(expected.profile) ||
            expected.profile === expected.root ||
            expected.profile.startsWith(expected.root + '/') ||
            expected.root.startsWith(expected.profile + '/') ||
            !uuid.test(expected.installationId) ||
            !uuid.test(expected.transactionId) ||
            !/^[a-f0-9]{64}$/.test(expected.manifestSHA256) ||
            !/^[a-f0-9]{64}$/.test(expected.nonce) ||
            !positive(expected.uid) ||
            !positive(expected.pid) ||
            !ticks(expected.startTicks) ||
            typeof expected.version !== 'string' ||
            expected.version.length > 128 ||
            valid(expected.version) !== expected.version ||
            !Number.isSafeInteger(reply.observedAtMs) ||
            reply.observedAtMs < expected.activatedAtMs ||
            reply.observedAtMs > nowMs ||
            nowMs - reply.observedAtMs >= 2000 ||
            typeof reply.window !== 'string' ||
            !/^[a-f0-9]{2,32}$/.test(reply.window) ||
            !/[1-9a-f]/.test(reply.window) ||
            !ticks(reply.listenerInode) ||
            reply.visible !== true ||
            reply.minimized !== false ||
            reply.responsive !== true ||
            reply.trustedMainFrame !== true ||
            reply.normalInvocation !== true ||
            !Number.isSafeInteger(kernel.creationTimeMs) ||
            kernel.creationTimeMs < expected.activatedAtMs ||
            kernel.creationTimeMs > reply.observedAtMs ||
            kernel.normalInvocation !== true ||
            typeof proof !== 'string' ||
            !/^[a-f0-9]{64}$/.test(proof)
        )
            return false;
        const replyKeys = [
            'root',
            'installationId',
            'transactionId',
            'manifestSHA256',
            'version',
            'profile',
            'uid',
            'pid',
            'startTicks',
            'activatedAtMs',
            'nonce',
            'executable',
            'observedAtMs',
            'window',
            'visible',
            'minimized',
            'responsive',
            'trustedMainFrame',
            'normalInvocation',
            'listenerInode',
        ];
        if (
            Object.keys(reply).length !== replyKeys.length ||
            Object.keys(reply).some((key) => !replyKeys.includes(key))
        )
            return false;
        const fields = [
            'root',
            'installationId',
            'transactionId',
            'manifestSHA256',
            'version',
            'profile',
            'uid',
            'pid',
            'startTicks',
            'activatedAtMs',
            'nonce',
        ] as const;
        if (fields.some((field) => reply[field] !== expected[field])) return false;
        const executable = path.posix.join(expected.root, 'app/diagnostic-hub');
        if (
            reply.executable !== executable ||
            kernel.executable !== executable ||
            kernel.uid !== expected.uid ||
            kernel.pid !== expected.pid ||
            kernel.startTicks !== expected.startTicks ||
            kernel.profile !== expected.profile ||
            kernel.listenerInode !== reply.listenerInode
        )
            return false;
        const text = frame(reply);
        if (Buffer.byteLength(text) > 16384) return false;
        const wanted = createHmac('sha256', key).update(text).digest();
        return timingSafeEqual(wanted, Buffer.from(proof, 'hex'));
    } catch {
        return false;
    }
}

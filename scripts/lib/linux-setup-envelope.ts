import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateInstallationManifest, INSTALLATION_PRODUCT, MAX_INSTALLATION_MANIFEST_BYTES,
    MAX_INSTALLATION_PAYLOAD_BYTES } from '../../shared/installation.ts';
import { LINUX_REVIEW_ENTRY, LINUX_REVIEW_CAPABILITY } from './linux-review-package.mjs';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
function record(value: unknown, keys: string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('\n') !== keys.slice().sort().join('\n'))
        throw Error('LINUX_ENVELOPE_INPUT');
    return value as Record<string, unknown>;
}
function absolute(value: unknown): value is string {
    return typeof value === 'string' && value.length > 1 && value.length <= 240 &&
        value.startsWith('/') && path.posix.normalize(value) === value && !/[\\\x00-\x1f\x7f]/.test(value);
}
const inside = (a: string, b: string) => a === b || b.startsWith(a + '/');
export interface LinuxEnvelopeFile { path: string; bytes: number; sha256: string; mode: number }
/** Caller-selected expected facts need independent provenance; this input does not authenticate itself. */
export function planLinuxReviewEnvelope(input: unknown) {
    const v = record(clone(input), ['platform', 'arch', 'uid', 'euid', 'home', 'sourceRoot', 'outputRoot',
        'archivePath', 'archive', 'layout', 'version', 'sourceCommit', 'files', 'inventorySHA256']);
    if (v.platform !== 'linux' || v.arch !== 'x64' || !Number.isSafeInteger(v.uid) ||
        (v.uid as number) <= 0 || v.euid !== v.uid || v.layout !== 'flat-linux-portable' ||
        ![v.home, v.sourceRoot, v.outputRoot, v.archivePath].every(absolute))
        throw Error('LINUX_ENVELOPE_INPUT');
    const home = v.home as string, sourceRoot = v.sourceRoot as string,
        outputRoot = v.outputRoot as string, archivePath = v.archivePath as string;
    if (![sourceRoot, outputRoot, archivePath].every(x => inside(home, x) && x !== home) ||
        inside(sourceRoot, outputRoot) || inside(outputRoot, sourceRoot) ||
        inside(outputRoot, archivePath) || inside(sourceRoot, archivePath) ||
        path.posix.basename(outputRoot).startsWith('.DiagnosticHub-'))
        throw Error('LINUX_ENVELOPE_CONTAINMENT');
    const a = record(v.archive, ['asset', 'bytes', 'sha256']);
    if (a.asset !== 'Diagnostic-Hub-linux-x64.tar.gz' || !Number.isSafeInteger(a.bytes) ||
        (a.bytes as number) < 1 || (a.bytes as number) > MAX_INSTALLATION_PAYLOAD_BYTES ||
        typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256))
        throw Error('LINUX_ENVELOPE_ARCHIVE');
    if (!Array.isArray(v.files) || !v.files.length || v.files.length > 20000)
        throw Error('LINUX_ENVELOPE_INVENTORY');
    const files: LinuxEnvelopeFile[] = v.files.map(value => {
        const f = record(value, ['path', 'bytes', 'sha256', 'mode']);
        if (typeof f.path !== 'string' || !Number.isSafeInteger(f.mode) ||
            (f.mode as number) < 0 || (f.mode as number) > 0o777 ||
            ((f.mode as number) & 0o022) !== 0 || ((f.mode as number) & 0o400) === 0)
            throw Error('LINUX_ENVELOPE_INVENTORY');
        return { path: f.path, bytes: f.bytes as number, sha256: f.sha256 as string, mode: f.mode as number };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // The existing manifest validator supplies canonical path, duplicate/NFC, length/hash and total caps.
    const manifest = validateInstallationManifest({ schemaVersion: 1, product: INSTALLATION_PRODUCT,
        layout: 'linux-folder', platform: 'linux', arch: 'x64', version: v.version,
        sourceCommit: v.sourceCommit, entryPoint: 'app/diagnostic-hub',
        files: files.map(file => ({ kind: 'file', path: 'app/' + file.path, bytes: file.bytes, sha256: file.sha256 })) });
    const names = new Set(files.map(f => f.path)), directories = new Set<string>();
    const reserved = new Set(['diagnostic-hub-setup-payload.json', '.diagnostic-hub-installation.json',
        '.diagnostic-hub-release.json', '.diagnostic-hub-ownership.json']);
    for (const f of files) {
        if (reserved.has(f.path) || f.path.split('/')[0].startsWith('.DiagnosticHub-'))
            throw Error('LINUX_ENVELOPE_RESERVED');
        const parts = f.path.split('/'); parts.pop();
        while (parts.length) {
            const directory = parts.join('/');
            if (names.has(directory)) throw Error('LINUX_ENVELOPE_INVENTORY');
            directories.add(directory); parts.pop();
        }
    }
    if (directories.size > 20000 || !names.has('AppRun') || !names.has('resources/app.asar') ||
        !names.has(LINUX_REVIEW_ENTRY.slice(4)) || !names.has(LINUX_REVIEW_CAPABILITY.slice(4)) ||
        !files.find(f => f.path === 'diagnostic-hub' && (f.mode & 0o100)) ||
        !files.find(f => f.path === 'AppRun' && (f.mode & 0o100)) ||
        !files.find(f => f.path === LINUX_REVIEW_CAPABILITY.slice(4) && f.mode === 0o600))
        throw Error('LINUX_ENVELOPE_LAYOUT');
    const inventorySHA256 = hash(JSON.stringify(files));
    if (v.inventorySHA256 !== inventorySHA256) throw Error('LINUX_ENVELOPE_INVENTORY_HASH');
    const descriptor = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (descriptor.length > MAX_INSTALLATION_MANIFEST_BYTES) throw Error('LINUX_ENVELOPE_DESCRIPTOR_CAP');
    return { platform: 'linux' as const, arch: 'x64' as const, uid: v.uid as number, home,
        sourceRoot, outputRoot, archivePath, archive: { asset: a.asset, bytes: a.bytes as number,
            sha256: a.sha256 }, files, directories: [...directories].sort(), inventorySHA256,
        version: manifest.version, sourceCommit: manifest.sourceCommit, manifest,
        descriptor: descriptor.toString('utf8'), descriptorSHA256: hash(descriptor),
        payloadBytes: files.reduce((n, f) => n + f.bytes, 0) };
}
export type LinuxEnvelopePlan = ReturnType<typeof planLinuxReviewEnvelope>;
export interface LinuxEnvelopeIO {
    admit(plan: LinuxEnvelopePlan): Promise<void>;
    verifyInput(plan: LinuxEnvelopePlan): Promise<void>;
    createRoot(plan: LinuxEnvelopePlan): Promise<void>;
    copyFile(plan: LinuxEnvelopePlan, file: LinuxEnvelopeFile): Promise<void>;
    writeDescriptor(plan: LinuxEnvelopePlan, bytes: Buffer): Promise<{ bytes: number; sha256: string }>;
    verifyOutput(plan: LinuxEnvelopePlan): Promise<void>;
}
/** Preparation only. Never extracts an archive, installs, launches or dispatches a native mutation. */
export async function prepareLinuxReviewEnvelope(input: unknown, injected?: LinuxEnvelopeIO) {
    // Validate before selecting any concrete IO. Stable expected identities are never shared with effects.
    const plan = planLinuxReviewEnvelope(input);
    const io = injected ?? (await import('./linux-setup-envelope-disk.mjs')).createLinuxEnvelopeDisk();
    let stage = 'admission', rootCreationAttempted = false, rootCreationReturned = false;
    const call = async (method: 'admit' | 'verifyInput' | 'createRoot' | 'verifyOutput') => {
        stage = method;
        if (method === 'createRoot') rootCreationAttempted = true;
        const result = await io[method](clone(plan));
        if (method === 'createRoot') rootCreationReturned = true;
        if (result !== undefined) throw Error('LINUX_ENVELOPE_ACK');
    };
    try {
        await call('admit'); await call('verifyInput'); await call('createRoot');
        for (const file of plan.files) {
            stage = 'copyFile';
            const result = await io.copyFile(clone(plan), clone(file));
            if (result !== undefined) throw Error('LINUX_ENVELOPE_ACK');
        }
        stage = 'writeDescriptor';
        const descriptor = Buffer.from(plan.descriptor);
        const written = await io.writeDescriptor(clone(plan), Buffer.from(descriptor));
        if (!written || Object.keys(written).sort().join(',') !== 'bytes,sha256' ||
            written.bytes !== descriptor.length || written.sha256 !== plan.descriptorSHA256)
            throw Error('LINUX_ENVELOPE_DESCRIPTOR_ACK');
        await call('verifyOutput'); await call('verifyInput');
        return { status: 'prepared-read-only-envelope' as const, root: plan.outputRoot,
            descriptorBytes: descriptor.length, descriptorSHA256: plan.descriptorSHA256,
            inventorySHA256: plan.inventorySHA256, payloadBytes: plan.payloadBytes,
            qualification: 'unqualified' as const, mutation: false, nativeBinding: false };
    } catch {
        // Stop without retry, restoration or cleanup. A failed create may still have allocated a root.
        return { status: rootCreationAttempted ? 'unknown' as const : 'refused' as const,
            stage, root: plan.outputRoot, rootCreationAttempted, rootCreationReturned,
            preserved: true, qualification: 'unqualified' as const, mutation: false, nativeBinding: false };
    }
}

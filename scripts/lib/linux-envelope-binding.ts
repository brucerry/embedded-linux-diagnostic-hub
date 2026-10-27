import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_INSTALLATION_MANIFEST_BYTES } from '../../shared/installation.ts';
import { planLinuxReviewEnvelope, type LinuxEnvelopePlan } from './linux-setup-envelope.ts';
import { checkedLinuxEnvelopeIdentity, sameLinuxEnvelopeFileIdentity,
    sameLinuxEnvelopeDirectoryIdentity } from './linux-setup-envelope-disk.mjs';
import { LINUX_REVIEW_ENTRY } from './linux-review-package.mjs';

const hash = (x: string) => createHash('sha256').update(x).digest('hex');
const reasons = ['binding-input-invalid', 'archive-mismatch', 'tree-mismatch', 'descriptor-mismatch',
    'stale-identity', 'stale-observation', 'unsafe-layout', 'provenance-unavailable',
    'untrusted-provenance', 'provenance-mismatch'] as const;
type Reason = typeof reasons[number];
export interface LinuxBindingInspection {
    status: 'refused' | 'source-model-bound';
    reason?: Reason;
    bindingSHA256?: string;
    entry?: string;
    provenance?: 'injected-model-only';
    handoffAllowed: false;
    qualification: 'unqualified';
    mutation: false;
    nativeBinding: false;
}
const refuse = (reason: Reason): LinuxBindingInspection => ({ status: 'refused' as const, reason, handoffAllowed: false,
    qualification: 'unqualified' as const, mutation: false, nativeBinding: false });
function fail(reason: Reason): never { throw Error(reason); }
function record(x: unknown, keys: string[], reason: Reason = 'binding-input-invalid') {
    if (!x || typeof x !== 'object' || Array.isArray(x) ||
        Object.keys(x).sort().join('\n') !== keys.slice().sort().join('\n')) fail(reason);
    return x as Record<string, unknown>;
}
function stat(x: unknown, p: LinuxEnvelopePlan, kind: 'file' | 'directory', size?: number, privateFile = false) {
    const v = record(x, ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']);
    try { checkedLinuxEnvelopeIdentity(v); } catch { fail('stale-identity'); }
    if (v.uid !== p.uid || !Number.isSafeInteger(v.mode) ||
        (v.mode as number) < 0 || (v.mode as number) > 0o177777 || !Number.isSafeInteger(v.nlink) ||
        (v.nlink as number) < 1 || !Number.isSafeInteger(v.size) || (v.size as number) < 0 ||
        !Number.isFinite(v.mtimeMs) || !Number.isFinite(v.ctimeMs) ||
        ((v.mode as number) & 0o170000) !== (kind === 'file' ? 0o100000 : 0o40000) ||
        ((v.mode as number) & 0o7022) !== 0 || kind === 'file' && v.nlink !== 1 ||
        size !== undefined && v.size !== size || privateFile && ((v.mode as number) & 0o7777) !== 0o600)
        fail('stale-identity');
    return { dev: v.dev as number, ino: v.ino as number, uid: v.uid as number, mode: v.mode as number,
        nlink: v.nlink as number, size: v.size as number, mtimeMs: v.mtimeMs as number, ctimeMs: v.ctimeMs as number };
}
function entries(x: unknown, p: LinuxEnvelopePlan, mismatch: 'archive-mismatch' | 'tree-mismatch') {
    if (!Array.isArray(x) || x.length !== p.files.length + p.directories.length || x.length > 40000)
        fail('unsafe-layout');
    const files = [], directories = [], seen = new Set<string>();
    for (const value of x) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('unsafe-layout');
        const item = value as Record<string, unknown>;
        const v = record(item, item.kind === 'file' ? ['kind', 'path', 'bytes', 'sha256', 'mode'] :
            ['kind', 'path', 'mode'], 'unsafe-layout');
        if (typeof v.path !== 'string' || !v.path || v.path.length > 1024 ||
            /[\\\x00-\x1f\x7f]/.test(v.path) || v.path.startsWith('/') ||
            /^[a-z]:/i.test(v.path) || v.path.split('/').some(part => !part || part === '.' || part === '..') ||
            seen.has(v.path.normalize('NFC')) || !Number.isSafeInteger(v.mode) ||
            (v.mode as number) < 0 || (v.mode as number) > 0o777 || ((v.mode as number) & 0o022))
            fail('unsafe-layout');
        seen.add(v.path.normalize('NFC'));
        if (v.kind === 'file') {
            if (!Number.isSafeInteger(v.bytes) || (v.bytes as number) < 0 || typeof v.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(v.sha256)) fail(mismatch);
            files.push({ path: v.path, bytes: v.bytes as number, sha256: v.sha256, mode: v.mode as number });
        } else if (v.kind === 'directory' && ((v.mode as number) & 0o500) === 0o500) directories.push(v.path);
        else fail('unsafe-layout');
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); directories.sort();
    if (JSON.stringify(files) !== JSON.stringify(p.files) ||
        JSON.stringify(directories) !== JSON.stringify(p.directories)) fail(mismatch);
    return { files, directories };
}
export interface LinuxBindingModelPorts {
    request: { id: string; startedMs: number; deadlineMs: number };
    now(): number;
    /** Inert admission model only. There is NO qualified production provenance implementation. */
    admit(request: { id: string; bindingSHA256: string; sourceCommit: string; deadlineMs: number }): unknown;
}
/** Data-only contract inspection. Even a consistent injected admission NEVER authorizes launch. */
export function inspectLinuxArchiveTreeBinding(input: unknown, observation: unknown, injected?: LinuxBindingModelPorts): LinuxBindingInspection {
    // No real provenance/observer admission exists in the current contracts. Never infer it from data.
    if (!injected) return refuse('provenance-unavailable');
    try {
        const ports = record(injected, ['request', 'now', 'admit']);
        if (typeof ports.now !== 'function' || typeof ports.admit !== 'function') fail('provenance-unavailable');
        const request = record(structuredClone(ports.request), ['id', 'startedMs', 'deadlineMs']);
        if (typeof request.id !== 'string' || !/^[a-f0-9]{32}$/.test(request.id) ||
            !Number.isFinite(request.startedMs) || !Number.isFinite(request.deadlineMs) ||
            (request.deadlineMs as number) <= (request.startedMs as number) ||
            (request.deadlineMs as number) - (request.startedMs as number) > 120000)
            fail('stale-observation');
        const now = ports.now as () => number, admit = ports.admit as LinuxBindingModelPorts['admit'];
        const first = now();
        const current = (value: number) => {
            if (!Number.isFinite(value) || value < (request.startedMs as number) ||
                value >= (request.deadlineMs as number)) fail('stale-observation');
        };
        current(first);
        const p = planLinuxReviewEnvelope(input);
        const o = record(structuredClone(observation), ['schema', 'requestId', 'observedMs', 'archive', 'tree', 'descriptor']);
        if (o.schema !== 1 || o.requestId !== request.id || !Number.isFinite(o.observedMs) ||
            (o.observedMs as number) < (request.startedMs as number) || (o.observedMs as number) > first)
            fail('stale-observation');
        const a = record(o.archive, ['path', 'bytes', 'sha256', 'before', 'after', 'entries']);
        if (a.path !== p.archivePath || a.bytes !== p.archive.bytes || a.sha256 !== p.archive.sha256)
            fail('archive-mismatch');
        const ab = stat(a.before, p, 'file', p.archive.bytes), aa = stat(a.after, p, 'file', p.archive.bytes);
        if (!sameLinuxEnvelopeFileIdentity(ab, aa)) fail('stale-identity');
        const members = entries(a.entries, p, 'archive-mismatch');
        const t = record(o.tree, ['root', 'before', 'after', 'entries']);
        if (t.root !== path.posix.join(p.outputRoot, 'app')) fail('tree-mismatch');
        const tb = stat(t.before, p, 'directory'), ta = stat(t.after, p, 'directory');
        if (!sameLinuxEnvelopeDirectoryIdentity(tb, ta) ||
            tb.nlink !== ta.nlink || tb.size !== ta.size || tb.mtimeMs !== ta.mtimeMs || tb.ctimeMs !== ta.ctimeMs)
            fail('stale-identity');
        const tree = entries(t.entries, p, 'tree-mismatch');
        const d = record(o.descriptor, ['path', 'text', 'before', 'after']);
        if (d.path !== path.posix.join(p.outputRoot, 'diagnostic-hub-setup-payload.json') ||
            typeof d.text !== 'string' || Buffer.byteLength(d.text) > MAX_INSTALLATION_MANIFEST_BYTES ||
            d.text !== p.descriptor || hash(d.text) !== p.descriptorSHA256) fail('descriptor-mismatch');
        const bytes = Buffer.byteLength(p.descriptor), db = stat(d.before, p, 'file', bytes, true),
            da = stat(d.after, p, 'file', bytes, true);
        if (!sameLinuxEnvelopeFileIdentity(db, da)) fail('stale-identity');
        const bindingSHA256 = hash(JSON.stringify({ schema: 1, request, observedMs: o.observedMs,
            version: p.version, sourceCommit: p.sourceCommit, sourceRoot: p.sourceRoot, outputRoot: p.outputRoot,
            archivePath: p.archivePath, archive: p.archive, archiveIdentity: ab, members,
            treeIdentity: tb, tree, descriptorIdentity: db, descriptorSHA256: p.descriptorSHA256,
            inventorySHA256: p.inventorySHA256 }));
        const middle = now(); current(middle); if (middle < first) fail('stale-observation');
        let admission: unknown;
        try { admission = admit({ id: request.id, bindingSHA256, sourceCommit: p.sourceCommit,
            deadlineMs: request.deadlineMs as number }); } catch { fail('provenance-unavailable'); }
        let approved: Record<string, unknown>;
        try { approved = record(structuredClone(admission), ['scope', 'id', 'bindingSHA256', 'sourceCommit', 'deadlineMs'], 'untrusted-provenance'); }
        catch { fail('untrusted-provenance'); }
        if (approved.scope !== 'injected-source-model') fail('untrusted-provenance');
        if (approved.id !== request.id || approved.bindingSHA256 !== bindingSHA256 ||
            approved.sourceCommit !== p.sourceCommit || approved.deadlineMs !== request.deadlineMs)
            fail('provenance-mismatch');
        const last = now(); current(last); if (last < middle) fail('stale-observation');
        return { status: 'source-model-bound' as const, bindingSHA256,
            entry: path.posix.join(p.outputRoot, LINUX_REVIEW_ENTRY), provenance: 'injected-model-only' as const,
            handoffAllowed: false, qualification: 'unqualified' as const, mutation: false, nativeBinding: false };
    } catch (error) {
        const reason = error instanceof Error && reasons.includes(error.message as Reason) ?
            error.message as Reason : 'binding-input-invalid';
        return refuse(reason);
    }
}

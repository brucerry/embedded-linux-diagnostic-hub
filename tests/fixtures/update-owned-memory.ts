import assert from 'node:assert/strict';
const retained: State[] = [];
export interface State {
    files: Map<string, Buffer>; handles: Set<object>; events: string[];
    faults: Record<string, unknown>; gates: Record<string, Promise<void> | undefined>;
}
let current: State;
export function scope(): State {
    assert.ok(retained.length < 64);
    current = { files: new Map(), handles: new Set(), events: [], faults: {}, gates: {} };
    retained.push(current); return current;
}
const name = (p: string) => { assert.equal(typeof p, 'string'); assert.ok(p.startsWith('/memory/')); return p; };
async function step(s: State, key: string) {
    assert.ok(s.events.length < 256); s.events.push(key); await s.gates[key];
    if (Object.hasOwn(s.faults, key)) throw s.faults[key];
}
export async function mkdir(p: string, _options?: unknown) { name(p); await step(current, 'mkdir'); }
export async function open(p: string, flags: string, mode?: number) {
    name(p); const s = current; assert.ok(['wx', 'r'].includes(flags));
    await step(s, 'open:' + flags);
    if (flags === 'wx') {
        assert.equal(mode, 0o600); assert.ok(!s.files.has(p)); s.files.set(p, Buffer.alloc(0));
    } else assert.ok(s.files.has(p));
    const token = {}; s.handles.add(token); let position = 0;
    return {
        async writeFile(data: Uint8Array | string) {
            assert.equal(flags, 'wx'); assert.ok(s.handles.has(token)); await step(s, 'write');
            s.files.set(p, Buffer.concat([s.files.get(p)!, Buffer.from(data)]));
        },
        async read(buffer: Buffer, offset: number, length: number, at: null) {
            assert.equal(flags, 'r'); assert.equal(at, null); assert.ok(s.handles.has(token));
            await step(s, 'read'); const data = s.files.get(p)!;
            const bytesRead = data.copy(buffer, offset, position, position + length);
            position += bytesRead; return { bytesRead, buffer };
        },
        async close() { await step(s, 'close:' + flags); assert.ok(s.handles.delete(token)); },
    };
}
export async function chmod(p: string, mode: number) { name(p); assert.equal(mode, 0o700); await step(current, 'chmod'); }
export async function rename(from: string, to: string) {
    name(from); name(to); const s = current; await step(s, 'rename');
    assert.ok(s.files.has(from)); s.files.set(to, s.files.get(from)!); s.files.delete(from);
}
export async function rm(p: string, options: unknown) {
    name(p); assert.deepEqual(options, { force: true }); const s = current;
    await step(s, 'rm'); s.files.delete(p);
}
export async function readFile(p: string, _encoding?: unknown) {
    name(p); if (!current.files.has(p)) throw Object.assign(Error('missing'), { code: 'ENOENT' });
    return current.files.get(p)!.toString();
}
export async function stat(p: string) {
    name(p); if (!current.files.has(p)) throw Object.assign(Error('missing'), { code: 'ENOENT' });
    return { size: current.files.get(p)!.length, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
}
export const lstat = stat;
export async function realpath(p: string) { return name(p); }

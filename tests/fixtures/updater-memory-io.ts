import assert from 'node:assert/strict';
const prefix = '/memory/updates/0.2.0/Diagnostic-Hub.exe';
const files = new Map<string, Buffer>();
let opens = 0, closes = 0, reads = 0;
let nextError: Error | undefined;
let nextGate: { entered: boolean; promise: Promise<void>; resolve(): void } | undefined;
function file(value: unknown) {
    assert.equal(typeof value, 'string');
    const s = value as string;
    assert.ok(s === prefix || /^\/memory\/updates\/0\.2\.0\/Diagnostic-Hub\.exe\.[a-f0-9-]{36}\.part$/.test(s));
    return s;
}
export const memory = {
    reset() { assert.equal(opens, closes); files.clear(); opens = closes = reads = 0; nextGate = undefined; nextError = undefined; },
    replace(name: string, bytes: Buffer) { assert.equal(file(name), prefix); assert.ok(files.has(name)); files.set(name, Buffer.from(bytes)); },
    holdRead() { assert.equal(nextGate, undefined); let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); const gate = { entered: false, promise, resolve }; nextGate = gate; return gate; },
    failRead(error: Error) { assert.equal(nextError, undefined); nextError = error; },
    stats() { return { opens, closes, reads, count: files.size }; },
};
export async function mkdir(name: string, options: unknown) { assert.equal(name, '/memory/updates/0.2.0'); assert.deepEqual(options, { recursive: true, mode: 0o700 }); }
export async function open(name: string, flags: string, mode: number) {
    file(name); assert.ok(name.endsWith('.part')); assert.equal(flags, 'wx'); assert.equal(mode, 0o600); assert.ok(!files.has(name)); assert.ok(++opens <= 4); files.set(name, Buffer.alloc(0)); let closed = false;
    return { async writeFile(bytes: Uint8Array) { assert.equal(closed, false); const data = Buffer.concat([files.get(name)!, bytes]); assert.ok(data.length <= 4096); files.set(name, data); }, async close() { assert.equal(closed, false); closed = true; closes++; } };
}
export async function chmod(name: string, mode: number) { file(name); assert.ok(files.has(name)); assert.equal(mode, 0o700); }
export async function rename(from: string, to: string) { file(from); assert.equal(file(to), prefix); const bytes = files.get(from); assert.ok(bytes); files.set(to, bytes); files.delete(from); }
export async function rm(name: string, options: unknown) { file(name); assert.ok(name.endsWith('.part')); assert.deepEqual(options, { force: true }); files.delete(name); }
export async function* createReadStream(name: string) {
    file(name); assert.ok(++reads <= 12); const data = files.get(name); assert.ok(data, 'Unexpected missing memory file'); const snapshot = Buffer.from(data); const gate = nextGate; nextGate = undefined;
    if (gate) { gate.entered = true; await gate.promise; }
    const error = nextError; nextError = undefined; if (error) throw error;
    yield snapshot;
}

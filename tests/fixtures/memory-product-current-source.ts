/** Source-subset verification only. No runtime, ownership, shutdown or release admission. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import inventory from './memory-product-current-source.json';

const manifestSHA256 = '7194f216f5ffb2737cd14e3ec74a9b232085abd0065ac2fdc364b653f764217b';
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
if (hash(JSON.stringify(inventory)) !== manifestSHA256)
    throw Error('Current source-subset manifest changed.');
for (const row of inventory.files) Object.freeze(row);
Object.freeze(inventory.files);
export const currentProductSourceManifest = Object.freeze(inventory);
type Row = Record<string, unknown>;
function row(value: unknown): Row {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    )
        throw Error('Source-only evidence must be a plain own-field object.');
    return value as Row;
}
function exact(value: unknown, keys: readonly string[]) {
    const object = row(value);
    if (
        Reflect.ownKeys(object).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(object, key))
    )
        throw Error('Source-only evidence has missing or unassessed fields.');
    return object;
}
function binding() {
    return Object.freeze({
        version: 2 as const,
        manifestSHA256,
        sourceCommit: inventory.sourceCommit,
        realm: 'source-only' as const,
        scope: 'reviewed-source-subset-only' as const,
        completeDependencyClosure: false as const,
        nativeAdmission: false as const,
        runtimeAttestation: false as const,
        pins: Object.freeze(
            Object.fromEntries(inventory.files.map((file) => [file.path, file.sha256])),
        ),
    });
}
export type CurrentSourceSubsetBinding = ReturnType<typeof binding>;

/** This pure schema check validates labels; only the explicit reader below checks source bytes. */
export function validateCurrentSourceSubsetBinding(input: unknown): CurrentSourceSubsetBinding {
    const expected = binding(),
        value = exact(input, Object.keys(expected));
    for (const key of Object.keys(expected).filter((key) => key !== 'pins'))
        if (value[key] !== expected[key as keyof typeof expected])
            throw Error('Source-only version, identity, realm or scope mismatch.');
    const pins = exact(value.pins, Object.keys(expected.pins));
    for (const [file, digest] of Object.entries(expected.pins))
        if (pins[file] !== digest) throw Error('Source-only preimage mismatch: ' + file);
    return expected;
}

export async function verifyCurrentSourceSubset(
    root: string,
    read: (file: string) => Promise<Uint8Array> = (file) => fs.readFile(file),
) {
    if (!path.isAbsolute(root)) throw Error('Explicit absolute source-only root required.');
    // Every target is checked. There is no native/gateway facet that can omit dependencies.
    for (const file of inventory.files) {
        const bytes = await read(path.join(root, file.path));
        if (
            !(bytes instanceof Uint8Array) ||
            bytes.byteLength !== file.bytes ||
            hash(bytes) !== file.sha256
        )
            throw Error('Current source-subset preimage changed: ' + file.path);
    }
    return binding();
}

/** A disposition carries the complete identity; it does not describe observed product state. */
export function sourceSubsetReceipt(input: unknown) {
    return Object.freeze({
        binding: validateCurrentSourceSubsetBinding(input),
        disposition: 'exact-source-subset' as const,
        sourceFiles: inventory.files.length,
        runtimeAttestation: false as const,
        nativeAdmission: false as const,
    });
}

/** The caller supplies its separately byte-verified binding; serialized labels alone are no attestation. */
export function verifySourceSubsetReceipt(input: unknown, verifiedBinding: unknown) {
    const expected = sourceSubsetReceipt(verifiedBinding),
        value = exact(input, Object.keys(expected));
    const accepted = validateCurrentSourceSubsetBinding(value.binding);
    for (const key of [
        'disposition',
        'sourceFiles',
        'runtimeAttestation',
        'nativeAdmission',
    ] as const)
        if (value[key] !== expected[key]) throw Error('Source-only disposition mismatch.');
    return sourceSubsetReceipt(accepted);
}

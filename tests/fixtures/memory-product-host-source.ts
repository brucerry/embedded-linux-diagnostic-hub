/** Node-side private harness preflight. No production import, listener or endpoint is installed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostPins, validateHostBinding, observeProductHost, type HostRealm,
    type HostSourceBinding } from './memory-product-host-ownership';
export async function verifyProductHostSources(root: string, realm: HostRealm,
    read: (file: string) => Promise<string> = file => fs.readFile(file, 'utf8')) {
    if (!path.isAbsolute(root)) throw Error('Explicit host source root required.');
    const pins = hostPins(realm);
    for (const [file, expected] of Object.entries(pins)) {
        const source = await read(path.join(root, file));
        if (createHash('sha256').update(source).digest('hex') !== expected)
            throw Error('Private host ownership preimage changed: ' + file);
    }
    const binding = validateHostBinding({ protocol: 1,
        production: '96a56cdbb462320c54fe74022d7436e665a31d31', realm, pins }, realm);
    Object.freeze(binding.pins);
    return Object.freeze(binding);
}

/** Register IPC synchronously; perform async source admission inside the captured init request. */
export function createProductHostObservation(root: string, realm: HostRealm,
    read?: (file: string) => Promise<string>) {
    let binding: HostSourceBinding | undefined, preparation: Promise<void> | undefined;
    return {
        beforeInit() {
            return preparation ??= (async () => { binding = await verifyProductHostSources(root, realm, read); })();
        },
        observeProductOwnership(snapshot: unknown) {
            if (!binding) throw Error('Host ownership source admission is unconfirmed.');
            return observeProductHost(snapshot, binding, realm);
        },
    };
}

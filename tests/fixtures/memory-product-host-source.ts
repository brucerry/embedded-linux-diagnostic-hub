import {
    observerSourceIdentity,
    type ObserverSourceProfile,
} from './memory-product-source-profile';
/** Node-side private harness preflight. No production import, listener or endpoint is installed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    hostPins,
    validateHostBinding,
    observeProductHost,
    type HostRealm,
    type HostSourceBinding,
} from './memory-product-host-ownership';
export async function verifyProductHostSources(
    root: string,
    realm: HostRealm,
    read: (file: string) => Promise<string> = (file) => fs.readFile(file, 'utf8'),
    profile: ObserverSourceProfile = 'historical-96a56cd',
) {
    if (!path.isAbsolute(root)) throw Error('Explicit host source root required.');
    const pins = hostPins(realm, profile);
    for (const [file, expected] of Object.entries(pins)) {
        const source = await read(path.join(root, file));
        if (createHash('sha256').update(source).digest('hex') !== expected)
            throw Error('Private host ownership preimage changed: ' + file);
    }
    const binding = validateHostBinding(
        { ...observerSourceIdentity(profile), realm, pins },
        realm,
        profile,
    );
    Object.freeze(binding.pins);
    return Object.freeze(binding);
}

/** Register IPC synchronously; perform async source admission inside the captured init request. */
export function createProductHostObservation(
    root: string,
    realm: HostRealm,
    read?: (file: string) => Promise<string>,
    profile: ObserverSourceProfile = 'historical-96a56cd',
) {
    let binding: HostSourceBinding | undefined, preparation: Promise<void> | undefined;
    return {
        beforeInit() {
            return (preparation ??= (async () => {
                binding = await verifyProductHostSources(root, realm, read, profile);
            })());
        },
        observeProductOwnership(snapshot: unknown) {
            if (!binding) throw Error('Host ownership source admission is unconfirmed.');
            return observeProductHost(snapshot, binding, realm, profile);
        },
    };
}

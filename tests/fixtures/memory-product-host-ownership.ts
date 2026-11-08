import {
    observerSourceIdentity,
    currentNativePinChanges,
    type ObserverSourceProfile,
} from './memory-product-source-profile';
/** Private qualification only. Reads existing local snapshots; never acknowledges or cleans work. */
export const hostOwnerSourcePins = Object.freeze({
    'backend/ssh/stream-host.ts':
        '224f9914811347f2b01de205b7c8d2664fdb5596a2524a38047109d1f7043e5c',
    'backend/ssh/session.ts': 'e62a116121347e2a1eec0415441bfee3bb908ad5e7b9819c6c7befba8f0bba5f',
    'gateway/server.ts': '5b3eac41a69a6e33c0761453618bf31dcb46d2a92294295f46026efecffd3fba',
});
export type HostRealm = 'gateway' | 'native';
const names = [
    'currentStates',
    'retiringStates',
    'producers',
    'readers',
    'pendingAcks',
    'pendingDataBytes',
    'shutdownWaiters',
] as const;
export type StreamCounts = Record<(typeof names)[number], number>;
export type HostSourceBinding = {
    protocol: number;
    sourceTree?: string;
    production: string;
    realm: HostRealm;
    pins: Record<string, string>;
};
type Row = Record<string, unknown>;
function object(value: unknown): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Host observation missing or malformed.');
    return value as Row;
}
function own(row: Row, key: string) {
    if (!Object.hasOwn(row, key)) throw Error('Host observation field absent: ' + key);
    return row[key];
}
function exact(row: Row, keys: readonly string[]) {
    for (const key of keys) own(row, key);
    if (Object.keys(row).some((key) => !keys.includes(key)))
        throw Error('Unassessed host observation field.');
}
function count(value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw Error('Host observation count malformed.');
    return value;
}
export function hostPins(realm: HostRealm, profile: ObserverSourceProfile = 'historical-96a56cd') {
    observerSourceIdentity(profile);
    if (realm !== 'gateway' && realm !== 'native')
        throw Error('Unsupported host observation realm.');
    return Object.fromEntries(
        Object.entries(
            profile === 'current-e9bb9bc'
                ? {
                      ...hostOwnerSourcePins,
                      'backend/ssh/session.ts': currentNativePinChanges['backend/ssh/session.ts'],
                  }
                : hostOwnerSourcePins,
        ).filter(([name]) => realm === 'gateway' || name !== 'gateway/server.ts'),
    );
}
/** A binding labels verified preimages. This pure function alone does not attest execution. */
export function validateHostBinding(
    input: unknown,
    realm: HostRealm,
    profile: ObserverSourceProfile = 'historical-96a56cd',
) {
    const row = object(input);
    const identity = observerSourceIdentity(profile);
    exact(row, [...Object.keys(identity), 'realm', 'pins']);
    if (Object.entries(identity).some(([key, value]) => row[key] !== value) || row.realm !== realm)
        throw Error('Unbound host observation source or realm.');
    const pins = object(row.pins),
        expected = hostPins(realm, profile);
    exact(pins, Object.keys(expected));
    for (const [file, hash] of Object.entries(expected))
        if (pins[file] !== hash) throw Error('Host observation preimage mismatch: ' + file);
    return { ...identity, realm, pins: { ...expected } };
}
function parseCounts(input: unknown, single: boolean): StreamCounts {
    const row = object(input);
    exact(row, names);
    const counts = Object.fromEntries(
        names.map((name) => [name, count(row[name])]),
    ) as StreamCounts;
    if (single && counts.currentStates > 1)
        throw Error('Host single-current-owner contract changed.');
    return counts;
}
export const observeHostStreams = (input: unknown) => parseCounts(input, true);
export function observeProductHost(
    input: unknown,
    bindingInput: unknown,
    realm: HostRealm,
    profile: ObserverSourceProfile = 'historical-96a56cd',
) {
    const binding = validateHostBinding(bindingInput, realm, profile),
        row = object(input);
    let sessions: unknown[];
    if (realm === 'gateway') {
        const all = own(row, 'allSessionOwners');
        if (!Array.isArray(all) || all.length !== count(own(row, 'ownedSessions')))
            throw Error('Gateway owned-session inventory incomplete.');
        sessions = all;
    } else sessions = [row];
    const owners = Object.fromEntries(names.map((name) => [name, 0])) as StreamCounts;
    for (const session of sessions) {
        const streams = observeHostStreams(own(object(session), 'streams'));
        for (const name of names) owners[name] = count(owners[name] + streams[name]);
    }
    return {
        binding,
        sessions: sessions.length,
        owners,
        custody: names.some((name) => owners[name] !== 0)
            ? ('pending' as const)
            : ('none-observed' as const),
        commandAcknowledgement: 'not-implied' as const,
        receiptMetadata: 'not-exposed' as const,
    };
}
export type ProductHostObservation = ReturnType<typeof observeProductHost>;
/** Recompute against the same actual snapshot; a separate RPC return is not retirement evidence. */
export function verifyProductHostObservation(
    input: unknown,
    actual: unknown,
    realm: HostRealm,
    profile: ObserverSourceProfile = 'historical-96a56cd',
) {
    const row = object(input);
    exact(row, [
        'binding',
        'sessions',
        'owners',
        'custody',
        'commandAcknowledgement',
        'receiptMetadata',
    ]);
    const expected = observeProductHost(actual, row.binding, realm, profile),
        owners = parseCounts(row.owners, false);
    // The aggregate can contain several current states; observeHostStreams enforces one per session.
    for (const name of names)
        if (owners[name] !== expected.owners[name])
            throw Error('Host snapshot/observation disagreement.');
    for (const name of [
        'sessions',
        'custody',
        'commandAcknowledgement',
        'receiptMetadata',
    ] as const)
        if (row[name] !== expected[name]) throw Error('Host observation disposition mismatch.');
    return expected;
}
export function assertHostStreamsRetired(
    observation: ProductHostObservation,
    profile: ObserverSourceProfile = 'historical-96a56cd',
) {
    const row = object(observation),
        binding = object(own(row, 'binding'));
    exact(row, [
        'binding',
        'sessions',
        'owners',
        'custody',
        'commandAcknowledgement',
        'receiptMetadata',
    ]);
    validateHostBinding(binding, binding.realm as HostRealm, profile);
    count(row.sessions);
    const owners = object(own(row, 'owners'));
    exact(owners, names);
    if (names.some((name) => count(owners[name]) !== 0) || own(row, 'custody') !== 'none-observed')
        throw Error('Host stream retirement is unconfirmed.');
    if (
        own(row, 'commandAcknowledgement') !== 'not-implied' ||
        own(row, 'receiptMetadata') !== 'not-exposed'
    )
        throw Error('Host stream receipt scope changed.');
    return {
        scope: 'observed-host-stream-custody-only' as const,
        commandAcknowledgement: 'not-implied' as const,
    };
}

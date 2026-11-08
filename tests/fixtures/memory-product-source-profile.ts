/** Source-only private observer binding; no historical receipt is migrated or qualified. */
export type ObserverSourceProfile = 'historical-96a56cd' | 'current-e9bb9bc';
export const currentObserverSource = Object.freeze({
    commit: 'e9bb9bc2c599fc47f7f422d7dcae291337b55478',
    tree: 'f1119793f8109d4d81faba07ace52f43e346e4e4',
    scope: 'private-source-preparation-only' as const,
});
export const currentNativePinChanges: Readonly<Record<string, string>> = Object.freeze({
    'electron/main.ts': '438abbc67d30de48c84f1c45eff2fe5362edb249ef83c53c38fd15f558b41d29',
    'electron/update-ownership.ts':
        '1a2e0a5b8622e6dd8e47e79cf33f467f282ecba63151b5b7ce0a4967c445e463',
    'electron/report-export.ts': '076fea3d89ffb3177d1a15fd49327da04e888fceee88b0d5571445cb0a15ca23',
    'electron/connection-attempts.ts':
        '5a32f0a7d165c02e7ca6177838addb37820115d25d4e59340d90163f02e7baa7',
    'backend/ssh/session.ts': '8cae1798cf782af8e6afe95c111d8dd177f69d525bacdd09df70c62b9460520f',
});
export function observerSourceIdentity(profile: ObserverSourceProfile) {
    if (profile === 'historical-96a56cd')
        return {
            protocol: 1,
            production: '96a56cdbb462320c54fe74022d7436e665a31d31',
        };
    if (profile !== 'current-e9bb9bc') throw Error('Unsupported observer source profile.');
    return {
        protocol: 2,
        production: currentObserverSource.commit,
        sourceTree: currentObserverSource.tree,
    };
}
export function observerMainPreimage(profile: ObserverSourceProfile) {
    observerSourceIdentity(profile);
    return profile === 'current-e9bb9bc'
        ? currentNativePinChanges['electron/main.ts']
        : '5c2fb3610fdf1801e521be69cc726572df82d4357c03a2c488695783855b78ef';
}

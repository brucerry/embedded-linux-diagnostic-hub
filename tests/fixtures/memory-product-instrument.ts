import { currentProductPinChanges } from './memory-product-renderer-source';
import {
    observerSourceIdentity,
    type ObserverSourceProfile,
} from './memory-product-source-profile';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Exact accepted preimages; changing a probe requires reviewing its lifetime fields again. */
export const productProbePreimages = [
    [
        'src/features/serial/session.ts',
        'SerialSession',
        'serial',
        '979ef0a9175fa9d96f6f916599e17282d2271723ca843b3431e626b53e70d464',
    ],
    [
        'src/features/automation/runner.ts',
        'FlowRunner',
        'runner',
        'cdb53f34a9c2a3bfd4cab64833b9f7f95c01bd4f7aba3d16a8944c5ddab5fa9a',
    ],
    [
        'src/features/automation/capture/indexeddb-store.ts',
        'IndexedDbCaptureStore',
        'repository',
        'c7e5c7c9b6caa52552b1e566bfdc67d9db5057d4d2385eba18a1ff819bd34fee',
    ],
    [
        'src/features/automation/capture/native-repository.ts',
        'NativeCaptureRepository',
        'native-repository',
        '31bb990c21c1c10af4cf98e38e6fe09688f5bfd232ce93e7d5b156b4ae19d52e',
    ],
    [
        'src/features/automation/capture/indexeddb-console.ts',
        'IndexedDbConsoleJournal',
        'console-journal',
        '9d80bd2305f7427331a95c4783ce7f5c18a5c2e96e6b44f67e99b9f214e46450',
    ],
    [
        'src/services/GatewayClient.ts',
        'GatewayClient',
        'gateway',
        'ecb2333ff9d63f281d13585ac24839be9b2c520107717d7dd7b1ba82dd990ced',
    ],
    [
        'src/features/automation/capture/ssh-stream-client.ts',
        'SshStreamClient',
        'ssh-stream-client',
        'a1b81822296844c8ae3abe5a97a486ff5eb5d9ad53f6520594f6d9ecf15599a3',
    ],
    [
        'backend/ssh/stream-host.ts',
        'SshStreamHost',
        'ssh-stream-host',
        '224f9914811347f2b01de205b7c8d2664fdb5596a2524a38047109d1f7043e5c',
    ],
    [
        'src/features/automation/activity-release.ts',
        'ActivityReleaseQueue',
        'activity-release',
        '5620edfd25a683e3ce82a01ab151896fe69314600f38ea0d88219bd2e66dc68b',
    ],
] as const;

const currentProbePreimages = Object.freeze(
    productProbePreimages.map(([file, name, kind, hash]) =>
        Object.freeze([file, name, kind, currentProductPinChanges[file] ?? hash] as const),
    ),
);
export function productProbePins(profile: ObserverSourceProfile = 'historical-96a56cd') {
    observerSourceIdentity(profile);
    return profile === 'current-e9bb9bc' ? currentProbePreimages : productProbePreimages;
}
function selectedPreimage(file: string, historical: string, profile: ObserverSourceProfile) {
    return profile === 'current-e9bb9bc'
        ? (currentProductPinChanges[file] ?? historical)
        : historical;
}
export function instrumentProductSource(
    source: string,
    id: string,
    profile: ObserverSourceProfile = 'historical-96a56cd',
) {
    observerSourceIdentity(profile);
    const normalized = id.replaceAll('\\', '/').split('?')[0];
    if (normalized.endsWith('/src/features/automation/AutomationPage.tsx')) {
        if (
            createHash('sha256').update(source).digest('hex') !==
            selectedPreimage(
                'src/features/automation/AutomationPage.tsx',
                'ea978e8dfe36aaedaf763db7102892c82ca0ac298fbd36d9994cc1d72456cab4',
                profile,
            )
        )
            throw Error('Actual Automation Page ref preimage changed.');
        const needle = '    latest.current = props;';
        const begin = '    const start = async (once = false) => {',
            end = '    };\n    const edit = (id: string, patch: Partial<CommandStep>) =>';
        if (source.split(begin).length !== 2 || source.split(end).length !== 2)
            throw Error('Actual Page Start continuation boundary changed.');
        if (source.split(needle).length !== 2)
            throw Error('Actual Page inspection ref boundary changed.');
        return {
            code:
                "import {trackProductPageRefs as __observeProductPageRefs,trackProductPageRun as __trackProductPageRun} from '/tests/fixtures/memory-product-page-refs';\n" +
                source
                    .replace(
                        needle,
                        needle +
                            '\n    __observeProductPageRefs(flowInspectionId, activityEpoch, {arming, armAttempt, cleanupActivity, cleanupActivityRetirement, cleanupClock, cleanupConsoleResults, pendingClockSamples});',
                    )
                    .replace(
                        begin,
                        '    const start = __trackProductPageRun(async (once = false) => {',
                    )
                    .replace(
                        end,
                        '    });\n    const edit = (id: string, patch: Partial<CommandStep>) =>',
                    ),
            map: null,
        };
    }
    if (normalized.endsWith('/src/features/automation/capture/browser-export.ts')) {
        if (
            createHash('sha256').update(source).digest('hex') !==
            selectedPreimage(
                'src/features/automation/capture/browser-export.ts',
                'c7122f17851177d7eebc1dd9cdca4978812756f7ab5881fb9d6428507de8de6b',
                profile,
            )
        )
            throw Error('Browser export ownership preimage changed.');
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const begin = '    return new Promise((resolve, reject) => {',
            end = `    });${newline}}${newline}export interface BrowserExportDiagnostic {`;
        if (source.split(begin).length !== 2 || source.split(end).length !== 2)
            throw Error('Actual page export RPC boundary changed.');
        return {
            code:
                source
                    .replace(
                        begin,
                        '    return __memoryTrackExportRpc(new Promise((resolve, reject) => {',
                    )
                    .replace(
                        end,
                        `    }));${newline}}${newline}export interface BrowserExportDiagnostic {`,
                    ) +
                String.raw`
let __memoryExportRpcs=0;
function __memoryTrackExportRpc<T>(task:Promise<T>){__memoryExportRpcs++;const release=()=>{__memoryExportRpcs--;};void task.then(release,release);return task;}
(globalThis as any).__memoryBrowserExports=()=>({active:activeExports,rpc:__memoryExportRpcs,helpers:helpers.length,busyHelpers:helpers.filter(helper=>helper.busy).length,connectedHelpers:helpers.filter(helper=>helper.frame.isConnected).length});
`,
            map: null,
        };
    }
    const match = productProbePins(profile).find(([file]) => normalized.endsWith('/' + file));
    if (!match) return null;
    const [file, name, kind, expected] = match;
    const actual = createHash('sha256').update(source).digest('hex');
    if (actual !== expected)
        throw Error(`Qualification probe preimage changed: ${file} (${actual}).`);
    const clause: Record<string, string> = {
        IndexedDbCaptureStore: ' implements CaptureRepository',
        NativeCaptureRepository: ' implements CaptureRepository',
        IndexedDbConsoleJournal: ' implements ConsoleRepository, ConsoleArchive',
        GatewayClient: ' implements TerminalTransport',
    };
    const needle = `export class ${name}${clause[name] ?? ''} {`;
    if (source.split(needle).length !== 2)
        throw Error(`Ambiguous qualification constructor: ${file}`);
    let instrumented = source.replace(
        needle,
        needle + `\n private readonly __qualificationProbe = __trackProduct('${kind}', this);`,
    );
    if (kind === 'gateway') {
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const begin = '        void (async () => {',
            end = `        })();${newline}        return ready;`;
        if (instrumented.split(begin).length !== 2 || instrumented.split(end).length !== 2)
            throw Error('Gateway actual HTTP reader boundary changed.');
        instrumented = instrumented
            .replace(begin, "        void __trackProductTask(this, 'httpReader', (async () => {")
            .replace(end, `        })());${newline}        return ready;`);
    }
    if (kind === 'repository') {
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const begin = '            this.releasing = (async () => {',
            end = `            })();${newline}            void this.releasing.catch(() => {});`;
        if (instrumented.split(begin).length !== 2 || instrumented.split(end).length !== 2)
            throw Error('Actual versionchange release boundary changed.');
        instrumented = instrumented
            .replace(
                begin,
                "            this.releasing = __trackProductTask(this, 'cleanup', (async () => {",
            )
            .replace(
                end,
                `            })());${newline}            void this.releasing.catch(() => {});`,
            );
    }
    return {
        code:
            `import {trackProduct as __trackProduct,trackProductTask as __trackProductTask} from '/tests/fixtures/memory-product-registry';\n` +
            instrumented,
        map: null,
    };
}

export function productQualificationPlugin(
    profile: ObserverSourceProfile = 'historical-96a56cd',
): Plugin {
    observerSourceIdentity(profile);
    return {
        name: 'private-product-qualification',
        enforce: 'pre',
        transform: (source, id) => instrumentProductSource(source, id, profile),
    };
}

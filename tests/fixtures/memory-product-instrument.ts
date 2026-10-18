import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Exact accepted preimages; changing a probe requires reviewing its lifetime fields again. */
export const productProbePreimages = [
    [
        'src/features/serial/session.ts',
        'SerialSession',
        'serial',
        '3484cb5a071f82822a2fd26d46bbf38748ebdd267c759f910f7f50b9e7a8db51',
    ],
    [
        'src/features/automation/runner.ts',
        'FlowRunner',
        'runner',
        'd51a8e73d6aa319cb8acfe88bd13f31fbb24d25017df3af946c90d80f168c5ce',
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
] as const;

export function instrumentProductSource(source: string, id: string) {
    const normalized = id.replaceAll('\\', '/').split('?')[0];
    if (normalized.endsWith('/src/features/automation/AutomationPage.tsx')) {
        if (
            createHash('sha256').update(source).digest('hex') !==
            'e9629c89f18c26bc015018f6206fd152363e055364b63eb15cd6efc322f61be3'
        )
            throw Error('Actual Automation Page ref preimage changed.');
        const needle = '    const flowInspectionId = useRef<string | null>(null);';
        if (source.split(needle).length !== 2)
            throw Error('Actual Page inspection ref boundary changed.');
        return {
            code:
                "import {trackProductPageRefs as __observeProductPageRefs} from '/tests/fixtures/memory-product-page-refs';\n" +
                source.replace(
                    needle,
                    needle + '\n    __observeProductPageRefs(flowInspectionId, activityEpoch);',
                ),
            map: null,
        };
    }
    if (normalized.endsWith('/src/features/automation/capture/browser-export.ts')) {
        if (
            createHash('sha256').update(source).digest('hex') !==
            'b5809fbfc213feea85eb989796333bec93395b4ed394e83112c7312f862dbf7a'
        )
            throw Error('Browser export ownership preimage changed.');
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const begin = '    return new Promise((resolve, reject) => {',
            end = `    });${newline}}${newline}/** Called from an explicit browser export action; requires the web build's narrowly scoped helper. */`;
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
                        `    }));${newline}}${newline}/** Called from an explicit browser export action; requires the web build's narrowly scoped helper. */`,
                    ) +
                String.raw`
let __memoryExportRpcs=0;
function __memoryTrackExportRpc<T>(task:Promise<T>){__memoryExportRpcs++;const release=()=>{__memoryExportRpcs--;};void task.then(release,release);return task;}
(globalThis as any).__memoryBrowserExports=()=>({active:activeExports,rpc:__memoryExportRpcs,helpers:helpers.length,busyHelpers:helpers.filter(helper=>helper.busy).length,connectedHelpers:helpers.filter(helper=>helper.frame.isConnected).length});
`,
            map: null,
        };
    }
    const match = productProbePreimages.find(([file]) => normalized.endsWith('/' + file));
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

export function productQualificationPlugin(): Plugin {
    return {
        name: 'private-product-qualification',
        enforce: 'pre',
        transform: instrumentProductSource,
    };
}

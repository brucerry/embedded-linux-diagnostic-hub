import { IndexedDbCaptureStore } from '../../src/features/automation/capture/indexeddb-store';
import { NativeCaptureRepository } from '../../src/features/automation/capture/native-repository';
import { serialCaptureBackend } from '../../src/features/automation/capture/serial-backend';
import { sshCaptureBackend } from '../../src/features/automation/capture/ssh-backend';
import { SerialSession } from '../../src/features/serial/session';
import { GatewayClient } from '../../src/services/GatewayClient';
import { FlowRunner } from '../../src/features/automation/runner';
import { DEFAULT_SERIAL_SETTINGS } from '../../shared/serial';
import type { AutomationPlan } from '../../shared/automation';
import { streamCaptureReport } from '../../shared/capture-report';
import { serialCaptureFixture } from './serial-capture';
import { Owners, type ViewerQualificationHook } from './memory-resource-core';
import type { CaptureRepository } from '../../shared/capture-store';

const owners = new Owners();
const name = `diagnostic-hub-captures-test-${crypto.randomUUID()}-v1`;
let viewer: ViewerQualificationHook | undefined;
const check = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
};
async function openStore(native: boolean): Promise<CaptureRepository> {
    if (native) return NativeCaptureRepository.open(window.diagnosticHub!.captureStorage!);
    return IndexedDbCaptureStore.open(name);
}
/** Component entry only. Product navigation/UI coverage needs the composed product adapter. */
const api = {
    attachViewer(hook: ViewerQualificationHook) {
        viewer = hook;
    },
    snapshot() {
        return { abandonedOwners: owners.snapshot().length };
    },
    async cycle(context: {
        lane: string;
        ordinal: number;
        payloadBytes: number;
        catalogMode: string;
        gateway?: { url: string; token: string; options: Parameters<GatewayClient['connect']>[0] };
    }) {
        const store = await openStore(context.lane === 'desktop');
        const release = owners.take('repository', name);
        const fixture = serialCaptureFixture(async function* () {
            for (let i = 0; i < context.payloadBytes; i += 16384)
                yield new Uint8Array(Math.min(16384, context.payloadBytes - i)).fill(65);
            yield new TextEncoder().encode('\r\nboard# ');
        });
        const session = new SerialSession(async () => {});
        const gateway = context.gateway ? new GatewayClient(context.gateway) : undefined;
        let capturedBytes = 0,
            exportedBytes = 0;
        let state = '',
            completion = '';
        const runner = new FlowRunner(
            (next) => {
                state = next.state;
            },
            (row) => {
                completion = row.completion;
                capturedBytes += row.stored?.committedBytes ?? 0;
            },
        );
        const plan: AutomationPlan = {
            transport: gateway ? 'ssh' : 'serial',
            start: null,
            repeatSeconds: null,
            timeoutSeconds: 120,
            serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
            steps: [
                {
                    id: 'one',
                    name: 'Synthetic soak',
                    command: 'memory-soak',
                    enabled: true,
                    delaySeconds: 0,
                },
            ],
        };
        const coverage = [
            'run-success',
            'same-generation-rearm',
            'connect-disconnect',
            'clear-reopen',
            'constant-catalog',
        ];
        let readable: ReadableStream<Uint8Array> | null = null,
            writable: WritableStream<Uint8Array> | null = null;
        try {
            if (gateway) await gateway.connect(context.gateway!.options);
            else {
                session.select(fixture.port, 'soak UART');
                await session.connect(DEFAULT_SERIAL_SETTINGS);
                readable = fixture.port.readable;
                writable = fixture.port.writable;
            }
            const backend = () =>
                gateway
                    ? sshCaptureBackend(
                          gateway,
                          store,
                          'gateway',
                          { endpoint: 'synthetic loopback' },
                          () => Boolean(gateway.automationConnection()),
                      )
                    : serialCaptureBackend(session, store);
            await runner.start(plan, backend());
            check(
                state === 'finished' &&
                    (gateway ? completion === 'exit' : completion === 'prompt-observed'),
                'Capture did not finish truthfully.',
            );
            await runner.start(plan, backend());
            check(state === 'finished', 'Explicit same-generation rearm failed.');
            if (context.payloadBytes > 32 * 1024 ** 2) coverage.push('large-slow-capture');
            if (gateway) coverage.push('stdout-stderr');
            for (const format of ['json', 'csv', 'markdown', 'text'] as const) {
                const exportRelease = owners.take('export', format);
                let chunks = 0;
                try {
                    for await (const chunk of streamCaptureReport(store, format)) {
                        exportedBytes += chunk.length;
                        if (++chunks % 64 === 0) await new Promise((done) => setTimeout(done, 0));
                    }
                } finally {
                    exportRelease();
                }
                coverage.push(`export-${format}`);
            }
            // Native/IDB read iterator cancellation must acknowledge its lease before clear.
            const rows = (await store.page()).records;
            const read = store.read(rows[0].id)[Symbol.asyncIterator]();
            await read.next();
            await read.return?.();
            if (viewer) {
                coverage.push(
                    ...(await viewer.exercise({
                        ordinal: context.ordinal,
                        reducedMotion: context.ordinal % 2 === 0,
                    })),
                );
                await viewer.dispose();
                for (const [kind, count] of Object.entries(await viewer.snapshot()))
                    check(count === 0, `Viewer owner ${kind} remains.`);
            }
            // Constant cardinality deliberately releases disk records before the retained sample.
            for (const row of rows) await store.delete(row.id);
            check((await store.page()).records.length === 0, 'Fixture clear left records.');
        } finally {
            runner.cancel();
            await session.close(true);
            await gateway?.disconnect();
            check(
                !readable?.locked && !writable?.locked && !session.isOwned,
                'Serial locks/owner survived disconnect.',
            );
            await store.close();
            release();
        }
        const reopened = await openStore(context.lane === 'desktop');
        try {
            check((await reopened.page()).records.length === 0, 'Reopen changed clear state.');
        } finally {
            await reopened.close();
        }
        owners.empty('browser component teardown');
        return {
            coverage,
            capturedBytes,
            exportedBytes,
            diskBytes:
                context.lane === 'desktop'
                    ? null
                    : ((await navigator.storage.estimate()).usage ?? null),
            diskRecords: 0,
            cache: {
                state: 'repository closed; no retained canonical captures',
                diskAccounting:
                    'Origin estimate includes intentional IDB allocation/cache after clear; native size supplied by external fixture observer.',
                componentOnly:
                    'navigation/unmount and bounded growing catalog require product adapter',
            },
        };
    },
};
declare global {
    interface Window {
        memoryResourceQA: typeof api;
    }
}
window.memoryResourceQA = api;

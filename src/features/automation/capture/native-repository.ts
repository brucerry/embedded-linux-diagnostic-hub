import {
    captureRpcRequest,
    type CaptureRpcRequest,
    type CaptureRpcTransport,
} from '../../../../shared/capture-rpc';
import {
    CaptureStorageError,
    boundedCapturePage,
    storedCapture,
    validateFrame,
    validId,
    integer,
    type CaptureHeader,
    type CaptureFrame,
    type CaptureRead,
    type CaptureRepository,
    type CapturePage,
} from '../../../../shared/capture-store';
import { automationOutcome, type AutomationOutcome } from '../../../../shared/automation-result';

export class NativeCaptureRepository implements CaptureRepository {
    recoveryFailure?: CaptureStorageError;
    private constructor(private transport: CaptureRpcTransport) {}
    static async open(transport: CaptureRpcTransport) {
        const store = new NativeCaptureRepository(transport);
        await store.refreshInfo();
        return store;
    }
    private async refreshInfo() {
        const info = (await this.call({ op: 'info' })) as {
            schema: number;
            recoveryFailure?: { code: CaptureStorageError['code']; message: string } | null;
        };
        if (info?.schema !== 1)
            throw new CaptureStorageError(
                'unsupported',
                'This desktop version does not support full capture.',
            );
        if (
            info.recoveryFailure &&
            (typeof info.recoveryFailure.message !== 'string' ||
                ![
                    'quota',
                    'permission',
                    'io',
                    'unsupported',
                    'busy',
                    'invalid',
                    'integrity',
                    'backlog',
                ].includes(info.recoveryFailure.code))
        )
            throw new CaptureStorageError('integrity', 'Invalid native recovery status.');
        this.recoveryFailure = info.recoveryFailure
            ? new CaptureStorageError(info.recoveryFailure.code, info.recoveryFailure.message)
            : undefined;
    }
    private async call(request: CaptureRpcRequest) {
        captureRpcRequest(request);
        const reply = await this.transport(request);
        if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean')
            throw new CaptureStorageError('integrity', 'Invalid native capture response.');
        if (!reply.ok) {
            const error = reply.error;
            if (
                !error ||
                ![
                    'quota',
                    'permission',
                    'io',
                    'unsupported',
                    'busy',
                    'invalid',
                    'integrity',
                    'backlog',
                ].includes(error.code) ||
                typeof error.message !== 'string'
            )
                throw new CaptureStorageError('integrity', 'Invalid native failure response.');
            throw new CaptureStorageError(error.code as CaptureStorageError['code'], error.message);
        }
        return reply.value;
    }
    async begin(header: CaptureHeader) {
        return storedCapture(
            (await this.call({ op: 'begin', header })) as Parameters<typeof storedCapture>[0],
        );
    }
    async append(id: string, frames: readonly CaptureFrame[]) {
        return storedCapture(
            (await this.call({ op: 'append', id, frames })) as Parameters<typeof storedCapture>[0],
        );
    }
    async seal(id: string, observedBytes: number, reason: string) {
        return storedCapture(
            (await this.call({ op: 'seal', id, observedBytes, reason })) as Parameters<
                typeof storedCapture
            >[0],
        );
    }
    async fail(id: string, observedBytes: number | null, error: CaptureStorageError) {
        await this.call({
            op: 'fail',
            id,
            observedBytes,
            error: { code: error.code, message: error.message },
        });
    }
    async record(id: string, outcome: AutomationOutcome) {
        await this.call({ op: 'record', id, outcome });
    }
    async result(id: string) {
        const value = await this.call({ op: 'result', id });
        return value === null ? null : automationOutcome(value);
    }
    async page(after = 0, limit = 100, through = Number.MAX_SAFE_INTEGER) {
        const value = (await this.call({ op: 'page', after, limit, through })) as CapturePage;
        if (!value || !Array.isArray(value.records) || value.records.length > 100)
            throw new CaptureStorageError('integrity', 'Invalid native catalog page.');
        if (value.next !== null) integer(value.next, after + 1);
        const page = boundedCapturePage({
            records: value.records.map(storedCapture),
            next: value.next,
        });
        await this.refreshInfo();
        return page;
    }
    async *read(id: string): AsyncGenerator<CaptureRead> {
        const lease = (await this.call({ op: 'read', id })) as { handle: string };
        validId(lease.handle);
        try {
            let first = true;
            while (true) {
                const batch = (await this.call({ op: 'pull', handle: lease.handle })) as {
                    events: CaptureRead[];
                    done: boolean;
                };
                if (
                    !batch ||
                    !Array.isArray(batch.events) ||
                    batch.events.length > 3 ||
                    typeof batch.done !== 'boolean'
                )
                    throw new CaptureStorageError('integrity', 'Invalid native output batch.');
                for (const event of batch.events) {
                    if (event.type === 'metadata') {
                        if (!first)
                            throw new CaptureStorageError(
                                'integrity',
                                'Unexpected native metadata.',
                            );
                        const capture = storedCapture(event.capture);
                        if (capture.id !== id)
                            throw new CaptureStorageError(
                                'integrity',
                                'Native read returned another capture.',
                            );
                        yield { type: 'metadata', capture };
                    } else {
                        if (first)
                            throw new CaptureStorageError(
                                'integrity',
                                'Native output arrived before metadata.',
                            );
                        validateFrame(event.frame);
                        yield event;
                    }
                    first = false;
                }
                if (batch.done) {
                    if (first)
                        throw new CaptureStorageError(
                            'integrity',
                            'Native output omitted metadata.',
                        );
                    break;
                }
            }
        } finally {
            await this.call({ op: 'return', handle: lease.handle });
        }
    }
    async delete(id: string) {
        await this.call({ op: 'delete', id });
    }
    async close() {
        await this.call({ op: 'close' });
    }
    async pin() {
        const lease = (await this.call({ op: 'pin' })) as { handle: string; through: number };
        validId(lease.handle);
        integer(lease.through);
        let released = false;
        return {
            through: lease.through,
            release: async () => {
                if (!released) {
                    await this.call({ op: 'unpin', handle: lease.handle });
                    released = true;
                }
            },
        };
    }
}

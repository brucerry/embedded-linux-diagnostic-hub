import { captureScope } from '../../../../shared/capture-query';
import { CaptureStorageError, type CaptureRepository } from '../../../../shared/capture-store';
import {
    streamCaptureReport,
    type CaptureReportFormat,
    type CaptureReportScope,
} from '../../../../shared/capture-report';

export interface ExportClient {
    id: string;
    url: string;
    frameType?: string;
}
export interface ExportEnvironment {
    scope: string;
    now(): number;
    client(id: string): Promise<ExportClient | undefined>;
    clients(): Promise<ExportClient[]>;
    notify(id: string, message: unknown): Promise<void>;
}
/** Trusted construction-time encoders. Client requests select only the two fixed source kinds. */
export interface ExportReportSource {
    validateScope(input: unknown): CaptureReportScope;
    pin(): Promise<{ through: number; release(): Promise<void> }>;
    streamReport(
        format: CaptureReportFormat,
        scope: CaptureReportScope,
        through: number,
        progress: () => Promise<void>,
    ): AsyncGenerator<Uint8Array>;
    filename: 'automation-results' | 'console-results';
}
export function captureExportSource(store: CaptureRepository): ExportReportSource {
    return {
        validateScope: captureScope,
        pin: () => store.pin(),
        streamReport: (format, scope, through, progress) =>
            streamCaptureReport(store, format, scope, through, progress),
        filename: 'automation-results',
    };
}
interface Job {
    id: string;
    token: string;
    nonce: string;
    owner: string;
    frame?: string;
    frameUrl: string;
    format: CaptureReportFormat;
    scope: CaptureReportScope;
    source: ExportReportSource;
    state: 'prepared' | 'claimed' | 'redeeming' | 'verifying' | 'streaming' | 'closing';
    deadline: number;
    bytes: number;
    lastOwnerCheck: number;
    pin: Awaited<ReturnType<CaptureRepository['pin']>>;
    iterator?: AsyncGenerator<Uint8Array>;
    ending?: Promise<void>;
    failure?: string;
    done: Promise<void>;
    resolveDone(): void;
    watchdog?: ReturnType<typeof setTimeout>;
}
interface Finished {
    owner: string;
    deadline: number;
    state: 'stream-sent' | 'failed';
    bytes: number;
    error?: string;
}
/** Tokens select only a server-owned job, never a database, filename or network URL. */
export class CaptureExportBroker {
    private jobs = new Map<string, Job>();
    private finished = new Map<string, Finished>();
    private preparing = 0;
    private source: ExportReportSource;
    constructor(
        store: CaptureRepository | ExportReportSource,
        private env: ExportEnvironment,
        private ttl = 60000,
        private consoleSource?: ExportReportSource,
    ) {
        this.source = 'streamReport' in store ? store : captureExportSource(store);
    }
    private inScope(client: ExportClient) {
        const url = new URL(client.url);
        const scope = new URL(this.env.scope);
        return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
    }
    private async owner(id: string) {
        const client = await this.env.client(id);
        if (!client || !this.inScope(client))
            throw new CaptureStorageError(
                'invalid',
                'Export client is no longer available in this site.',
            );
        return client;
    }
    private end(job: Job, error?: unknown): Promise<void> {
        if (job.ending) return job.ending;
        if (!this.jobs.has(job.id)) return Promise.resolve();
        job.state = 'closing';
        if (error)
            job.failure = String(error instanceof Error ? error.message : error).slice(0, 512);
        return (job.ending = (async () => {
            try {
                if (job.failure)
                    await this.env
                        .notify(job.owner, {
                            type: 'capture-export-status',
                            id: job.id,
                            state: 'failed',
                            error: job.failure,
                            bytes: job.bytes,
                            cleanupPending: true,
                        })
                        .catch(() => {});
                await job.pin.release();
            } catch (releaseError) {
                error ??= releaseError;
            } finally {
                clearTimeout(job.watchdog);
                this.jobs.delete(job.id);
                const result: Finished = {
                    owner: job.owner,
                    deadline: this.env.now() + 5 * 60000,
                    state: error ? 'failed' : 'stream-sent',
                    bytes: job.bytes,
                    ...(error
                        ? {
                              error: String(error instanceof Error ? error.message : error).slice(
                                  0,
                                  512,
                              ),
                          }
                        : {}),
                };
                this.finished.set(job.id, result);
                while (this.finished.size > 32)
                    this.finished.delete(this.finished.keys().next().value!);
                await this.env
                    .notify(job.owner, { type: 'capture-export-status', id: job.id, ...result })
                    .catch(() => {});
                job.resolveDone();
            }
        })());
    }
    private async progress(job: Job) {
        if (
            !this.jobs.has(job.id) ||
            !['verifying', 'streaming'].includes(job.state) ||
            job.deadline < this.env.now()
        )
            throw new CaptureStorageError(
                'io',
                'Export expired or was cancelled during stored-output filtering.',
            );
        job.deadline = this.env.now() + this.ttl;
        if (this.env.now() - job.lastOwnerCheck >= 1000) {
            await this.owner(job.owner);
            job.lastOwnerCheck = this.env.now();
        }
    }
    private watch(job: Job) {
        clearTimeout(job.watchdog);
        job.watchdog = setTimeout(
            () => {
                void this.clean()
                    .catch(() => {})
                    .finally(() => {
                        if (this.jobs.has(job.id) && job.state !== 'closing') this.watch(job);
                    });
            },
            Math.max(1, job.deadline - this.env.now() + 1),
        );
    }
    private async clean() {
        for (const [id, record] of this.finished)
            if (record.deadline < this.env.now()) this.finished.delete(id);
        for (const job of [...this.jobs.values()])
            if (job.deadline < this.env.now()) {
                job.state = 'closing';
                job.failure = 'Export expired or download stopped consuming data.';
                await job.iterator?.return(undefined).catch(() => {});
                await this.end(
                    job,
                    new CaptureStorageError(
                        'io',
                        'Export expired or download stopped consuming data.',
                    ),
                );
            }
    }
    async prepare(
        owner: string,
        format: CaptureReportFormat,
        scope: CaptureReportScope = {},
        kind: 'capture' | 'console' = 'capture',
    ) {
        await this.clean();
        await this.owner(owner);
        if (kind !== 'capture' && kind !== 'console')
            throw new CaptureStorageError('invalid', 'Invalid export source.');
        const source = kind === 'console' ? this.consoleSource : this.source;
        if (!source)
            throw new CaptureStorageError(
                'unsupported',
                'Console export is unavailable in this runtime.',
            );
        scope = source.validateScope(scope);
        if (!['json', 'csv', 'markdown', 'text'].includes(format))
            throw new CaptureStorageError('invalid', 'Invalid export format.');
        if (this.jobs.size + this.preparing >= 8)
            throw new CaptureStorageError('busy', 'Finish or cancel another export first.');
        this.preparing++;
        try {
            const id = crypto.randomUUID(),
                token = crypto.randomUUID(),
                nonce = crypto.randomUUID(),
                pin = await source.pin();
            const frameUrl = new URL('__capture_export_frame/' + nonce, this.env.scope).href;
            let resolveDone!: () => void;
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });
            const job: Job = {
                id,
                token,
                nonce,
                owner,
                frameUrl,
                format,
                scope: structuredClone(scope),
                source,
                state: 'prepared',
                deadline: this.env.now() + this.ttl,
                bytes: 0,
                lastOwnerCheck: this.env.now(),
                pin,
                done,
                resolveDone,
            };
            this.jobs.set(id, job);
            this.watch(job);
            return { id, frameUrl, nonce, through: pin.through };
        } finally {
            this.preparing--;
        }
    }
    async frame(nonce: string, resultingClientId: string) {
        await this.clean();
        const job = [...this.jobs.values()].find((job) => job.nonce === nonce);
        if (!job || job.frame || !resultingClientId)
            throw new CaptureStorageError(
                'invalid',
                'Export helper expired or was already opened.',
            );
        job.frame = resultingClientId;
        await this.owner(job.owner);
        return job.id;
    }
    async claim(nonce: string, clientId: string) {
        await this.clean();
        const job = [...this.jobs.values()].find((job) => job.nonce === nonce);
        if (!job || job.frame !== clientId || job.state !== 'prepared')
            throw new CaptureStorageError('invalid', 'Export helper does not own this job.');
        job.state = 'claimed';
        const client = await this.owner(clientId);
        await this.owner(job.owner);
        if (client.url !== job.frameUrl || client.frameType !== 'nested')
            throw new CaptureStorageError('invalid', 'Export helper identity changed.');
        if (!this.jobs.has(job.id) || job.state !== 'claimed')
            throw new CaptureStorageError(
                'io',
                'Export cancelled while the helper was claiming it.',
            );
        return { url: new URL('__capture_export/' + job.token, this.env.scope).href, id: job.id };
    }
    async download(token: string, context: { clientId: string; referrer: string; mode: string }) {
        await this.clean();
        const job = [...this.jobs.values()].find((job) => job.token === token);
        if (!job || job.state !== 'claimed' || !job.frame)
            throw new CaptureStorageError(
                'invalid',
                'Export token expired or was already consumed.',
            );
        job.state = 'redeeming';
        try {
            await this.owner(job.owner);
            const frame = await this.owner(job.frame);
            if (
                frame.url !== job.frameUrl ||
                frame.frameType !== 'nested' ||
                context.mode !== 'navigate'
            )
                throw new CaptureStorageError(
                    'invalid',
                    'Export navigation does not own this job.',
                );
            if (context.clientId) {
                if (context.clientId !== job.frame)
                    throw new CaptureStorageError('invalid', 'Export belongs to another client.');
            } else {
                // Firefox/WebKit omit clientId for attachment navigation. A reserved one-use helper
                // document supplies an unforgeable navigation referrer; duplicate documents fail closed.
                const matching = (await this.env.clients()).filter(
                    (client) => client.url === job.frameUrl,
                );
                if (
                    context.referrer !== job.frameUrl ||
                    matching.length !== 1 ||
                    matching[0].id !== job.frame
                )
                    throw new CaptureStorageError(
                        'invalid',
                        'Export helper navigation provenance is unavailable.',
                    );
            }
            if (!this.jobs.has(job.id) || job.state !== 'redeeming')
                throw new CaptureStorageError(
                    'io',
                    'Export cancelled while navigation was being authorized.',
                );
        } catch (error) {
            if (this.jobs.has(job.id) && job.state === 'redeeming') job.state = 'claimed';
            throw error;
        }
        job.state = 'verifying';
        job.deadline = this.env.now() + this.ttl;
        this.watch(job);
        // Verify the entire pinned prefix before opening an attachment. Missing/corrupt blocks
        // then fail without creating a partial download or invoking browser-native error dialogs.
        job.iterator = job.source.streamReport('json', job.scope, job.pin.through, () =>
            this.progress(job),
        );
        try {
            for await (const ignored of job.iterator) {
                void ignored;
                if (!this.jobs.has(job.id) || job.state !== 'verifying')
                    throw new CaptureStorageError('io', 'Export cancelled during verification.');
                job.deadline = this.env.now() + this.ttl;
                if (this.env.now() - job.lastOwnerCheck >= 1000) {
                    await this.owner(job.owner);
                    job.lastOwnerCheck = this.env.now();
                }
            }
            if (!this.jobs.has(job.id) || job.state !== 'verifying')
                throw new CaptureStorageError('io', 'Export cancelled during verification.');
        } catch (error) {
            await this.end(job, error);
            throw error;
        }
        job.state = 'streaming';
        job.iterator = job.source.streamReport(job.format, job.scope, job.pin.through, () =>
            this.progress(job),
        );
        const stream = new ReadableStream<Uint8Array>(
            {
                pull: async (controller) => {
                    try {
                        if (
                            !this.jobs.has(job.id) ||
                            job.state !== 'streaming' ||
                            job.deadline < this.env.now()
                        )
                            throw new CaptureStorageError('io', 'Export expired or was cancelled.');
                        if (this.env.now() - job.lastOwnerCheck >= 1000) {
                            await this.owner(job.owner);
                            job.lastOwnerCheck = this.env.now();
                        }
                        const result = await job.iterator!.next();
                        if (!this.jobs.has(job.id) || job.state !== 'streaming')
                            throw new CaptureStorageError(
                                'io',
                                'Export cancelled while reading stored output.',
                            );
                        if (result.done) {
                            controller.close();
                            await this.end(job);
                        } else {
                            job.bytes += result.value.byteLength;
                            job.deadline = this.env.now() + this.ttl;
                            controller.enqueue(result.value);
                        }
                    } catch (error) {
                        await job.iterator!.return(undefined).catch(() => {});
                        await this.end(job, error);
                        controller.error(error);
                    }
                },
                cancel: async (reason) => {
                    job.state = 'closing';
                    job.failure = 'Download cancelled.';
                    await job.iterator!.return(undefined).catch(() => {});
                    await this.end(job, reason ?? Error('Download cancelled.'));
                },
            },
            { highWaterMark: 1 },
        );
        const suffix = { json: 'json', csv: 'csv', markdown: 'md', text: 'txt' }[job.format];
        return { stream, filename: job.source.filename + '.' + suffix, done: job.done };
    }
    async status(id: string, owner: string) {
        await this.clean();
        await this.owner(owner);
        const job = this.jobs.get(id),
            finished = this.finished.get(id);
        if (job?.owner === owner)
            return {
                state: job.failure ? 'failed' : job.state,
                bytes: job.bytes,
                ...(job.failure ? { error: job.failure, cleanupPending: true } : {}),
            };
        if (finished?.owner === owner)
            return {
                state: finished.state,
                bytes: finished.bytes,
                ...(finished.error ? { error: finished.error } : {}),
            };
        throw new CaptureStorageError(
            'invalid',
            'Export worker restarted or this job expired; retry the export.',
        );
    }
    async cancel(id: string, owner: string) {
        const job = this.jobs.get(id);
        if (!job || job.owner !== owner)
            throw new CaptureStorageError(
                'invalid',
                'Export belongs to another client or expired.',
            );
        job.state = 'closing';
        job.failure = 'Export cancelled.';
        await job.iterator?.return(undefined).catch(() => {});
        await this.end(job, Error('Export cancelled.'));
    }
}

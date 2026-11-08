import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GITHUB_SERVICE_PROFILE } from '../../scripts/lib/github-service-metadata.mjs';
import { readbackFixture } from './archive-readback-memory';

export async function metadataFixture() {
    const base = await readbackFixture(),
        normalized = base.observation(),
        scope = base.selection;
    const rawRun: any = {
        id: Number(normalized.run.id),
        run_attempt: Number(normalized.run.attempt),
        head_sha: normalized.run.headSHA,
        workflow_id: Number(normalized.run.workflowId),
        path: normalized.run.workflowPath,
        status: 'completed',
        conclusion: 'success',
        repository: { id: 4242, full_name: normalized.repository },
        head_repository: { id: 4242, full_name: normalized.repository },
    };
    // The documented job example has no run_attempt: request-scoped membership is required.
    const rawJob: any = {
        id: Number(normalized.job.id),
        run_id: Number(normalized.job.runId),
        head_sha: normalized.job.headSHA,
        name: normalized.job.name,
        status: 'completed',
        conclusion: 'success',
        check_run_url: `https://api.github.com/repos/${normalized.repository}/check-runs/805`,
    };
    const rawArtifact: any = {
        id: Number(normalized.artifact.id),
        name: normalized.artifact.name,
        size_in_bytes: normalized.artifact.sizeInBytes,
        digest: normalized.artifact.digest,
        expired: false,
        workflow_run: {
            id: Number(normalized.artifact.runId),
            head_sha: normalized.artifact.headSHA,
            repository_id: 4242,
            head_repository_id: 4242,
        },
    };
    const controls: any = {},
        requests: any[] = [],
        active = new Set<any>(),
        timers = new Map<number, any>();
    let now = 0,
        ordinal = 0;
    const clock = {
        now: () => now,
        set(fn: () => void, ms: number) {
            const id = ++ordinal;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clear(id: number) {
            if (controls.timerClearThrows) throw Error('synthetic timer clear');
            timers.delete(id);
        },
        advance(ms: number) {
            now += ms;
            for (const [id, t] of [...timers])
                if (t.at <= now) {
                    timers.delete(id);
                    t.fn();
                }
        },
    };
    function bodyFor(path: string) {
        const url = new URL('https://api.github.com' + path);
        if (url.pathname.endsWith('/artifacts/' + scope.service.artifactId))
            return structuredClone(rawArtifact);
        if (url.pathname.endsWith('/attempts/' + scope.context.runAttempt))
            return structuredClone(rawRun);
        assert.ok(url.pathname.endsWith('/attempts/' + scope.context.runAttempt + '/jobs'));
        assert.equal(url.searchParams.get('per_page'), '100');
        const page = Number(url.searchParams.get('page'));
        return controls.jobsPage
            ? controls.jobsPage(page)
            : { total_count: 1, jobs: [structuredClone(rawJob)] };
    }
    const host = {
        request(options: any) {
            const index = requests.length,
                plan = {
                    ...controls.defaults,
                    ...controls.plans?.[index],
                    ...controls.plan?.(index, options),
                };
            if (plan.throwAcquisition)
                throw Object.assign(
                    Error('synthetic credential must not escape ' + (plan.secret ?? '')),
                    { code: plan.errorCode ?? 'PRIVATE_UNTRUSTED_CODE' },
                );
            const value = bodyFor(options.path);
            const body: Buffer = plan.body ?? Buffer.from(JSON.stringify(value));
            const socket = new EventEmitter() as any;
            socket.encrypted = plan.encrypted ?? true;
            socket.authorized = plan.authorized ?? true;
            const request = new EventEmitter() as any,
                response = new EventEmitter() as any;
            response.statusCode = plan.status ?? 200;
            response.complete = false;
            response.headers = {
                'content-type': 'application/json; charset=utf-8',
                'content-length': String(body.length),
                'x-github-api-version-selected': GITHUB_SERVICE_PROFILE.apiVersion,
                ...plan.headers,
            };
            const frame: any = {
                index,
                options,
                plan,
                body,
                socket,
                request,
                response,
                responseSent: false,
                responseEnded: false,
                responseClosed: false,
                requestClosed: false,
                socketClosed: false,
                destroyCalls: 0,
            };
            requests.push(frame);
            active.add(frame);
            request.destroyed = false;
            const maybeDone = () => {
                if (
                    frame.requestClosed &&
                    frame.socketClosed &&
                    (!frame.responseSent || frame.responseClosed)
                )
                    active.delete(frame);
            };
            const responseClose = () => {
                if (!frame.responseSent || frame.responseClosed) return;
                frame.responseClosed = true;
                response.emit('close');
                maybeDone();
            };
            const requestClose = () => {
                if (frame.requestClosed) return;
                frame.requestClosed = true;
                request.emit('close');
                maybeDone();
            };
            const socketClose = () => {
                if (frame.socketClosed) return;
                frame.socketClosed = true;
                socket.emit('close', plan.socketHadError ?? false);
                maybeDone();
            };
            frame.releaseResponseClose = responseClose;
            frame.releaseRequestClose = requestClose;
            frame.releaseSocketClose = socketClose;
            const finish = (normal: boolean) => {
                if (!normal && frame.responseSent && !frame.responseEnded) {
                    response.complete = false;
                    response.emit('aborted');
                    response.emit(
                        'error',
                        Object.assign(Error('synthetic error ' + (plan.secret ?? '')), {
                            code: 'ECONNRESET',
                        }),
                    );
                }
                if (!plan.holdResponseClose) responseClose();
                if (!plan.holdRequestClose) requestClose();
                if (!plan.holdSocketClose) socketClose();
            };
            frame.releaseAll = () => {
                responseClose();
                requestClose();
                socketClose();
            };
            request.destroy = () => {
                frame.destroyCalls++;
                if (plan.destroyThrows)
                    throw Object.assign(Error('synthetic destroy ' + (plan.secret ?? '')), {
                        code: 'PRIVATE_UNTRUSTED_CODE',
                    });
                if (request.destroyed) return;
                request.destroyed = true;
                queueMicrotask(() => finish(false));
            };
            const respond = () => {
                if (request.destroyed) return;
                frame.responseSent = true;
                request.emit('response', response);
                if (request.destroyed) return;
                if (plan.responseError) {
                    response.emit(
                        'error',
                        Object.assign(Error('synthetic ' + (plan.secret ?? '')), {
                            code: plan.errorCode ?? 'ECONNRESET',
                        }),
                    );
                    return;
                }
                for (let at = 0; at < body.length; at += plan.chunkSize ?? 32768) {
                    if (request.destroyed) return;
                    response.emit('data', body.subarray(at, at + (plan.chunkSize ?? 32768)));
                }
                response.complete = plan.complete ?? true;
                frame.responseEnded = true;
                response.emit('end');
                if (!request.destroyed) finish(true);
            };
            frame.releaseResponse = respond;
            request.end = () => {
                if (plan.throwEnd) throw Error('synthetic end failure');
                queueMicrotask(() => {
                    if (request.destroyed) return;
                    request.emit('socket', socket);
                    socket.emit('secureConnect');
                    request.emit('finish');
                    if (!plan.holdResponse) respond();
                });
            };
            return request;
        },
    };
    return {
        ...base,
        scope,
        normalized,
        rawRun,
        rawJob,
        rawArtifact,
        controls,
        requests,
        active,
        clock,
        timers,
        host,
    };
}

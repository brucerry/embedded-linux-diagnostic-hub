import assert from 'node:assert/strict';

/**
 * @param {{api: string, headers: Record<string, string>, endpoint: string, expectedSize?: number,
 * kind: 'actions' | 'release', request?: typeof fetch,
 * diagnostic?: (record: {resource: string, stage: string, status: number | null, hostname: string, reason?: string}) => void}} options
 */
export async function readRecoveryBytes({
    api,
    headers,
    endpoint,
    expectedSize = undefined,
    kind,
    request = fetch,
    diagnostic = (record) => console.log(JSON.stringify(record)),
}) {
    assert.ok(['actions', 'release'].includes(kind));
    const base = new URL(api);
    assert.equal(base.protocol, 'https:');
    assert.equal(base.hostname, 'api.github.com');
    assert.ok(!base.username && !base.password && !base.port);
    assert.ok(endpoint.startsWith('/'), 'Use a repository-relative endpoint.');
    const limit = expectedSize ?? 16 * 1024 * 1024;
    assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 512 * 1024 * 1024);
    const resource = endpoint.includes('/jobs/')
        ? 'job-log'
        : kind === 'actions'
          ? 'artifact'
          : 'release-asset';
    let stage = 'api',
        hostname = base.hostname,
        status = null;
    const emit = (reason) =>
        diagnostic({ resource, stage, status, hostname, ...(reason ? { reason } : {}) });
    const fail = (reason) => {
        emit(reason);
        throw Error(
            'Recovery download failed: ' +
                JSON.stringify({ resource, stage, status, hostname, reason }),
        );
    };
    let response;
    try {
        response = await request(api + endpoint, {
            method: 'GET',
            headers: {
                ...headers,
                Accept:
                    kind === 'actions' ? 'application/vnd.github+json' : 'application/octet-stream',
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(90000),
        });
    } catch {
        fail('request-failed');
    }
    status = response.status;
    emit();
    if ([302, 307].includes(status)) {
        let location;
        try {
            location = new URL(response.headers.get('location'));
        } catch {
            await response.body?.cancel();
            fail('invalid-redirect');
        }
        diagnostic({ resource, stage: 'redirect-target', status, hostname: location.hostname });
        const releaseHost = [
            'release-assets.githubusercontent.com',
            'objects.githubusercontent.com',
        ].includes(location.hostname);
        const allowed =
            releaseHost ||
            (kind === 'actions' && location.hostname.endsWith('.blob.core.windows.net'));
        if (
            location.protocol !== 'https:' ||
            location.username ||
            location.password ||
            (location.port && location.port !== '443') ||
            !allowed
        ) {
            await response.body?.cancel();
            fail('rejected-redirect');
        }
        await response.body?.cancel();
        stage = 'redirect';
        hostname = location.hostname;
        status = null;
        try {
            // Job credentials are intentionally absent from every signed redirect request.
            response = await request(location, {
                method: 'GET',
                redirect: 'error',
                signal: AbortSignal.timeout(90000),
            });
        } catch {
            fail('redirect-request-failed');
        }
        status = response.status;
        emit();
    }
    if (status !== 200) {
        await response.body?.cancel();
        fail('unexpected-status');
    }
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit) fail('size-bound-exceeded');
            chunks.push(Buffer.from(chunk));
        }
    } catch (error) {
        if (error.message?.startsWith('Recovery download failed:')) throw error;
        fail('body-read-failed');
    }
    if (expectedSize !== undefined && size !== expectedSize) fail('size-mismatch');
    return Buffer.concat(chunks);
}

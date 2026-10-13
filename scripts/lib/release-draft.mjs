import assert from 'node:assert/strict';

export function requireNewRelease({ tag, version, commit, tagCommit, repository }) {
    assert.equal(repository.private, false, 'Mac release staging requires a public repository.');
    assert.equal(tag, 'v' + version);
    assert.match(tag, /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    assert.ok(!['v0.2.0', 'v0.3.0', 'v0.3.1'].includes(tag), 'Preserve prior releases.');
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(tagCommit, commit, 'Tag must point to the qualified source.');
    return 'Diagnostic Hub guarded draft; source=' + commit + '; tag=' + tag;
}
export function requireOwnedDraft(release, { tag, commit, marker }) {
    assert.equal(release.tag_name, tag);
    assert.equal(release.draft, true, 'Never modify a published release.');
    assert.equal(release.target_commitish, commit);
    assert.ok(release.body.includes(marker), 'Draft does not belong to this source.');
    assert.ok(Number.isSafeInteger(release.id));
    return release;
}

export function selectOwnedDraft(releases, context) {
    assert.ok(Array.isArray(releases), 'Invalid authenticated releases listing.');
    const matches = releases.filter((release) => release.tag_name === context.tag);
    assert.equal(matches.length, 1, 'Expected exactly one existing release for this tag.');
    return requireOwnedDraft(matches[0], context);
}
export async function listAllReleases(readPage) {
    const releases = [];
    for (let page = 1; page <= 100; page++) {
        const batch = await readPage(page);
        assert.ok(Array.isArray(batch), 'Invalid releases page.');
        releases.push(...batch);
        if (batch.length < 100) return releases;
    }
    throw Error('Release listing exceeded the bounded pagination limit.');
}

export async function requireAnonymousDenial(url, request = fetch, options = {}) {
    const expectedStatus = options.expectedStatus ?? 404;
    const resource = new URL(url);
    const metadata =
        resource.hostname === 'api.github.com' &&
        !/\/releases\/assets\/\d+$/.test(resource.pathname);
    const now = options.now ?? Date.now;
    const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const log = options.log ?? console.log;
    const deadline = now() + (options.maxWaitMs ?? 15 * 60 * 1000);
    const attempts = options.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = await request(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(30000),
            headers: metadata
                ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
                : { Accept: 'application/octet-stream', Range: 'bytes=0-0' },
        });
        if (response.status === expectedStatus) {
            await response.body?.cancel();
            log(
                'Anonymous ' + expectedStatus + ' verified: ' + resource.origin + resource.pathname,
            );
            return;
        }
        // Read only a bounded JSON message. Never log credentials, signed URLs or arbitrary bodies.
        let message = '';
        if (metadata && response.body) {
            const reader = response.body.getReader();
            const { value } = await reader.read();
            await reader.cancel();
            try {
                message = String(
                    JSON.parse(new TextDecoder().decode(value?.slice(0, 4096))).message ?? '',
                )
                    .replace(/https?:\/\/\S+|\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted]')
                    .slice(0, 256);
            } catch {
                /* An unrecognized body cannot justify a retry. */
            }
        } else await response.body?.cancel();
        const rate = Object.fromEntries(
            [
                'x-ratelimit-limit',
                'x-ratelimit-remaining',
                'x-ratelimit-reset',
                'x-ratelimit-used',
                'x-ratelimit-resource',
                'retry-after',
            ]
                .map((name) => [name, response.headers.get(name)])
                .filter(([, value]) => value !== null),
        );
        const detail = JSON.stringify({
            status: response.status,
            resource: resource.origin + resource.pathname,
            message,
            rate,
        });
        const reset = Number(rate['x-ratelimit-reset']) * 1000;
        const retryAfter = Number(rate['retry-after']) * 1000;
        const rateMessage = /rate limit exceeded|secondary rate limit/i.test(message);
        const primary =
            rate['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset > now();
        const secondary =
            /secondary rate limit/i.test(message) && Number.isFinite(retryAfter) && retryAfter > 0;
        const until = primary ? reset + 1000 : secondary ? now() + retryAfter + 1000 : 0;
        if (
            metadata &&
            [403, 429].includes(response.status) &&
            rateMessage &&
            until > now() &&
            until <= deadline &&
            attempt < attempts
        ) {
            log(
                'Confirmed anonymous API throttling; wait until ' +
                    new Date(until).toISOString() +
                    ': ' +
                    detail,
            );
            while (now() < until) await wait(Math.min(30000, until - now()));
            continue;
        }
        throw Error(
            'Expected anonymous draft denial; transport/rate-limit errors are not privacy evidence. ' +
                detail,
        );
    }
    throw Error('Anonymous privacy retry limit exceeded.');
}

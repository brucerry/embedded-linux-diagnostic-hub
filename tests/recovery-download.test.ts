import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRecoveryBytes } from '../scripts/lib/recovery-download.mjs';
const api = 'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub';
const headers = { Authorization: 'Bearer job-secret', Accept: 'application/vnd.github+json' };
test('Actions job logs and artifacts use JSON media and strip credentials at signed redirects', async () => {
    for (const endpoint of ['/actions/jobs/1/logs', '/actions/artifacts/2/zip']) {
        const diagnostics: unknown[] = [];
        let calls = 0;
        const bytes = await readRecoveryBytes({
            api,
            headers,
            endpoint,
            kind: 'actions',
            expectedSize: 3,
            diagnostic: (r: unknown) => diagnostics.push(r),
            request: async (url: unknown, options: any) => {
                calls++;
                assert.equal(options.method, 'GET');
                if (calls === 1) {
                    assert.equal(options.headers.Accept, 'application/vnd.github+json');
                    assert.equal(options.headers.Authorization, headers.Authorization);
                    return new Response(null, {
                        status: 302,
                        headers: {
                            location:
                                'https://productionresultssa1.blob.core.windows.net/log?sig=fixture-secret',
                        },
                    });
                }
                assert.equal(options.headers, undefined);
                assert.equal(options.redirect, 'error');
                return new Response('abc');
            },
        });
        assert.equal(bytes.toString(), 'abc');
        assert.equal(calls, 2);
        assert.doesNotMatch(
            JSON.stringify(diagnostics),
            /job-secret|fixture-secret|sig=|https:\/\//,
        );
    }
});
test('Release asset requests retain octet-stream and strip the job token before CDN requests', async () => {
    let calls = 0;
    const data = await readRecoveryBytes({
        api,
        headers,
        endpoint: '/releases/assets/3',
        kind: 'release',
        expectedSize: 1,
        diagnostic: () => {},
        request: async (_url: unknown, options: any) => {
            calls++;
            if (calls === 1) {
                assert.equal(options.headers.Accept, 'application/octet-stream');
                return new Response(null, {
                    status: 307,
                    headers: {
                        location: 'https://release-assets.githubusercontent.com/file?secret=signed',
                    },
                });
            }
            assert.equal(options.headers, undefined);
            return new Response('x');
        },
    });
    assert.equal(data.toString(), 'x');
});
test('Recovery diagnostics retain HTTP status/stage/hostname without arbitrary body or signed query', async () => {
    const diagnostics: unknown[] = [];
    await assert.rejects(
        readRecoveryBytes({
            api,
            headers,
            endpoint: '/actions/jobs/1/logs',
            kind: 'actions',
            diagnostic: (r: unknown) => diagnostics.push(r),
            request: async () => new Response('body has job-secret', { status: 415 }),
        }),
        /"stage":"api".*"status":415.*"hostname":"api.github.com"/,
    );
    assert.doesNotMatch(JSON.stringify(diagnostics), /job-secret|body has/);
    await assert.rejects(
        readRecoveryBytes({
            api,
            headers,
            endpoint: '/actions/jobs/1/logs',
            kind: 'actions',
            diagnostic: () => {},
            request: async () => {
                throw Error('https://example.invalid/?sig=secret');
            },
        }),
        (error) =>
            error instanceof Error &&
            !error.message.includes('sig=') &&
            error.message.includes('request-failed'),
    );
});
test('Recovery rejects untrusted protocols, credentials, ports and hosts before a second request', async () => {
    for (const location of [
        'http://productionresultssa1.blob.core.windows.net/file',
        'https://user:password@productionresultssa1.blob.core.windows.net/file',
        'https://productionresultssa1.blob.core.windows.net:444/file',
        'https://productionresultssa1.blob.core.windows.net.evil.invalid/file',
        'https://example.invalid/file',
    ]) {
        let calls = 0;
        await assert.rejects(
            readRecoveryBytes({
                api,
                headers,
                endpoint: '/actions/jobs/1/logs',
                kind: 'actions',
                diagnostic: () => {},
                request: async () => {
                    calls++;
                    return new Response(null, { status: 302, headers: { location } });
                },
            }),
            /rejected-redirect/,
        );
        assert.equal(calls, 1);
    }
    await assert.rejects(
        readRecoveryBytes({
            api,
            headers,
            endpoint: '/releases/assets/3',
            kind: 'release',
            diagnostic: () => {},
            request: async () =>
                new Response(null, {
                    status: 302,
                    headers: {
                        location: 'https://productionresultssa1.blob.core.windows.net/file',
                    },
                }),
        }),
        /rejected-redirect/,
    );
});
test('Recovery preserves exact byte bounds and refuses failed redirected responses', async () => {
    for (const [body, size, reason] of [
        ['abc', 2, 'size-bound-exceeded'],
        ['a', 2, 'size-mismatch'],
    ] as const) {
        await assert.rejects(
            readRecoveryBytes({
                api,
                headers,
                endpoint: '/actions/artifacts/2/zip',
                kind: 'actions',
                expectedSize: size,
                diagnostic: () => {},
                request: async () => new Response(body),
            }),
            new RegExp(reason),
        );
    }
    let calls = 0;
    await assert.rejects(
        readRecoveryBytes({
            api,
            headers,
            endpoint: '/actions/jobs/1/logs',
            kind: 'actions',
            diagnostic: () => {},
            request: async () =>
                ++calls === 1
                    ? new Response(null, {
                          status: 302,
                          headers: {
                              location:
                                  'https://productionresultssa1.blob.core.windows.net/log?sig=secret',
                          },
                      })
                    : new Response(null, { status: 403 }),
        }),
        /"stage":"redirect".*"status":403/,
    );
});

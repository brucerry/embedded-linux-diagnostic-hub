import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    listAllReleases,
    selectOwnedDraft,
    requireNewRelease,
    requireAnonymousDenial,
} from '../scripts/lib/release-draft.mjs';

test('confirmed primary quota waits for its reset and then requires an unthrottled 404', async () => {
    let clock = 1000;
    let calls = 0;
    const waits: number[] = [];
    const request = async () =>
        ++calls === 1
            ? new Response(JSON.stringify({ message: 'API rate limit exceeded for 192.0.2.1.' }), {
                  status: 403,
                  headers: {
                      'x-ratelimit-limit': '60',
                      'x-ratelimit-remaining': '0',
                      'x-ratelimit-reset': '4',
                      'x-ratelimit-used': '60',
                  },
              })
            : new Response(null, { status: 404 });
    await requireAnonymousDenial(
        'https://api.github.com/repos/example/project/releases/42',
        request,
        {
            now: () => clock,
            wait: async (ms: number) => {
                waits.push(ms);
                clock += ms;
            },
            log: () => {},
        },
    );
    assert.equal(calls, 2);
    assert.equal(clock, 5000);
    assert.deepEqual(waits, [4000]);
});
test('ambiguous forbidden, media, redirect and public responses fail without retry or disclosure', async () => {
    for (const status of [403, 415, 302, 200]) {
        let calls = 0;
        await assert.rejects(
            requireAnonymousDenial(
                'https://api.github.com/repos/example/project/releases/42?secret=never-log',
                async () => {
                    calls++;
                    return new Response('unrecognized', { status });
                },
                {
                    wait: async () => {
                        throw Error('must not wait');
                    },
                    log: () => {},
                },
            ),
            (error: Error) => {
                assert.match(error.message, new RegExp(String(status)));
                assert.ok(!error.message.includes('secret=never-log'));
                return true;
            },
        );
        assert.equal(calls, 1);
    }
});
test('privacy retry obeys reset bounds and never accepts repeated throttling as denial', async () => {
    let clock = 1000;
    let calls = 0;
    await assert.rejects(
        requireAnonymousDenial(
            'https://api.github.com/repos/example/project/releases/42',
            async () => {
                calls++;
                return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
                    status: 429,
                    headers: {
                        'x-ratelimit-remaining': '0',
                        'x-ratelimit-reset': String(Math.ceil(clock / 1000) + 1),
                    },
                });
            },
            {
                now: () => clock,
                wait: async (ms: number) => {
                    clock += ms;
                },
                maxAttempts: 2,
                maxWaitMs: 10000,
                log: () => {},
            },
        ),
        /not privacy evidence/,
    );
    assert.equal(calls, 2);
    await assert.rejects(
        requireAnonymousDenial(
            'https://api.github.com/repos/example/project/releases/42',
            async () =>
                new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
                    status: 403,
                    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' },
                }),
            {
                now: () => 1000,
                maxWaitMs: 1000,
                wait: async () => {
                    throw Error('too long');
                },
                log: () => {},
            },
        ),
        /not privacy evidence/,
    );
});
test('public metadata control must be available and secondary throttling respects Retry-After', async () => {
    let clock = 1000;
    let calls = 0;
    await requireAnonymousDenial(
        'https://api.github.com/repos/example/project/releases/41',
        async () =>
            ++calls === 1
                ? new Response(
                      JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }),
                      { status: 403, headers: { 'retry-after': '2' } },
                  )
                : new Response(null, { status: 200 }),
        {
            expectedStatus: 200,
            now: () => clock,
            wait: async (ms: number) => {
                clock += ms;
            },
            log: () => {},
        },
    );
    assert.equal(clock, 4000);
    assert.equal(calls, 2);
    await assert.rejects(
        requireAnonymousDenial(
            'https://api.github.com/repos/example/project/releases/41',
            async () => new Response(null, { status: 404 }),
            { expectedStatus: 200, log: () => {} },
        ),
    );
});

const context = {
    tag: 'v0.4.0',
    version: '0.4.0',
    commit: 'a'.repeat(40),
    tagCommit: 'a'.repeat(40),
    repository: { private: false },
};
const marker = requireNewRelease(context);
const draft = {
    id: 42,
    tag_name: context.tag,
    draft: true,
    target_commitish: context.commit,
    body: marker,
};
test('authenticated paginated listing discovers an owned draft that published tag lookup omits', async () => {
    const calls: number[] = [];
    const releases = await listAllReleases(async (page: number) => {
        calls.push(page);
        return page === 1
            ? Array.from({ length: 100 }, (_, i) => ({
                  ...draft,
                  id: i + 100,
                  tag_name: 'other-' + i,
                  draft: false,
              }))
            : [draft];
    });
    assert.deepEqual(calls, [1, 2]);
    assert.equal(selectOwnedDraft(releases, { ...context, marker }).id, 42);
    assert.throws(() =>
        selectOwnedDraft(
            releases.filter((r) => !r.draft),
            { ...context, marker },
        ),
    );
});
test('draft discovery rejects missing, duplicate, published and unrelated-source releases', () => {
    for (const releases of [
        [],
        [draft, draft],
        [{ ...draft, draft: false }],
        [{ ...draft, target_commitish: 'b'.repeat(40) }],
        [{ ...draft, body: 'unowned' }],
    ])
        assert.throws(() => selectOwnedDraft(releases, { ...context, marker }));
});

test('anonymous privacy probes use JSON metadata headers and binary asset headers without credentials', async () => {
    const calls: { url: string; headers: Headers; method: unknown; redirect: unknown }[] = [];
    const request = async (input: unknown, init?: RequestInit) => {
        calls.push({
            url: String(input),
            headers: new Headers(init?.headers),
            method: init?.method,
            redirect: init?.redirect,
        });
        return new Response(null, { status: 404 });
    };
    await requireAnonymousDenial(
        'https://api.github.com/repos/example/project/releases/42',
        request,
    );
    await requireAnonymousDenial(
        'https://api.github.com/repos/example/project/releases/tags/v0.4.0',
        request,
    );
    await requireAnonymousDenial(
        'https://github.com/example/project/releases/download/v0.4.0/app.zip',
        request,
    );
    await requireAnonymousDenial(
        'https://api.github.com/repos/example/project/releases/assets/99',
        request,
    );
    for (const [index, call] of calls.entries()) {
        assert.equal(call.method, 'GET');
        assert.equal(call.redirect, 'manual');
        assert.equal(call.headers.get('Authorization'), null);
        assert.equal(
            call.headers.get('Accept'),
            index < 2 ? 'application/vnd.github+json' : 'application/octet-stream',
        );
        assert.equal(call.headers.get('Range'), index < 2 ? null : 'bytes=0-0');
    }
});
test('unsupported media remains a failed privacy gate and never counts as anonymous denial', async () => {
    await assert.rejects(
        requireAnonymousDenial(
            'https://api.github.com/repos/example/project/releases/42',
            async () => new Response(null, { status: 415 }),
        ),
        /415/,
    );
    await assert.rejects(
        requireAnonymousDenial(
            'https://api.github.com/repos/example/project/releases/42',
            async () => new Response(null, { status: 200 }),
        ),
        /200/,
    );
});

test('listing failures and invalid/bounded pagination never permit a draft mutation', async () => {
    await assert.rejects(
        listAllReleases(async () => {
            throw Error('authenticated HTTP 404');
        }),
    );
    await assert.rejects(listAllReleases(async () => ({})));
    await assert.rejects(
        listAllReleases(async () => Array(100).fill(draft)),
        /pagination limit/,
    );
});

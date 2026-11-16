import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubSourceSelectorModel } from '../scripts/lib/github-service-metadata.mjs';
import { nativeBootstrapFixture } from './fixtures/gateway-native-bootstrap-memory';
const until = async (check: () => boolean) => {
    for (let n = 0; n < 5000 && !check(); n++) await Promise.resolve();
    assert.ok(check(), 'Expected bounded fake continuation.');
};
async function fixture(kind = 'tag', layers = 1) {
    const f = await nativeBootstrapFixture(kind, layers);
    const selected = {
        repository: f.runtime.environment.GITHUB_REPOSITORY,
        kind,
        ref: f.runtime.environment.GITHUB_REF,
        sourceCommit: f.p.context.sourceCommit,
    };
    return {
        ...f,
        selected,
        selector: () => createGitHubSourceSelectorModel(selected, f.http.host, f.http.clock),
    };
}
for (const [kind, layers, count] of [
    ['branch', 0, 3],
    ['tag', 0, 3],
    ['tag', 1, 4],
    ['tag', 8, 11],
] as const)
    test(`independent ${kind} selection with ${layers} annotations uses ${count} owned GETs`, async () => {
        const f = await fixture(kind, layers),
            selector = f.selector();
        const pin = await selector.select();
        selector.assertSettled();
        assert.equal(pin.objectID, f.top.oid);
        assert.equal(pin.sourceCommit, f.p.context.sourceCommit);
        assert.equal(pin.sourceTree, f.p.context.sourceTree);
        assert.equal(pin.chain.length, kind === 'tag' ? layers + 1 : 1);
        assert.equal(f.http.requests.length, count);
        assert.equal(f.http.active.size, 0);
        assert.equal(f.http.timers.size, 0);
        assert.equal(pin.originalEventObjectAuthentication, null);
        assert.equal(pin.jobAuthentication, null);
        assert.equal(pin.uploadAttribution, null);
        assert.equal(pin.releaseAcceptance, false);
        assert.ok(
            f.http.requests.every(
                (r) =>
                    r.options.method === 'GET' &&
                    r.options.hostname === 'api.github.com' &&
                    r.options.headers.Authorization === undefined &&
                    !r.options.path.includes('/actions/'),
            ),
        );
        assert.ok(
            f.http.requests.every((r) => r.requestClosed && r.responseClosed && r.socketClosed),
        );
        await assert.rejects(selector.select(), /one-shot/);
    });
for (const kind of [
    'ref',
    'array',
    'type',
    'peel',
    'commit',
    'tree',
    'moved',
    'status',
    'tls',
    'version',
])
    test(`source selection refuses ${kind} mismatch without a retry`, async () => {
        const f = await fixture();
        const source = f.p.context.sourceCommit;
        f.http.controls.plan = (n: number) => {
            if (kind === 'status' && n === 0) return { status: 403 };
            if (kind === 'tls' && n === 0) return { authorized: false };
            if (kind === 'version' && n === 0)
                return { headers: { 'x-github-api-version-selected': 'different' } };
            if (n === 0 && kind === 'ref')
                return {
                    body: Buffer.from(
                        JSON.stringify({
                            ref: 'refs/tags/v0.6.1',
                            object: { sha: f.top.oid, type: 'tag' },
                        }),
                    ),
                };
            if (n === 0 && kind === 'array') return { body: Buffer.from('[]') };
            if (n === 0 && kind === 'type')
                return {
                    body: Buffer.from(
                        JSON.stringify({
                            ref: f.selected.ref,
                            object: { sha: f.top.oid, type: 'blob' },
                        }),
                    ),
                };
            if (n === 1 && kind === 'peel')
                return {
                    body: Buffer.from(
                        JSON.stringify({
                            sha: f.top.oid,
                            object: { sha: 'f'.repeat(40), type: 'commit' },
                        }),
                    ),
                };
            if (n === 2 && kind === 'commit')
                return {
                    body: Buffer.from(
                        JSON.stringify({
                            sha: 'f'.repeat(40),
                            tree: { sha: f.p.context.sourceTree },
                        }),
                    ),
                };
            if (n === 2 && kind === 'tree')
                return {
                    body: Buffer.from(JSON.stringify({ sha: source, tree: { sha: 'invalid' } })),
                };
            if (n === 3 && kind === 'moved')
                return {
                    body: Buffer.from(
                        JSON.stringify({
                            ref: f.selected.ref,
                            object: { sha: 'f'.repeat(40), type: 'tag' },
                        }),
                    ),
                };
            return {};
        };
        const selector = f.selector();
        await assert.rejects(selector.select());
        assert.equal(selector.snapshot().failed, true);
        assert.equal(selector.snapshot().complete, false);
        assert.throws(selector.assertSettled);
        const requests = f.http.requests.length;
        await assert.rejects(selector.select(), /one-shot/);
        assert.equal(f.http.requests.length, requests);
        assert.ok(requests <= 4);
    });
test('a body cannot advance selection before actual HTTP socket closure', async () => {
    const f = await fixture();
    f.http.controls.plans = [{ holdSocketClose: true }];
    const selector = f.selector();
    let done = false;
    const work = selector.select().then((pin) => {
        done = true;
        return pin;
    });
    await until(() => f.http.requests[0]?.responseEnded);
    assert.equal(done, false);
    assert.equal(f.http.requests.length, 1);
    assert.equal(selector.snapshot().pending, 1);
    f.http.requests[0].releaseSocketClose();
    await work;
    selector.assertSettled();
    assert.equal(f.http.active.size, 0);
});
test('a ninth annotation is refused before another object fetch', async () => {
    const f = await fixture('tag', 9);
    const selector = f.selector();
    await assert.rejects(selector.select());
    assert.equal(f.http.requests.length, 9);
    assert.equal(selector.snapshot().complete, false);
});
for (const key of ['repository', 'ref', 'sourceCommit', 'kind'])
    test(`invalid source selection ${key} has no network effect`, async () => {
        const f = await fixture();
        (f.selected as any)[key] = 'invalid';
        assert.throws(f.selector);
        assert.equal(f.http.requests.length, 0);
    });
test('late socket-close failure after a complete body cannot supply a source pin', async () => {
    const f = await fixture();
    f.http.controls.plans = [{ socketHadError: true }];
    const selector = f.selector();
    await assert.rejects(selector.select());
    assert.equal(selector.snapshot().complete, false);
    assert.equal(f.http.requests.length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpDocumentFixture, powershellRendererProbe } from './fixtures/cdp-document';
const windowsOnly = { skip: process.platform !== 'win32' };

test(
    'Windows inspector target URL can precede the committed document and discard fixture globals',
    windowsOnly,
    async () => {
        const fixture = await cdpDocumentFixture();
        try {
            assert.equal(fixture.target.url, 'app://bundle/index.html');
            assert.equal(await fixture.renderer.evaluate('document.URL'), 'about:blank');
            await fixture.renderer.evaluate('globalThis.fixtureSettings={port:12345}');
            await fixture.release();
            await fixture.ready();
            assert.equal(await fixture.renderer.evaluate('typeof fixtureSettings'), 'undefined');
            await assert.rejects(
                fixture.renderer.evaluate('fixtureSettings.port'),
                /fixtureSettings is not defined/,
            );
            assert.ok(fixture.renderer.events.includes('Runtime.executionContextsCleared'));
        } finally {
            await fixture.close();
        }
    },
);

test(
    'Windows renderer readiness waits for real document UI and binds fixture data in one evaluation',
    windowsOnly,
    async () => {
        const repeats = Number(process.env.HUB_CDP_REPEATS ?? '1');
        assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
        for (let index = 0; index < repeats; index++) {
            const fixture = await cdpDocumentFixture();
            try {
                const probe = powershellRendererProbe(fixture.target.webSocketDebuggerUrl, 5000);
                await probe.waiting;
                assert.equal(await fixture.renderer.evaluate('document.URL'), 'about:blank');
                await fixture.release();
                const result = await probe.completion;
                assert.equal(result.code, 0, result.output);
                const line = result.output
                    .split(/\r?\n/)
                    .find((line) => line.startsWith('RESULT '));
                assert.ok(line, result.output);
                const value = JSON.parse(line.slice(7));
                assert.equal(value.port, 2468);
                assert.deepEqual(value.ready, {
                    url: 'app://bundle/index.html',
                    ready: 'complete',
                    bridge: true,
                    connect: true,
                });
                assert.equal(
                    await fixture.renderer.evaluate('typeof fixtureSettings'),
                    'undefined',
                );
            } finally {
                await fixture.close();
            }
        }
    },
);

test(
    'Windows renderer readiness does not accept advertised URL or exceed its supplied startup budget',
    windowsOnly,
    async () => {
        const fixture = await cdpDocumentFixture();
        try {
            const probe = powershellRendererProbe(fixture.target.webSocketDebuggerUrl, 200);
            const result = await probe.completion;
            assert.notEqual(result.code, 0);
            assert.match(result.output, /Committed renderer did not become ready within 200ms/);
            assert.equal(await fixture.renderer.evaluate('document.URL'), 'about:blank');
        } finally {
            await fixture.close();
        }
    },
);

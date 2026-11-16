import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGatewayHealthEntry } from '../scripts/check-gateway-health-entry.mjs';

test('entry check imports only the fixed URL and validates without invoking the worker', async () => {
    const imports = [];
    let workerCalls = 0;
    const code = await checkGatewayHealthEntry(async (url) => {
        imports.push(url);
        return {
            observeGatewayHealthJob() {
                workerCalls++;
                throw Error('Inert worker stub must never run.');
            },
        };
    });
    assert.equal(code, 0);
    assert.deepEqual(imports, [
        new URL('../scripts/observe-gateway-health-job.mjs', import.meta.url).href,
    ]);
    assert.equal(workerCalls, 0);
});

test('import rejection including thrown undefined returns only failure', async () => {
    for (const reason of [Error('Private inert import detail.'), undefined]) {
        let calls = 0;
        assert.equal(
            await checkGatewayHealthEntry(async () => {
                calls++;
                throw reason;
            }),
            1,
        );
        assert.equal(calls, 1);
    }
});

test('absent or nonfunction export cannot be accepted', async () => {
    for (const value of [undefined, null, {}, { observeGatewayHealthJob: true }]) {
        assert.equal(await checkGatewayHealthEntry(async () => value), 1);
    }
});

test('export getter failure including thrown undefined remains failure', async () => {
    for (const reason of [Error('Private inert getter detail.'), undefined]) {
        let getters = 0;
        assert.equal(
            await checkGatewayHealthEntry(async () => ({
                get observeGatewayHealthJob() {
                    getters++;
                    throw reason;
                },
            })),
            1,
        );
        assert.equal(getters, 1);
    }
});

test('entry failures emit no raw console detail', async (t) => {
    const logs = [];
    for (const method of ['log', 'error', 'warn'])
        t.mock.method(console, method, (...args) => logs.push(args));
    assert.equal(
        await checkGatewayHealthEntry(async () => {
            throw Error('Private inert text that must never be logged.');
        }),
        1,
    );
    assert.equal(await checkGatewayHealthEntry(async () => ({})), 1);
    assert.deepEqual(logs, []);
});

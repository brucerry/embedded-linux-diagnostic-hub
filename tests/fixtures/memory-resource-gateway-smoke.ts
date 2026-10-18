import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedGateway } from './memory-resource-gateway-process';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import { sourceFingerprint, nodeRuntimeIdentity } from './memory-resource-identity';

/** One small interface check; never a calibrated memory regression or soak verdict. */
async function main() {
    const argument = process.argv.find((value) => value.startsWith('--out='));
    assert.ok(argument, 'Provide --out=<private evidence directory>.');
    const destination = path.resolve(argument.slice(6));
    await fs.mkdir(destination, { recursive: true });
    const output = await fs.mkdtemp(path.join(destination, 'gateway-interface-'));
    const timeline = await fs.open(path.join(output, 'timeline.jsonl'), 'wx');
    let joinedDateCaches = 0;
    const emit = async (stage: string, data: unknown) => {
        await timeline.write(JSON.stringify({ time: Date.now(), stage, data }) + '\n');
        if (stage === 'gateway-host-teardown') {
            const value = data as {
                role: string;
                shutdown: {
                    runtimeTimerClosure: { firedAt: number | null; destroyedAt: number }[];
                };
            };
            if (value.role === 'gateway-node') {
                const closed = value.shutdown.runtimeTimerClosure;
                joinedDateCaches = closed.length;
                for (const timer of closed)
                    assert.ok(timer.firedAt !== null && timer.destroyedAt >= timer.firedAt);
            }
        }
    };
    const origin = 'http://127.0.0.1:5173';
    let gateway: Awaited<ReturnType<typeof isolatedGateway>> | undefined;
    let failure: unknown;
    try {
        await emit('identity', {
            sourceSHA256: await sourceFingerprint(path.resolve(import.meta.dirname, '../..')),
            runtime: await nodeRuntimeIdentity(),
        });
        await emit('profile', await sshQualificationProfile());
        gateway = await isolatedGateway(origin, 'forced', emit);
        await emit('runtime', gateway.runtimeIdentity);
        const before = await gateway.sample({ quiescent: true, forceGc: true });
        const hosts = before.filter((row) =>
            ['gateway-node', 'ssh-fixture-node'].includes(row.role),
        );
        assert.equal(new Set(hosts.map((row) => row.pid)).size, 2);
        for (const row of hosts) {
            assert.equal(row.state, 'running');
            assert.ok(row.heapUsedBytes! > 0 && row.arrayBuffersBytes! >= 0);
        }
        const headers = {
            Origin: origin,
            Authorization: 'Bearer ' + gateway.token,
            'Content-Type': 'application/json',
        };
        const response = await fetch(gateway.url + '/api/sessions', {
            method: 'POST',
            headers,
            body: JSON.stringify(gateway.options),
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 201, await response.clone().text());
        const session = (await response.json()) as { sessionId: string };
        const clock = await fetch(`${gateway.url}/api/sessions/${session.sessionId}/clock`, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(clock.status, 200);
        await clock.arrayBuffer();
        const disconnect = await fetch(`${gateway.url}/api/sessions/${session.sessionId}`, {
            method: 'DELETE',
            headers,
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(disconnect.status, 200);
        await disconnect.arrayBuffer();
        // Target TCP close delivery can lag the HTTP acknowledgement. This is an interface wait, not a zero-memory threshold.
        let owners: Record<string, number> = {};
        for (let turn = 0; turn < 100; turn++) {
            owners = await gateway.snapshotOwners();
            if (Object.values(owners).every((value) => value === 0)) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(
            Object.values(owners).every((value) => value === 0),
            JSON.stringify(owners),
        );
        await emit('quiescent', await gateway.sample({ quiescent: true, forceGc: true }));
        if (process.argv.includes('--fresh-date-cache=1')) {
            // Schedule the real HTTP request near the start of a second. No clock/header is patched.
            await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 20));
            const begin = Date.now();
            const health = await fetch(gateway.url + '/api/health', {
                headers,
                signal: AbortSignal.timeout(10000),
            });
            assert.equal(health.status, 200);
            await health.arrayBuffer();
            await emit('fresh-date-header', {
                requestAt: begin,
                responseAt: Date.now(),
                date: health.headers.get('date'),
            });
        }
    } catch (error) {
        failure = error;
    } finally {
        try {
            await gateway?.close();
            await gateway?.assertExited();
            if (process.argv.includes('--fresh-date-cache=1'))
                assert.equal(
                    joinedDateCaches,
                    1,
                    'Fresh-date regression did not observe and join the real pending runtime cache timer.',
                );
        } catch (error) {
            await emit('teardown-failure', { error: String(error) });
            failure ??= error;
        }
        await emit('receipt', {
            status: failure ? 'failed' : 'passed-gateway-process-interface',
            firstFailure: failure ? String(failure) : null,
            scope: 'One real loopback connect/clock/disconnect with bound Node metrics and natural teardown; no memory ceiling, calibration or soak qualification.',
            output,
        });
        await timeline.close();
    }
    if (failure) throw failure;
    console.log(output);
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

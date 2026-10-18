import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProductGateway } from './memory-product-gateway';
import type { ProductTargetSnapshot } from './memory-product-gateway-target';

/** Development interface proof only; no aggregate coverage, calibration or retention verdict. */
async function main() {
    const out = process.argv.find((value) => value.startsWith('--out='))?.slice(6);
    assert.ok(out);
    await fs.mkdir(out, { recursive: true });
    const timeline = await fs.open(path.join(out, 'timeline.jsonl'), 'wx');
    const emit = async (stage: string, data: unknown) => {
        await timeline.write(JSON.stringify({ at: new Date().toISOString(), stage, data }) + '\n');
    };
    let gateway: Awaited<ReturnType<typeof createProductGateway>> | undefined;
    let failure: unknown;
    const checks: string[] = [];
    try {
        const origin = 'http://127.0.0.1:5173';
        gateway = await createProductGateway({ origin, gcMode: 'normal', profile: out, emit });
        const headers = {
            Origin: origin,
            Authorization: 'Bearer ' + gateway.descriptor.token,
            'Content-Type': 'application/json',
        };
        const request = async (suffix: string, method: string, body?: unknown) => {
            const response = await fetch(gateway!.descriptor.url + suffix, {
                method,
                headers,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(10000),
            });
            assert.equal(
                response.status,
                method === 'POST' && suffix === '/api/sessions' ? 201 : 200,
                await response.clone().text(),
            );
            return response.json();
        };
        const { sessionId } = (await request(
            '/api/sessions',
            'POST',
            gateway.descriptor.options,
        )) as { sessionId: string };
        await request('/api/sessions/' + sessionId + '/clock', 'POST');
        checks.push('real-connect-clock');
        const initial = await gateway.snapshotOwners();
        assert.equal(initial.product.ownedSessions, 1);
        assert.equal(initial.product.allSessionOwners[0].connections.length, 1);
        const rows = await gateway.sample({ quiescent: true, forceGc: false });
        for (const role of gateway.roles) {
            const row = rows.find((row) => row.role === role);
            assert.ok(row?.created && row.pid > 0 && row.state === 'running');
            assert.ok(row.heapUsedBytes! > 0 && row.arrayBuffersBytes! >= 0);
        }
        checks.push('actual-product-owners-and-role-identities');
        const until = async (predicate: (snapshot: ProductTargetSnapshot) => boolean) => {
            const deadline = Date.now() + 3000;
            for (;;) {
                const value = await gateway!.control({ action: 'snapshot' });
                if (predicate(value)) return value;
                assert.ok(Date.now() < deadline, 'Expected actual target event boundary.');
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        };
        let ordinal = 0;
        const execute = (command: string) =>
            request(`/api/sessions/${sessionId}/automation`, 'POST', {
                id: 'gateway_fixture_' + String(++ordinal).padStart(4, '0'),
                connection: sessionId,
                command,
                timeoutMs: 10000,
            }) as Promise<{
                stdout: string;
                stderr: string;
                completion: string;
                exitCode: number | null;
            }>;
        await gateway.control({
            action: 'program',
            program: {
                command: 'fixture-bytes',
                stdoutBytes: 16384,
                stderrBytes: 8192,
                chunkBytes: 4096,
                delayMs: 1,
            },
        });
        await gateway.control({ action: 'hold-open', enabled: true });
        const held = execute('fixture-bytes');
        await until((value) => value.owners.pendingOpen === 1);
        const pending = await gateway.snapshotOwners();
        assert.ok(
            pending.product.allSessionOwners[0].connections.some(
                (connection) => connection.opening > 0,
            ),
        );
        await gateway.control({ action: 'release-open' });
        await gateway.control({ action: 'hold-open', enabled: false });
        const result = await held;
        assert.equal(result.completion, 'exit');
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'A'.repeat(16384));
        assert.equal(result.stderr, 'B'.repeat(8192));
        checks.push('real-pending-open-and-delayed-stdout-stderr');
        await gateway.control({
            action: 'program',
            program: { command: 'fixture-stall', stdoutBytes: 100, stall: true },
        });
        const stalled = execute('fixture-stall');
        await until((value) => value.owners.outputGates === 1);
        const active = await gateway.snapshotOwners();
        assert.equal(active.product.allSessionOwners[0].independentExecution, 1);
        await gateway.control({ action: 'release-output' });
        assert.equal((await stalled).stdout, 'A'.repeat(100));
        checks.push('real-stall-release');
        const terminalId = 'private_terminal_0001',
            abort = new AbortController();
        const terminal = await fetch(
            `${gateway.descriptor.url}/api/sessions/${sessionId}/terminal`,
            {
                method: 'POST',
                headers,
                body: JSON.stringify({ id: terminalId, cols: 80, rows: 24 }),
                signal: abort.signal,
            },
        );
        assert.equal(terminal.status, 200);
        const reader = terminal.body!.getReader();
        const read = (async () => {
            try {
                while (!(await reader.read()).done) {
                    /* consume actual NDJSON without retaining command output */
                }
            } catch (error) {
                if (!abort.signal.aborted) throw error;
            } finally {
                reader.releaseLock();
            }
        })();
        await until((value) => value.events.some((event) => event.type === 'shell-open'));
        await request(`/api/sessions/${sessionId}/terminal/${terminalId}/input`, 'POST', {
            data: Buffer.from('confirm-fixture\r').toString('base64'),
        });
        await until((value) =>
            value.events.some(
                (event) => event.type === 'shell-command' && event.command === 'confirm-fixture',
            ),
        );
        await request(`/api/sessions/${sessionId}/terminal/${terminalId}/input`, 'POST', {
            data: Buffer.from('\r').toString('base64'),
        });
        await until((value) => value.totals.enters === 1);
        await request(`/api/sessions/${sessionId}/terminal/${terminalId}`, 'DELETE');
        abort.abort();
        await read;
        checks.push('actual-shell-prompt-explicit-enter');
        await request('/api/sessions/' + sessionId, 'DELETE');
        await until((value) => Object.values(value.owners).every((count) => count === 0));
        const idle = await gateway.snapshotOwners();
        assert.equal(idle.product.ownedSessions, 0);
        assert.equal(idle.product.retiringSessions, 0);
        assert.deepEqual(idle.product.allSessionOwners, []);
        checks.push('joined-product-and-target-owners');
        await emit('interface-checks', {
            checks,
            scope: 'Bounded actual interface proof, no semantic aggregate coverage or memory qualification.',
        });
    } catch (error) {
        failure = error;
    } finally {
        try {
            await gateway?.close();
            await gateway?.assertExited();
            checks.push('normal-host-descendant-exit');
        } catch (error) {
            await emit('cleanup-failure', { error: String(error) });
            failure ??= error;
        }
        await emit('receipt', {
            status: failure ? 'failed' : 'passed-interface-only',
            checks,
            error: failure ? String(failure) : null,
        });
        await timeline.close();
    }
    if (failure) throw failure;
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

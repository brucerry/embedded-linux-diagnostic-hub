import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativePilotStartup } from './fixtures/native-pilot-startup';
import {
    preparePilotStageRuntime,
    runtimeDiagnostics,
} from '../scripts/lib/pilot-runtime-startup.mjs';

const now = () => Number(process.hrtime.bigint() / 1000000n);
const nonce = 'ack-admission-control';
const bindingSHA256 = 'c'.repeat(64);

/** Controlled transport port, real production orchestrator/startup/diagnostic queue.
 * connected stays stale across the modeled kernel-close window. No OS liveness credit. */
async function boundary(
    mode: 'owned-termination' | 'unrequested-close' | 'unknown-descendant' | 'inflight-error',
) {
    const rows: { stage: string; data: any }[] = [],
        holds: string[] = [];
    const controller = new AbortController();
    let startup: NativePilotStartup,
        writes = 0,
        killRequests = 0;
    let release!: () => void;
    const durable = new Promise<void>((resolve) => (release = resolve));
    let inflight: ((error?: Error | null) => void) | undefined;
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.connected = true; // A connected flag alone is deliberately not termination authority.
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const hold = (error: unknown) => {
        holds.push(String(error));
        startup.stopQueryAdmission();
        controller.abort(error);
    };
    const diagnostics = runtimeDiagnostics(async (stage: string, data: any) => {
        rows.push({ stage, data });
        if (stage === 'controlled-phase' && mode !== 'inflight-error') await durable;
    }, hold);
    const close = () => {
        child.stdout.end();
        child.stderr.end();
        child.stdout.resume();
        child.stderr.resume();
        queueMicrotask(() => {
            child.emit('exit', null, 'SIGKILL');
            child.emit('close', null, 'SIGKILL');
            release();
            inflight?.(Error('controlled admitted ACK EPIPE'));
        });
    };
    child.send = (message: any, callback?: (error?: Error | null) => void) => {
        if (message.kind === 'admit-native-runtime')
            queueMicrotask(() =>
                child.emit('message', {
                    kind: 'native-runtime-event',
                    nonce,
                    bindingSHA256,
                    sequence: 0,
                    stage: 'controlled-phase',
                    data: {},
                }),
            );
        if (message.kind === 'native-runtime-event-ack') {
            writes++;
            if (mode === 'inflight-error') inflight = callback;
            else queueMicrotask(() => callback?.(Error('controlled late ACK EPIPE')));
        } else callback?.(null);
        if (message.kind === 'cancel-native-pilot-build' && mode === 'unrequested-close') close();
        return true;
    };
    child.kill = () => {
        killRequests++;
        close();
        return true;
    };
    startup = new NativePilotStartup({
        signal: controller.signal,
        deadline: now() + 450,
        cleanupDeadline: now() + 4000,
        timeoutMs: 200,
        diagnostics: true,
        emit: diagnostics.emit,
        hold,
        identity: async () => ({
            pid: child.pid,
            created: 'controlled immutable creation identity',
        }),
        proveDescendants: async () => {
            if (mode === 'unknown-descendant') throw Error('controlled descendant closure unknown');
        },
    });
    const deadline = now() + 450;
    const result = preparePilotStageRuntime(
        {
            binding: { nonce, deadline: now() + 600000 },
            bindingSHA256,
            paths: { runtimeParent: '/unused-owned-runtime-control' },
            startup,
            signal: controller.signal,
            deadline,
            emit: diagnostics.emit,
            cancel: (error: unknown) => controller.abort(error),
            hold,
        },
        {
            cooperativeMs: 30,
            spawnPort: () => {
                queueMicrotask(() =>
                    child.emit('message', {
                        kind: 'native-runtime-ready',
                        nonce,
                        bindingSHA256,
                        pid: child.pid,
                    }),
                );
                return child;
            },
        },
    );
    await assert.rejects(result, /deadline/);
    await diagnostics.drain();
    return { writes, killRequests, holds, rows, row: startup.children.get(child) };
}

test('durably queued phase cannot admit an ACK after owned hard termination even when connected is stale', async () => {
    const r = await boundary('owned-termination');
    assert.equal(r.killRequests, 1);
    assert.equal(r.writes, 0);
    assert.deepEqual(r.holds, []);
    assert(
        r.row.terminationRequested &&
            r.row.exit &&
            r.row.close &&
            r.row.joined &&
            r.row.observationsDrained,
    );
    assert(r.rows.some((r) => r.stage === 'controlled-phase'));
});

test('unrequested IPC closure still attempts the bound ACK and retains its transport failure', async () => {
    const r = await boundary('unrequested-close');
    assert.equal(r.killRequests, 0);
    assert.equal(r.writes, 1);
    assert(r.holds.some((s) => s.includes('late ACK EPIPE')));
    assert(!r.row.joined);
});

test('refusing a post-termination ACK never substitutes for descendant closure', async () => {
    const r = await boundary('unknown-descendant');
    assert.equal(r.writes, 0);
    assert(r.holds.some((s) => s.includes('descendant closure unknown')));
    assert(!r.row.joined);
});

test('an ACK admitted before termination remains owned and its later EPIPE still holds', async () => {
    const r = await boundary('inflight-error');
    assert.equal(r.writes, 1);
    assert(r.holds.some((s) => s.includes('admitted ACK EPIPE')));
    assert(!r.row.joined);
});

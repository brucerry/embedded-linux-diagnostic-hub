import assert from 'node:assert/strict';
import test from 'node:test';
import { frameCrc } from '../shared/capture-store';
import { streamRequest, streamData, streamResult, streamRejected } from '../shared/ssh-stream-rpc';
import { SshStreamClient } from '../src/features/automation/capture/ssh-stream-client';
import { SshStreamHost } from '../backend/ssh/stream-host';

test('production SSH stream metadata, sequence, source, range and integrity are strict and bounded', () => {
    const bytes = new Uint8Array([0, 255, 65]),
        id = 'contract-stream-0001';
    const event = {
        protocol: 1,
        type: 'data',
        id,
        sequence: 0,
        receivedAt: '2026-10-15T00:00:00.000Z',
        receiveTimeSource: 'gateway',
        stream: 'stderr',
        totalBytes: 3,
        frames: [
            { offset: 0, base64: Buffer.from(bytes).toString('base64'), crc32: frameCrc(bytes) },
        ],
    };
    assert.deepEqual(streamData(event, id, 0, 'gateway').bytes, bytes);
    for (const bad of [
        { ...event, sequence: 1 },
        { ...event, receiveTimeSource: 'local-client' },
        { ...event, totalBytes: 262145 },
        { ...event, frames: [{ ...event.frames[0], offset: 1 }] },
        { ...event, frames: [{ ...event.frames[0], crc32: '00000000' }] },
        { ...event, path: 'untrusted' },
        { ...event, frames: Array(1) },
    ])
        assert.throws(() => streamData(bad, id, 0, 'gateway'));
    for (const bad of [
        { protocol: 2, action: 'capabilities' },
        {
            protocol: 1,
            action: 'ack',
            id,
            connection: 'contract-connection1',
            capability: '0'.repeat(64),
            sequence: -1,
        },
        { protocol: 1, action: 'capabilities', capability: '0'.repeat(64) },
    ])
        assert.throws(() => streamRequest(bad));
});
test('stream completion keeps explicit clipping and genuine exit evidence, with bounded rejected-observation failure', () => {
    const event = {
        protocol: 1,
        type: 'end',
        id: 'contract-stream-0001',
        capture: {
            stdout: 'partial',
            stderr: '',
            exitCode: 127,
            completion: 'exit',
            truncated: false,
            chunks: [],
            previewClipped: true,
        },
    };
    assert.equal(streamResult(event, event.id).exitCode, 127);
    assert.equal(streamResult(event, event.id).previewClipped, true);
    assert.throws(() =>
        streamResult({ ...event, capture: { ...event.capture, exitCode: null } }, event.id),
    );
    assert.throws(() =>
        streamResult({ ...event, capture: { ...event.capture, truncated: true } }, event.id),
    );
    const rejected = {
        ...event,
        rejected: { bytes: 32768, code: 'backlog', message: 'Bounded producer failed.' },
    };
    assert.equal(streamRejected(rejected)?.failure.code, 'backlog');
    assert.equal(streamRejected(rejected)?.bytes, 32768);
    assert.throws(() =>
        streamResult({ ...rejected, rejected: { ...rejected.rejected, bytes: -1 } }, event.id),
    );
});
test('missing durable flush and unsupported runtime refuse before any start or fallback command', async () => {
    const calls: string[] = [],
        client = new SshStreamClient(async (request) => {
            calls.push(request.action);
            return {};
        }, 'local-client');
    const request = {
        id: 'contract-stream-0001',
        connection: 'contract-connection1',
        command: 'pwd',
        timeoutMs: 1000,
    };
    await assert.rejects(
        client.execute(
            request,
            { append: async () => {}, rejectObservation: () => {} },
            new AbortController().signal,
        ),
        /durable/,
    );
    assert.deepEqual(calls, []);
    await assert.rejects(
        client.execute(
            request,
            { append: async () => {}, flush: async () => {}, rejectObservation: () => {} },
            new AbortController().signal,
        ),
        /supported streaming/,
    );
    assert.deepEqual(calls, ['capabilities']);
});

test('navigation/clear invalidates a previously negotiated start generation before a producer can run', async () => {
    let produced = 0;
    const host = new SshStreamHost(
        async () => {
            produced++;
        },
        () => {},
    );
    const before = (await host.dispatch({ protocol: 1, action: 'capabilities' })) as {
        epoch: string;
    };
    host.clear();
    await assert.rejects(
        host.dispatch({
            protocol: 1,
            action: 'start',
            epoch: before.epoch,
            request: {
                id: 'contract-stale-0001',
                connection: 'contract-connection1',
                command: 'pwd',
                timeoutMs: 1000,
            },
        }),
        /generation changed/,
    );
    assert.equal(produced, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    readFlowDownload,
    FLOW_FILE_READ_BYTES,
    FLOW_COHORT_READ_BYTES,
} from './ui/fixtures/flow-download';

const download = (chunks: AsyncIterable<Uint8Array>) =>
    ({
        failure: async () => null,
        createReadStream: async () => chunks,
    }) as unknown as Parameters<typeof readFlowDownload>[0];

test('flow download reader preserves binary bytes and split UTF-8 without text decoding', async () => {
    const first = Uint8Array.of(0, 0xff, 0xe2, 0x82),
        second = Uint8Array.of(0xac, 13, 10);
    const result = await readFlowDownload(
        download(
            (async function* () {
                yield first;
                yield second;
            })(),
        ),
        7,
    );
    assert.deepEqual([...result], [0, 0xff, 0xe2, 0x82, 0xac, 13, 10]);
    first.fill(1);
    assert.equal(result[0], 0);
});

test('flow download reader enforces per-file and remaining budgets and retires only its iterator', async () => {
    let retired = 0;
    const source = (size: number) =>
        download(
            (async function* () {
                try {
                    yield new Uint8Array(size);
                } finally {
                    retired++;
                }
            })(),
        );
    assert.equal(
        (await readFlowDownload(source(FLOW_FILE_READ_BYTES), FLOW_COHORT_READ_BYTES)).length,
        FLOW_FILE_READ_BYTES,
    );
    await assert.rejects(
        readFlowDownload(source(FLOW_FILE_READ_BYTES + 1), FLOW_COHORT_READ_BYTES),
        /read budget/,
    );
    await assert.rejects(readFlowDownload(source(5), 4), /read budget/);
    assert.equal(retired, 3);
    for (const remaining of [-1, NaN, Infinity, 1.5, FLOW_COHORT_READ_BYTES + 1])
        await assert.rejects(readFlowDownload(source(0), remaining), /Invalid remaining/);
    assert.equal(retired, 3, 'Invalid admission does not touch the stream');
});

test('flow download reader rejects failed or missing downloads and preserves SDK/stream errors', async () => {
    let reads = 0;
    const failed = {
        failure: async () => 'synthetic failure',
        createReadStream: async () => {
            reads++;
            return null;
        },
    } as unknown as Parameters<typeof readFlowDownload>[0];
    await assert.rejects(readFlowDownload(failed, 8), /synthetic failure/);
    assert.equal(reads, 0);
    await assert.rejects(
        readFlowDownload({ ...failed, failure: async () => null }, 8),
        /no readable stream/,
    );
    const error = new Error('original SDK failure');
    await assert.rejects(
        readFlowDownload(
            {
                ...failed,
                failure: async () => {
                    throw error;
                },
            },
            8,
        ),
        (e) => e === error,
    );
    const streamError = new Error('original stream failure');
    await assert.rejects(
        readFlowDownload(
            download(
                (async function* () {
                    yield Uint8Array.of(1);
                    throw streamError;
                })(),
            ),
            8,
        ),
        (e) => e === streamError,
    );
});

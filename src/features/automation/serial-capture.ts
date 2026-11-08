import { AUTOMATION_LIMITS, bytesBase64, type RawChunk } from '../../../shared/automation';

interface Block {
    bytes: Uint8Array;
    length: number;
    firstReceivedAt: string;
    lastReceivedAt: string;
    contributingReads: number;
}
/** Bounded storage independent of read fragmentation; blocks are never original read events. */
export class SerialCaptureBlocks {
    private blocks: Block[] = [];
    private size = 0;
    append(value: Uint8Array, receivedAt: string) {
        if (this.size + value.length > AUTOMATION_LIMITS.outputBytes)
            throw Error('Serial capture exceeds its byte bound.');
        for (let offset = 0; offset < value.length;) {
            let block = this.blocks.at(-1);
            if (!block || block.length === AUTOMATION_LIMITS.serialBlockBytes) {
                block = {
                    bytes: new Uint8Array(AUTOMATION_LIMITS.serialBlockBytes),
                    length: 0,
                    firstReceivedAt: receivedAt,
                    lastReceivedAt: receivedAt,
                    contributingReads: 0,
                };
                this.blocks.push(block);
            }
            const length = Math.min(value.length - offset, block.bytes.length - block.length);
            block.bytes.set(value.subarray(offset, offset + length), block.length);
            block.length += length;
            block.lastReceivedAt = receivedAt;
            // One read can contribute to multiple blocks; this is a per-block count.
            block.contributingReads++;
            offset += length;
        }
        this.size += value.length;
    }
    finish(): RawChunk[] {
        return this.blocks.map((block) => ({
            stream: 'serial',
            base64: bytesBase64(block.bytes.subarray(0, block.length)),
            receivedAt: block.firstReceivedAt,
            aggregation: {
                kind: 'serial-byte-block-v1',
                firstReceivedAt: block.firstReceivedAt,
                lastReceivedAt: block.lastReceivedAt,
                contributingReads: block.contributingReads,
            },
        }));
    }
}

import assert from 'node:assert/strict';
/** A send callback is transport acceptance only. The owner ACKs after its fsync. */
export function stageChannel(nonce: string, bindingSHA256: string, signal: AbortSignal) {
    let sequence = 0,
        pending: { sequence: number; resolve(): void; reject(e: unknown): void } | undefined;
    process.on('message', (m: any) => {
        if (m?.kind === 'pilot-durable-ack') {
            if (
                !pending ||
                m.nonce !== nonce ||
                m.bindingSHA256 !== bindingSHA256 ||
                m.sequence !== pending.sequence
            ) {
                pending?.reject(Error('Unbound evidence ACK'));
                return;
            }
            pending.resolve();
            pending = undefined;
        }
    });
    process.on('disconnect', () => pending?.reject(Error('Evidence owner disconnected')));
    return async (stage: string, data: unknown) => {
        assert(process.connected);
        assert(!pending, 'One evidence credit at a time');
        const m = {
            kind: 'pilot-evidence',
            nonce,
            bindingSHA256,
            sequence: sequence++,
            stage,
            data,
        };
        assert(Buffer.byteLength(JSON.stringify(m)) <= 65536);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Durable evidence ACK missing')), 10000);
            pending = {
                sequence: m.sequence,
                resolve() {
                    clearTimeout(timer);
                    resolve();
                },
                reject(e) {
                    clearTimeout(timer);
                    reject(e);
                },
            };
            process.send!(m, (e) => {
                if (e) pending?.reject(e);
            });
        });
    };
}

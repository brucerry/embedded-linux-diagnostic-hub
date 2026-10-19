import { SoakDecoder as Decoder } from '../../scripts/lib/soak-evidence.mjs';
/** Test-only sink; retains at most16MiB canonical events. Production consumers retain semantic state. */
export class SoakDecoder extends Decoder {
    constructor(options: any) {
        super({
            ...options,
            beginTransaction:
                options.beginTransaction ??
                (() => {
                    const events: any[] = [];
                    let bytes = 0;
                    return {
                        record(event: any) {
                            bytes += Buffer.byteLength(JSON.stringify(event));
                            if (bytes > 16 * 1024 ** 2) throw Error('Control sink bound');
                            events.push(event);
                        },
                        commit() {
                            for (const event of events) options.record(event);
                        },
                    };
                }),
        });
    }
}

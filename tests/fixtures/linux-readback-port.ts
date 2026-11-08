import { EventEmitter } from 'node:events';
import type { LinuxReadbackPort } from '../../electron/linux-setup-readback.ts';

/** In-memory event doubles only. No stream, socket, file descriptor or timer is created. */
export function linuxReadbackPair() {
    const jobs: (() => void)[] = [],
        frames: Buffer[] = [];
    class Port extends EventEmitter implements LinuxReadbackPort {
        peer!: Port;
        ended = false;
        finished = false;
        closed = false;
        writes = 0;
        ends = 0;
        backpressure = false;
        writeError = false;
        endError = false;
        holdWrite = false;
        held: (() => void)[] = [];
        write(bytes: Uint8Array, done: (error?: Error | null) => void) {
            this.writes++;
            const captured = Buffer.from(bytes);
            frames.push(captured);
            jobs.push(() => this.peer.emit('data', Buffer.from(captured)));
            const callback = () =>
                done(this.writeError ? Error('controlled-write-error') : undefined);
            if (this.holdWrite) this.held.push(callback);
            else jobs.push(callback);
            return !this.backpressure;
        }
        end(done: (error?: Error | null) => void) {
            this.ends++;
            this.ended = true;
            jobs.push(() => {
                this.finished = true;
                this.emit('finish');
                done(this.endError ? Error('controlled-end-error') : undefined);
                this.peer.emit('end');
                if (this.peer.finished && !this.closed && !this.peer.closed) {
                    this.closed = true;
                    this.peer.closed = true;
                    jobs.push(() => this.emit('close', false));
                    jobs.push(() => this.peer.emit('close', false));
                }
            });
            return this;
        }
    }
    const parent = new Port(),
        child = new Port();
    parent.peer = child;
    child.peer = parent;
    return {
        parent,
        child,
        frames,
        jobs,
        async pump(done: () => boolean = () => false) {
            for (let i = 0; i < 1000; i++) {
                while (jobs.length) jobs.shift()!();
                await Promise.resolve();
                if (done()) return;
                if (!jobs.length) await Promise.resolve();
            }
        },
    };
}

// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SoakTimeline } from '../scripts/lib/soak-evidence.mjs';
import { finishObservationTimeline } from '../scripts/lib/soak-observation-closure.mjs';
import { ProductRunOwner, productJob } from './fixtures/memory-product-owner';
class Clock {
    time = 1;
    next = 0;
    timers = new Map();
    now = () => this.time;
    set = (fn, ms) => {
        const id = ++this.next;
        this.timers.set(id, { fn, ms });
        return id;
    };
    clear = (id) => this.timers.delete(id);
}
for (const fault of ['none', 'write', 'sync', 'close'])
    test(
        'real owner and descriptor retain incomplete workload truth with ' +
            fault +
            ' footer fault',
        async () => {
            const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-observation-closure-')),
                file = await fs.open(path.join(root, 'timeline.jsonl'), 'wx'),
                clock = new Clock(),
                events = Object.assign(new EventEmitter(), {
                    connected: true,
                    disconnect() {
                        this.connected = false;
                    },
                }),
                owner = new ProductRunOwner(productJob(undefined, clock), events, clock);
            let finishing = false,
                teardowns = 0,
                joins = 0;
            const writer = new SoakTimeline(
                {
                    writeFile(bytes) {
                        if (finishing && fault === 'write') throw Error('footer write fault');
                        return file.writeFile(bytes);
                    },
                    sync() {
                        if (finishing && fault === 'sync') throw Error('footer sync fault');
                        return file.sync();
                    },
                    close() {
                        if (finishing && fault === 'close')
                            throw Error('actual descriptor remains open');
                        return file.close();
                    },
                },
                {
                    sourceSHA256: 'a'.repeat(64),
                    nonce: owner.job.nonce,
                    hold: (e) => (writer.failure ? owner.hold(e) : owner.cancel(e)),
                },
            );
            owner.bind(
                {
                    async teardown() {
                        teardowns++;
                    },
                    async assertDescendantsExited() {
                        joins++;
                    },
                },
                () => writer.enterCleanup(),
            );
            try {
                await writer.start();
                writer.fail(Error('Soak lifetime budget: physicalBytes'));
                await owner.join();
                assert.equal(teardowns, 1);
                assert.equal(joins, 1);
                assert.equal(owner.snapshot().invalid, null);
                finishing = true;
                if (fault === 'none') {
                    const result = await finishObservationTimeline(writer, owner);
                    assert.equal(result.complete, false);
                    assert(result.closure.complete);
                    owner.finish(true);
                    assert.equal(owner.snapshot().completed, true);
                    assert.equal(clock.timers.size, 0);
                    assert.equal(file.fd, -1);
                } else {
                    await assert.rejects(finishObservationTimeline(writer, owner));
                    assert(owner.snapshot().invalid);
                    assert.throws(() => owner.finish(true));
                    assert.equal(writer.closureProof().complete, false);
                    assert(clock.timers.size > 0);
                    if (fault === 'close') assert(file.fd >= 0);
                    else assert.equal(file.fd, -1);
                }
            } finally {
                if (file.fd >= 0) await file.close();
                await fs.rm(root, { recursive: true });
            }
        },
    );

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeEntries, writeAll } from './product-collector-evidence.mjs';
import { pilotLimits } from './hosted-pilot-contract.mjs';
/** One owned writable descriptor; failed sync/close is never converted into successful closure. */
export class PilotEvidence {
    constructor(root, { io = fs, check = () => {} } = {}) {
        this.io = io;
        this.check = check;
        this.root = root;
        this.entries = [];
        this.rows = 0;
        this.bytes = 0;
        this.entry = {
            fd: io.openSync(path.join(root, 'pilot.jsonl'), 'wx', 0o600),
            errors: [],
            attempted: false,
            synced: false,
            closed: false,
        };
        this.entries.push(this.entry);
    }
    append(stage, data) {
        assert(!this.entry.attempted);
        this.check();
        const b = Buffer.from(JSON.stringify({ sequence: this.rows, stage, data }) + '\n');
        assert(
            this.rows < 4096 &&
                b.length <= 65536 &&
                this.bytes + b.length <= pilotLimits.evidenceBytes,
        );
        writeAll(this.entry.fd, b, this.io);
        this.io.fsyncSync(this.entry.fd);
        this.rows++;
        this.bytes += b.length;
    }
    close() {
        return closeEntries(this.entries, this.io);
    }
}

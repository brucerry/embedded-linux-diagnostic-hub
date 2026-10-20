// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreparationEvidence } from '../../scripts/lib/observation-preparation-evidence.mjs';
import { preparationObservationSecurity } from '../../scripts/lib/observation-security.mjs';
import { runSecurityCommand } from '../../scripts/lib/pilot-security-command.mjs';
import { ProductLease } from '../../scripts/lib/product-collector-files.mjs';
import { createOwnershipHold } from '../../scripts/lib/product-entry-custody.mjs';
import { admitObservationShared } from '../../scripts/lib/observation-accounting.mjs';
export const recovered = JSON.parse(
    fs.readFileSync(new URL('./observation-preparation-transcript.json', import.meta.url), 'utf8'),
);
export const sourceRoot = path.resolve(import.meta.dirname, '../..');
export const challenge = () => {
    const binding = structuredClone(recovered.challenge);
    return {
        status: 'AWAITING_SAME_HOST_HUMAN_APPROVAL',
        binding,
        approval: {
            schema: 1,
            decision: 'approve-one-normal-pair',
            parentRun: binding.host.run,
            bindingSHA256: awaitDigest(binding),
            sourceSHA256: binding.sourceSHA256,
            commit: binding.host.commit,
        },
    };
};
import { observationDigest as awaitDigest } from '../../scripts/lib/windows-observation-approval.mjs';
export function fixture({ limits = {}, faultAt = -1, fault = null } = {}) {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-preparation-'))),
        out = path.join(tmp, 'out'),
        prep = path.join(out, 'preparation');
    fs.mkdirSync(prep, { recursive: true });
    let held,
        ledger,
        opens = 0,
        writerOpens = 0,
        calls = 0,
        now = 0,
        cancelled = false,
        writes = 0;
    const live = new Set();
    const io = new Proxy(fs, {
        get(target, key) {
            if (key === 'openSync')
                return (...args) => {
                    opens++;
                    if (args[1] === 'wx') writerOpens++;
                    if (fault === 'open' && opens === faultAt) throw Error('Injected open');
                    const fd = fs.openSync(...args);
                    live.add(fd);
                    return fd;
                };
            if (key === 'writeSync')
                return (fd, buffer, offset, length, position) => {
                    if (opens === faultAt && fault === 'partial') {
                        if (writes++) throw Error('Injected after partial write');
                        return fs.writeSync(fd, buffer, offset, Math.min(length, 7), position);
                    }
                    if (opens === faultAt && fault === 'write') throw Error('Injected write');
                    if (opens === faultAt && fault === 'zero') return 0;
                    return fs.writeSync(
                        fd,
                        buffer,
                        offset,
                        fault === 'short' ? Math.min(length, 7) : length,
                        position,
                    );
                };
            if (key === 'fsyncSync')
                return (fd) => {
                    if (opens === faultAt && fault === 'sync') throw Error('Injected sync');
                    return fs.fsyncSync(fd);
                };
            if (key === 'closeSync')
                return (fd) => {
                    if (opens === faultAt && fault === 'close') throw Error('Injected close');
                    fs.closeSync(fd);
                    live.delete(fd);
                };
            return target[key];
        },
    });
    const retain = (state) => {
        if (held) return held;
        const handle = {
            referenced: false,
            ref() {
                this.referenced = true;
            },
        };
        createOwnershipHold(state, (s, d) => ledger.record(s, d), {
            interval: () => handle,
            onRetained(hold) {
                held = { ...hold, handle };
            },
        });
        return held;
    };
    ledger = new PreparationEvidence(prep, {
        check() {
            assert(fs.lstatSync(prep).isDirectory());
        },
        admit: (bytes) => admitObservationShared(out, [], 'parent', bytes),
        hold: retain,
        io,
        limits,
    });
    const record = (s, d) => ledger.record(s, d);
    const template = JSON.parse(
        Buffer.from(
            recovered.dictionary.find(([stage]) => stage === 'security-output')[1].base64,
            'base64',
        ).toString(),
    );
    const query = ledger.securityQuery((src, ps, raw, options) =>
        runSecurityCommand(src, ps, raw, {
            ...options,
            identity: (p) => ({ path: p, sha256: 'a'.repeat(64), pe: { architecture: 'x64' } }),
            spawn(_exe, _args, launch) {
                calls++;
                const plans = JSON.parse(launch.env.HUB_NATIVE_PILOT_SECURITY_PATHS);
                const value = structuredClone(template);
                value.rows = plans.map((p) => {
                    const row = {
                        ...structuredClone(
                            template.rows.find((r) => r.kind === p.kind) ?? template.rows[0],
                        ),
                        ...p,
                    };
                    for (const ace of row.aces) {
                        const binary = Buffer.from(ace.binary, 'base64');
                        ace.flags = binary[1] = p.kind === 'file' ? 16 : 19;
                        ace.binary = binary.toString('base64');
                    }
                    return row;
                });
                return { status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' };
            },
        }),
    );
    const guard = () => {
        assert(!cancelled, 'Cancelled');
        assert(now < 1200000, 'Absolute preparation deadline');
    };
    const adapter = () =>
        preparationObservationSecurity(
            sourceRoot,
            'fixture-winps.exe',
            [
                { path: tmp, kind: 'directory' },
                { path: out, kind: 'directory' },
            ],
            {
                record,
                query,
                check: guard,
                onProcessState(state) {
                    if (!state.closed) retain({ phase: 'process-unknown', state });
                },
            },
        );
    return {
        tmp,
        out,
        prep,
        ledger,
        record,
        query,
        adapter,
        guard,
        retain,
        setFault(value, at = opens + 1) {
            fault = value;
            faultAt = at;
            writes = 0;
        },
        get calls() {
            return calls;
        },
        get writerOpens() {
            return writerOpens;
        },
        get opens() {
            return opens;
        },
        get held() {
            return held;
        },
        live,
        get now() {
            return now;
        },
        set now(value) {
            now = value;
        },
        cancel() {
            cancelled = true;
        },
        lease(ownerCheck) {
            return new ProductLease(
                path.join(tmp, 'fixture.lock'),
                { schema: 1, nonce: 'local-only' },
                { ownerCheck },
            );
        },
        close() {
            for (const fd of live)
                try {
                    fs.closeSync(fd);
                } catch {}
            fs.rmSync(tmp, { recursive: true });
        },
    };
}

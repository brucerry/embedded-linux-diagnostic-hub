// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSecurityCommand, requireSecurityProcess } from './pilot-security-command.mjs';
import { parsePilotSecurity } from './hosted-pilot-security.mjs';
import { ancestryIdentity, checkAncestry } from './windows-preflight.mjs';
import { closeEntries, writeAll } from './product-collector-evidence.mjs';
import { createOwnershipHold } from './product-entry-custody.mjs';
import { admitObservationShared } from './observation-accounting.mjs';
/** Same strict trusted-three-ACE descriptor policy as the approved hosted prerequisite; no ACL mutation. */
export function collectorObservationSecurity(manifest, sourceRoot) {
    const directory = path.join(manifest.outputRoot, 'collector-security');
    fs.mkdirSync(directory, { mode: 0o700 });
    const ancestry = ancestryIdentity(directory),
        bound = new Map([
            [manifest.outputRoot, manifest.outputRootSDDLSHA256],
            [manifest.canonicalTmp, manifest.canonicalTmpSDDLSHA256],
        ]);
    let bytes = 0,
        rows = 0,
        held;
    const record = (stage, data) => {
        checkAncestry(ancestry);
        const b = Buffer.from(JSON.stringify({ stage, data }) + '\n');
        assert(
            b.length <= 65536 && bytes + b.length <= 1048576 && rows < 2048,
            'Collector security evidence bound',
        );
        admitObservationShared(
            path.dirname(manifest.outputRoot),
            [manifest.observationPtyRoot],
            'collector',
            b.length,
        );
        const e = {
            fd: fs.openSync(
                path.join(directory, String(rows).padStart(6, '0') + '.json'),
                'wx',
                0o600,
            ),
            errors: [],
            attempted: false,
        };
        try {
            writeAll(e.fd, b);
        } finally {
            const closure = closeEntries([e]);
            if (!closure.complete) {
                held ??= createOwnershipHold(
                    { phase: 'collector-security-evidence-unknown', closure },
                    () => {},
                );
                throw Error('Collector security evidence closure failed');
            }
        }
        bytes += b.length;
        rows++;
    };
    const ownerCheck = (file) => ownerCheck.many([file])[0];
    ownerCheck.many = (files) => {
        const plans = files.map((file) => ({
            path: file,
            kind: fs.lstatSync(file).isDirectory() ? 'directory' : 'file',
        }));
        const reply = runSecurityCommand(
            sourceRoot,
            manifest.powershell.path,
            JSON.stringify(plans),
            {
                record,
                check: () => checkAncestry(ancestry),
                onProcessState: (state) => {
                    if (!state.closed)
                        held ??= createOwnershipHold(
                            { phase: 'collector-security-query-unknown', state },
                            record,
                        );
                },
            },
        );
        requireSecurityProcess(reply.result);
        assert(!held);
        const value = parsePilotSecurity(reply.stdout, plans, manifest.principalSID);
        for (const row of value.rows) {
            if (bound.has(row.path)) assert.equal(row.descriptorSHA256, bound.get(row.path));
            else {
                assert(bound.size < 8192);
                bound.set(row.path, row.descriptorSHA256);
            }
        }
        return value.rows;
    };
    return ownerCheck;
}

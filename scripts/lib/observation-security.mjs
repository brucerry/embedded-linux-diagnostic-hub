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
const closedInputRefusals = new WeakMap();
/** Only a completed query with durable raw records and no filesystem queries mints this proof. */
export function closedObservationSecurityRefusal(error) {
    return closedInputRefusals.get(error) ?? null;
}
function closedInputRefusal(reply, batch, ordinal, cause, principal) {
    const r = reply.result;
    if (
        reply.processState?.closed !== true ||
        r.error !== null ||
        r.signal !== null ||
        r.status !== 1 ||
        r.streams?.stdout?.truncated !== false ||
        r.streams?.stderr?.truncated !== false
    )
        return null;
    let v;
    try {
        v = JSON.parse(reply.stdout.replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
    if (
        v.schema !== 1 ||
        typeof v.principal !== 'string' ||
        !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(v.principal) ||
        (principal !== undefined && v.principal !== principal) ||
        v.complete !== false ||
        !Array.isArray(v.rows) ||
        v.rows.length !== 0 ||
        v.trace?.getItemCalls !== 0 ||
        v.trace?.getAclCalls !== 0 ||
        typeof v.error?.message !== 'string'
    )
        return null;
    const error = new Error('Closed security input refusal: ' + v.error.message.slice(0, 512), {
        cause,
    });
    closedInputRefusals.set(
        error,
        Object.freeze({
            kind: 'closed-security-input-refusal',
            batch: ordinal,
            plans: batch.length,
            processClosed: true,
            rawEvidenceClosed: true,
            getItemCalls: 0,
            getAclCalls: 0,
        }),
    );
    return error;
}
/** Logical many-path calls retain the production provider's unchanged one-to-three plan contract. */
function securityBatches(plans, principal, query, check, validateRows = () => {}) {
    assert(Array.isArray(plans) && plans.length > 0 && plans.length <= 8192);
    const rows = [];
    for (let i = 0; i < plans.length; i += 3) {
        check();
        const batch = plans.slice(i, i + 3),
            reply = query(batch);
        try {
            requireSecurityProcess(reply.result);
        } catch (error) {
            throw closedInputRefusal(reply, batch, i / 3, error, principal) ?? error;
        }
        const value = parsePilotSecurity(reply.stdout, batch, principal);
        principal ??= value.principal;
        validateRows(value.rows);
        rows.push(...value.rows);
        check();
    }
    return { principal, rows };
}
function checkedRows(files, principal, bound, query, check) {
    assert(Array.isArray(files) && files.length <= 8192);
    if (!files.length) return [];
    const plans = files.map((file) => ({
        path: file,
        kind: fs.lstatSync(file).isDirectory() ? 'directory' : 'file',
    }));
    // Validate each batch before admitting the next, but publish history only on full success.
    const additions = new Map();
    const rows = securityBatches(plans, principal, query, check, (batchRows) => {
        for (const row of batchRows) {
            const old = bound.get(row.path) ?? additions.get(row.path);
            if (old !== undefined) assert.equal(row.descriptorSHA256, old);
            else additions.set(row.path, row.descriptorSHA256);
        }
    }).rows;
    assert(bound.size + additions.size <= 8192, 'Observation descriptor history bound');
    for (const [file, hash] of additions) bound.set(file, hash);
    return rows;
}
/** Actual preparation adapter, with the same query/record/check path for initial and many calls. */
export function preparationObservationSecurity(
    sourceRoot,
    powershell,
    initialPlans,
    {
        environment = process.env,
        record,
        check = () => {},
        onProcessState = () => {},
        query = runSecurityCommand,
    } = {},
) {
    const invoke = (batch) =>
        query(sourceRoot, powershell, JSON.stringify(batch), {
            environment,
            record,
            check,
            onProcessState,
        });
    const initial = securityBatches(initialPlans, undefined, invoke, check),
        descriptors = new Map(initial.rows.map((r) => [r.path, r.descriptorSHA256]));
    const ownerCheck = (file) => ownerCheck.many([file])[0];
    ownerCheck.many = (files) => checkedRows(files, initial.principal, descriptors, invoke, check);
    return { initial, descriptors, ownerCheck };
}
/** Same strict trusted-three-ACE descriptor policy as the approved hosted prerequisite; no ACL mutation. */
export function collectorObservationSecurity(
    manifest,
    sourceRoot,
    {
        query = runSecurityCommand,
        retainOwnership = createOwnershipHold,
        check = () => {},
        prerequisiteRoots = [manifest.observationPtyRoot],
        admit = () => {},
    } = {},
) {
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
    const retain = (state) => {
        if (held) return held;
        return retainOwnership(state, record, {
            onRetained: (hold) => {
                held = hold;
            },
        });
    };
    const record = (stage, data) => {
        try {
            checkAncestry(ancestry);
            const b = Buffer.from(JSON.stringify({ stage, data }) + '\n');
            assert(
                b.length <= 65536 && bytes + b.length <= 1048576 && rows < 2048,
                'Collector security evidence bound',
            );
            admit(b.length);
            admitObservationShared(
                path.dirname(manifest.outputRoot),
                prerequisiteRoots,
                'collector',
                b.length,
            );
            const ordinal = rows++;
            bytes += b.length;
            const e = {
                fd: fs.openSync(
                    path.join(directory, String(ordinal).padStart(6, '0') + '.json'),
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
                    retain({ phase: 'collector-security-evidence-unknown', closure });
                    throw Error('Collector security evidence closure failed');
                }
            }
        } catch (error) {
            retain({
                phase: 'collector-security-evidence-unknown',
                error: String(error).slice(0, 4096),
            });
            throw error;
        }
    };
    const ownerCheck = (file) => ownerCheck.many([file])[0];
    ownerCheck.many = (files) =>
        checkedRows(
            files,
            manifest.principalSID,
            bound,
            (batch) => {
                const reply = query(sourceRoot, manifest.powershell.path, JSON.stringify(batch), {
                    record,
                    check: () => {
                        check();
                        checkAncestry(ancestry);
                    },
                    onProcessState: (state) => {
                        if (!state.closed)
                            retain({ phase: 'collector-security-query-unknown', state });
                    },
                });
                assert(!held, 'Collector security custody remains held');
                return reply;
            },
            () => {
                check();
                checkAncestry(ancestry);
            },
        );
    return ownerCheck;
}

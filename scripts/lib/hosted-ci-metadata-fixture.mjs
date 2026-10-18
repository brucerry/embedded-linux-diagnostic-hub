import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    metadataIdentity,
    ancestryIdentity,
    checkAncestry,
    metadataFileProbe,
} from './windows-preflight.mjs';

export const hostedMetadataFixturePolicy = Object.freeze({
    name: 'github-hosted-windows-synthetic-metadata-v1',
    repository: 'brucerry/embedded-linux-diagnostic-hub',
    scope: 'fresh-nonce-child-only; synthetic metadata I/O only',
    trustedBoundary:
        'fresh GitHub Windows VM, reviewed job code/actions/dependencies, SYSTEM/Administrators/exact runner SID',
    excludedThreats: 'hostile co-resident processes, malicious same-user code or administrators',
    userMachineQualification: false,
    effectiveAccessMeasured: false,
    atomicCustody: false,
    collectionApproval: false,
    securityChanges: false,
    reportOutput: 'nonsecret synthetic CI facts; not private capture storage',
});
const stable = (id) => ({
    path: id.path,
    realpath: id.realpath,
    directory: id.directory,
    dev: id.dev,
    ino: id.ino,
});
const physical = (literal, identity = metadataIdentity) => {
    const id = identity(literal);
    assert(
        id.directory && !id.file && id.realpath === literal,
        'Physical fixture directory required.',
    );
    return id;
};
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
/** Fixed hosted-CI context; never an arbitrary path or globally trusted owner predicate. */
export function hostedFixtureContext(
    canonicalTmp,
    environment = process.env,
    {
        platform = process.platform,
        realpath = fs.realpathSync,
        identity = metadataIdentity,
        ancestry = ancestryIdentity,
    } = {},
) {
    assert.equal(platform, 'win32');
    for (const [key, expected] of Object.entries({
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'X64',
        GITHUB_REPOSITORY: hostedMetadataFixturePolicy.repository,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_RUN_ATTEMPT: '1',
        HUB_WINDOWS_PREFLIGHT_ONLY: '1',
    }))
        assert.equal(environment[key], expected, 'Hosted fixture context: ' + key);
    assert(/^[1-9]\d{0,19}$/.test(environment.GITHUB_RUN_ID));
    assert(/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA));
    assert(
        typeof environment.USERPROFILE === 'string' &&
            path.win32.isAbsolute(environment.USERPROFILE),
    );
    physical(environment.USERPROFILE, identity);
    const profile = realpath(environment.USERPROFILE);
    assert(/^C:\\Users\\[^\\]+$/i.test(profile), 'Fixed hosted C user profile required.');
    const parent = path.win32.join(profile, 'AppData', 'Local', 'Temp'),
        local = path.win32.join(profile, 'AppData', 'Local');
    assert.equal(realpath(parent), parent, 'No alternate fixture parent.');
    const parentIdentity = physical(parent, identity),
        tmpIdentity = physical(canonicalTmp, identity);
    assert(
        sameFile(parentIdentity, tmpIdentity),
        'Canonical temporary directory must be profile Temp.',
    );
    assert(typeof environment.LOCALAPPDATA === 'string');
    assert(
        sameFile(physical(environment.LOCALAPPDATA, identity), physical(local, identity)),
        'LOCALAPPDATA/profile binding differs.',
    );
    const preserved = {
        TEMP: environment.TEMP,
        TMP: environment.TMP,
        USERPROFILE: environment.USERPROFILE,
        LOCALAPPDATA: environment.LOCALAPPDATA,
    };
    return {
        policy: hostedMetadataFixturePolicy.name,
        parent,
        parentIdentity: stable(parentIdentity),
        ancestry: ancestry(parent),
        canonicalTmp,
        host: {
            repository: environment.GITHUB_REPOSITORY,
            run: environment.GITHUB_RUN_ID,
            attempt: '1',
            commit: environment.GITHUB_SHA,
        },
        preservedEnvironment: { TEMP: preserved.TEMP ?? null, TMP: preserved.TMP ?? null },
        checkEnvironment() {
            for (const [key, value] of Object.entries(preserved))
                assert.equal(environment[key], value, 'Fixture environment drift: ' + key);
        },
    };
}
/** Recognizes one exact observed filesystem ACL shape; not an effective-access engine. */
function inheritedFullControlSID(ace) {
    assert(
        ace.type === 0 && ace.flags === 19,
        'Only inherited OI/CI standard allow ACEs admitted.',
    );
    const bytes = Buffer.from(ace.binary, 'base64');
    assert.equal(bytes.toString('base64'), ace.binary);
    assert(bytes.length >= 20 && bytes[0] === 0 && bytes[1] === 19);
    assert.equal(bytes.readUInt16LE(2), bytes.length);
    assert.equal(bytes.readUInt32LE(4), 0x1f01ff, 'Exact FILE_ALL_ACCESS mask required.');
    const count = bytes[9];
    assert(
        bytes[8] === 1 && count >= 1 && count <= 15 && bytes.length === 16 + count * 4,
        'Canonical SID-only standard ACE required.',
    );
    let authority = 0n;
    for (const byte of bytes.subarray(10, 16)) authority = (authority << 8n) | BigInt(byte);
    return (
        'S-1-' +
        authority +
        Array.from({ length: count }, (_, i) => '-' + bytes.readUInt32LE(16 + i * 4)).join('')
    );
}
export function validateHostedFixtureDescriptors(report, paths, principal) {
    assert(
        /^S-1-5-21-\d+-\d+-\d+-\d+$/.test(principal) && principal.length <= 184,
        'Exact observed runner user SID required.',
    );
    assert(
        report?.complete === true && report.rows.length === 2 && paths.length === 2,
        'Complete parent/child provider report required.',
    );
    const trusted = ['S-1-5-18', 'S-1-5-32-544', principal].sort();
    report.rows.forEach((row, index) => {
        assert.equal(row.path, paths[index]);
        assert.equal(row.availability, 'observed');
        assert(trusted.includes(row.owner), 'Unexpected fixture-context owner; no repair.');
        assert(
            row.daclPresent === true &&
                row.daclNull === false &&
                row.daclState === 'nonempty' &&
                row.aceCount === 3 &&
                row.aces?.length === 3,
        );
        assert.deepEqual(
            row.aces.map(inheritedFullControlSID).sort(),
            trusted,
            'Unexpected inherited grants; no repair.',
        );
    });
    assert.equal(
        report.rows[1].group,
        report.rows[0].group,
        'Fresh child group differs from parent.',
    );
    return {
        policy: hostedMetadataFixturePolicy.name,
        trustedSIDs: trusted,
        parent: paths[0],
        child: paths[1],
        descriptorAccepted: true,
        ownerSIDEqualityRequired: false,
        effectiveAccessMeasured: false,
        atomicCustody: false,
        collectionApproval: false,
    };
}
/** Exclusive empty child -> descriptor/identity verification -> three existing probes -> joined cleanup. */
export async function runHostedMetadataFixture({
    context,
    principal,
    inspect,
    admit,
    cleanupCheck,
    observe,
    io = fs,
    nonce = randomUUID,
}) {
    assert.equal(context.policy, hostedMetadataFixturePolicy.name);
    const id = nonce();
    assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id));
    const child = path.join(context.parent, 'diagnostic-hub-ci-metadata-' + id),
        result = {
            policy: hostedMetadataFixturePolicy.name,
            parent: context.parent,
            child,
            host: context.host,
            preservedEnvironment: context.preservedEnvironment,
            created: false,
            descriptorAccepted: false,
            probes: [],
            failures: [],
            cleanup: { allProbeHandlesClosed: null, removed: false, retained: false, errors: [] },
            controlPassed: false,
            collectionApproval: false,
            securityChanges: false,
        };
    let childIdentity = null,
        childAncestry = null,
        probePending = false;
    const binding = () => {
        context.checkEnvironment();
        cleanupCheck();
        checkAncestry(context.ancestry);
        assert.deepEqual(
            stable(physical(context.parent)),
            context.parentIdentity,
            'Fixture parent identity drift.',
        );
        if (childIdentity) {
            assert.deepEqual(
                stable(physical(child)),
                childIdentity,
                'Fixture child identity drift.',
            );
            checkAncestry(childAncestry);
        }
    };
    const work = () => {
        admit();
        binding();
    };
    try {
        work();
        fs.mkdirSync(child); // Exclusive: no recursive/adopt-existing path or descriptor setter.
        result.created = true;
        childIdentity = stable(physical(child));
        childAncestry = ancestryIdentity(child);
        observe('metadata-fixture-created', {
            policy: result.policy,
            parent: context.parent,
            child,
            host: context.host,
            created: true,
            identity: childIdentity,
            collectionApproval: false,
            securityChanges: false,
        });
        work();
        const descriptors = await inspect([context.parent, child]);
        work();
        assert.deepEqual(
            fs.readdirSync(child),
            [],
            'Fresh fixture must be empty before payload admission.',
        );
        const admission = validateHostedFixtureDescriptors(
            descriptors,
            [context.parent, child],
            principal,
        );
        result.descriptorAccepted = true;
        observe('metadata-fixture-admission', { ...admission, identity: childIdentity });
        for (const fault of [null, 'sync', 'close']) {
            work();
            probePending = true;
            const proof = metadataFileProbe(child, {
                fault,
                check: work,
                cleanupCheck: binding,
                io,
            });
            probePending = false;
            result.probes.push(proof);
            observe('metadata-io-' + (fault ?? 'nominal'), {
                ...proof,
                fixture: child,
                policy: result.policy,
            });
            assert(proof.controlPassed, 'Hosted synthetic metadata control failed.');
        }
    } catch (error) {
        result.failures.push(String(error).slice(0, 512));
    } finally {
        result.cleanup.allProbeHandlesClosed =
            !probePending &&
            result.probes.every((proof) => proof.handles.every((handle) => handle.closed));
        if (result.created) {
            try {
                assert(
                    childIdentity && result.cleanup.allProbeHandlesClosed,
                    'Owned fixture closure/identity unknown; retain.',
                );
                binding();
                fs.rmdirSync(child); // Empty exact owned child only; never recursive cleanup.
                result.cleanup.removed = true;
            } catch (error) {
                result.cleanup.errors.push(String(error).slice(0, 512));
            }
            result.cleanup.retained = !result.cleanup.removed;
        }
        result.controlPassed =
            result.descriptorAccepted &&
            result.probes.length === 3 &&
            result.probes.every((proof) => proof.controlPassed) &&
            result.cleanup.removed &&
            !result.failures.length &&
            !result.cleanup.errors.length;
        observe('metadata-fixture-cleanup', {
            ...result,
            probes: result.probes.map((proof) => ({
                fault: proof.fault,
                controlPassed: proof.controlPassed,
                actualCleanupComplete: proof.actualCleanupComplete,
                handles: proof.handles,
            })),
        });
    }
    return result;
}

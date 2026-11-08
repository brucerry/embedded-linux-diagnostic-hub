import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseMacNativeArgs,
    validateMacNativeRequest,
    NATIVE_LIMITS,
    MAC_INSTALL_ONLY_CASE,
} from '../scripts/lib/macos-native-contract.mjs';
import {
    createMacNativeEffects,
    macNativeSourcePins,
    NATIVE_WORKSPACE,
} from '../scripts/lib/macos-native-adapter.mjs';
import {
    runMacInstallerActions,
    runMacInstallOnlyActions,
    validateMacInstallOnlyAction,
} from '../scripts/lib/macos-installer-actions.mjs';
import { createMacInstallerObservation } from '../scripts/lib/macos-installer-observation.mjs';
import { digest, laneFiles } from '../scripts/lib/staged-artifact-gate.mjs';
import {
    projectMacHelperChild,
    macHelperRecordPath,
    inspectMacInstallHelper,
} from '../scripts/lib/macos-installer-child.mjs';
import { validateMacInstalledPayloadSample } from '../scripts/lib/macos-payload-identity.mjs';

export const MAC_NATIVE_HELP = `Usage: node --import <pinned-tsx> tests/macos-installer-native-cli.mjs --validate|--run
  --task-root <explicit-owned-task-directory> --node <selected-node> --tsx <selected-loader>
  --playwright <source-root/node_modules/@playwright/test/index.mjs>
  --approval <explicit-authorized-JSON> --approval-sha256 <SHA256>
  --root <fresh-task-run-root> --source-root <matching-clean-committed-source>
  --current-zip <ZIP> --current-info <build-info.json> --current-tree <bundle-inventory.json>
  --prior-zip <ZIP> --prior-info <build-info.json> --prior-tree <bundle-inventory.json>
  Optional --case macos-bundle:install selects current-only install; omit every prior-* flag.
  It requires macos-native-install-only approval, the exact case and only install/helper-stage-disposal.
  It retains a partial case, helper child/streams, installed payload and shipping build info;
  it cannot produce an all-nine observation or release acceptance.
No default execution. --validate reads bindings only; it does not claim a run or execute helpers.
Host paths are explicit configuration, not execution permission. Missing configuration refuses before IO.
The source-local Playwright path is a nominal dependency pin, not proof of the loaded SDK closure.
--run requires separate explicit effects approval; a JSON flag does not confer authority.
Future native observations remain unqualified until external exit/evidence review.
`;
const bounded = (value, cap = NATIVE_LIMITS.resultBytes) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    assert.ok(bytes.length <= cap);
    return bytes;
};
const identity = ({ version, sourceCommit, zipPath, zipSHA256, asarSHA256 }) => ({
    version,
    sourceCommit,
    zipPath,
    zipSHA256,
    asarSHA256,
});
function publishTerminalFacts(io, root) {
    const rows = [];
    for (const [index, child] of io.state.children.entries()) {
        const streams = {};
        for (const stream of ['stdout', 'stderr']) {
            const bytes = Buffer.concat(child[stream]);
            assert.equal(bytes.length, child[stream + 'Bytes']);
            assert.ok(bytes.length <= NATIVE_LIMITS.streamBytes);
            const name = 'child-' + index + '.' + stream;
            io.publish(
                path.join(root, 'evidence', name),
                bytes,
                NATIVE_LIMITS.streamBytes,
                0o600,
                true,
            );
            streams[stream] = { path: name, bytes: bytes.length, sha256: digest(bytes) };
        }
        // A failed/refused helper row is retained truthfully; only the separate install
        // consumer requires normal success. No request environment or raw handle is copied.
        const row = projectMacHelperChild(child, index, streams);
        if (row.operation !== null)
            io.publish(
                path.join(root, macHelperRecordPath(index)),
                bounded(row, NATIVE_LIMITS.stageBytes),
                NATIVE_LIMITS.stageBytes,
                0o600,
                true,
            );
        rows.push(row);
    }
    for (const [index, app] of io.state.desktops.entries())
        rows.push({
            kind: 'owned-application',
            index,
            closure: app.desktop.snapshot(),
            privateEndpointAndStreamBuffersPublished: false,
        });
    assert.ok(rows.length <= NATIVE_LIMITS.terminalRows);
    io.publish(
        path.join(root, 'evidence/terminal-index.json'),
        bounded(
            {
                rows,
                capturedBytes: io.state.terminalBytes,
                capturedRows: io.state.terminalRows,
                aggregateByteAllowance: NATIVE_LIMITS.terminalBytes,
                aggregateRowAllowance: NATIVE_LIMITS.terminalRows,
                applicationStreamPolicy:
                    'private-retained-buffers-counts-only-no-inspector-endpoint-publication',
            },
            NATIVE_LIMITS.stageBytes,
        ),
        NATIVE_LIMITS.stageBytes,
        0o600,
        true,
    );
    return rows;
}

async function publishInstallOnly(admitted, io, actions) {
    const root = admitted.parsed.root,
        selected = admitted.packages.current;
    assert.equal(actions.result.status, 'verified');
    assert.equal(actions.custody.pending, null);
    assert.equal(actions.result.cases.length, 1);
    const actionCase = actions.result.cases[0];
    validateMacInstallOnlyAction(actionCase, {
        version: selected.version,
        sourceCommit: selected.sourceCommit,
        zipSHA256: selected.zipSHA256,
        asarSHA256: selected.asarSHA256,
    });
    assert.equal(io.state.desktops.length, 0);
    assert.equal(io.needsHold(), false);
    const rows = publishTerminalFacts(io, root);
    const helpers = rows.filter((row) => row.operation?.caseId === MAC_INSTALL_ONLY_CASE);
    assert.equal(helpers.length, 1);
    const child = helpers[0];
    inspectMacInstallHelper(child, {
        lane: 'darwin-' + admitted.metadata.arch,
        version: selected.version,
        sourceCommit: admitted.approval.sourceCommit,
        sourceTree: admitted.approval.sourceTree,
        artifacts: [
            {
                name: selected.info.asset,
                bytes: selected.identity.zipBytes,
                sha256: selected.zipSHA256,
            },
        ],
    });
    const reference = async (relative, cap) => {
        const bytes = await io.read(path.join(root, relative), cap);
        return { bytes, ref: { path: relative, bytes: bytes.length, sha256: digest(bytes) } };
    };
    const helperChild = await reference(macHelperRecordPath(child.index), NATIVE_LIMITS.stageBytes);
    assert.deepEqual(JSON.parse(helperChild.bytes.toString()), child);
    const installedPayload = await reference(
        'install/evidence/installed-payload-1.json',
        NATIVE_LIMITS.resultBytes,
    );
    validateMacInstalledPayloadSample(JSON.parse(installedPayload.bytes.toString()), {
        caseId: MAC_INSTALL_ONLY_CASE,
        version: selected.version,
        sourceCommit: selected.sourceCommit,
        sourceTree: admitted.approval.sourceTree,
        archive: {
            name: selected.info.asset,
            bytes: selected.identity.zipBytes,
            sha256: selected.zipSHA256,
        },
        payloadIdentity: selected.payloadIdentity,
    });
    const infoBytes = await io.read(selected.identity.info, 65536);
    assert.equal(digest(infoBytes), selected.identity.infoSHA256);
    const shippingPath = 'evidence/current-shipping-build-info.json';
    io.publish(path.join(root, shippingPath), infoBytes, 65536, 0o600, true);
    const shippingBuildInfo = await reference(shippingPath, 65536);
    assert.ok(shippingBuildInfo.bytes.equals(infoBytes));
    const casePath = 'evidence/install-only-case.json';
    io.publish(
        path.join(root, casePath),
        bounded(actionCase, NATIVE_LIMITS.stageBytes),
        NATIVE_LIMITS.stageBytes,
        0o600,
        true,
    );
    const caseRecord = await reference(casePath, NATIVE_LIMITS.stageBytes);
    validateMacInstallOnlyAction(JSON.parse(caseRecord.bytes.toString()), {
        version: selected.version,
        sourceCommit: selected.sourceCommit,
        zipSHA256: selected.zipSHA256,
        asarSHA256: selected.asarSHA256,
    });
    const helperBytes = await io.read(path.join(root, 'bin/download-run-macos.sh'), 65536);
    io.gate();
    assert.equal(io.needsHold(), false);
    return bounded({
        status: 'INSTALL_ONLY_OBSERVED_REVIEW_REQUIRED',
        case: MAC_INSTALL_ONLY_CASE,
        qualificationStatus: 'unverified',
        sourceCommit: admitted.approval.sourceCommit,
        sourceTree: admitted.approval.sourceTree,
        root,
        operationId: child.operation.operationId,
        records: {
            actionCase: caseRecord.ref,
            helperChild: helperChild.ref,
            installedPayload: installedPayload.ref,
            shippingBuildInfo: shippingBuildInfo.ref,
        },
        helperFixture: {
            diskIdentityOnly: true,
            physicalLoadedBytesVerified: false,
            transport: 'locally-derived-offline-mirror',
            consent: 'fixed-install-substitution-not-human-dialog',
            originalHelperSHA256: admitted.approval.pins.find((pin) => pin.role === 'helper')
                .sha256,
            executedHelper: {
                path: 'bin/download-run-macos.sh',
                bytes: helperBytes.length,
                sha256: digest(helperBytes),
            },
            disposal: 'guarded-helper-owned-download-and-install-stages-only',
        },
        nativeEffects: true,
        fullLifecycle: false,
        descendantClosure: 'UNKNOWN',
        releaseAcceptance: false,
    }).toString();
}

async function artifactRecords(admitted, io) {
    const selected = admitted.packages.current,
        helper = admitted.approval.pins.find((pin) => pin.role === 'helper');
    const zipName = selected.info.asset;
    const zipChecksum = Buffer.from(selected.zipSHA256 + '  ' + zipName + '\n');
    const helperChecksum = Buffer.from(helper.sha256 + '  download-run-macos.sh\n');
    const info = await io.read(selected.identity.info, 65536);
    assert.equal(digest(info), selected.identity.infoSHA256);
    const values = [
        { name: zipName, bytes: selected.identity.zipBytes, sha256: selected.zipSHA256 },
        { name: zipName + '.sha256', bytes: zipChecksum.length, sha256: digest(zipChecksum) },
        { name: 'download-run-macos.sh', bytes: helper.bytes, sha256: helper.sha256 },
        {
            name: 'download-run-macos.sh.sha256',
            bytes: helperChecksum.length,
            sha256: digest(helperChecksum),
        },
        {
            name: 'macos-build-info-' + admitted.metadata.arch + '.json',
            bytes: info.length,
            sha256: digest(info),
        },
    ];
    assert.deepEqual(
        values.map((item) => item.name).sort(),
        laneFiles(selected.version, 'darwin-' + admitted.metadata.arch),
    );
    return values;
}

// Import/help do not construct IO. Dependency injection is exclusively for inert unit tests.
export async function runMacNativeCLI(argv, dependencies = {}) {
    const state = {
        phase: 'arguments',
        io: null,
        admitted: null,
        actions: null,
        holdRequired: false,
        publicationComplete: false,
    };
    const now = dependencies.now ?? (() => performance.now());
    const start = now();
    let parsed;
    try {
        parsed = parseMacNativeArgs(argv);
        if (parsed.mode === 'help') return { exitCode: 0, output: MAC_NATIVE_HELP, state };
        state.phase = 'input-validation';
        const makeIO =
            dependencies.createIO ??
            (await import('../scripts/lib/macos-native-io.mjs')).createMacNativeIO;
        const io = (state.io = makeIO(start, { taskRoot: parsed['task-root'] }));
        const admitted = (state.admitted = await validateMacNativeRequest(
            parsed,
            io,
            (dependencies.sourcePins ?? macNativeSourcePins)(parsed),
        ));
        const installOnly = parsed.case === MAC_INSTALL_ONLY_CASE;
        io.gate();
        if (parsed.mode === 'validate')
            return {
                exitCode: 0,
                output: bounded({
                    status: 'INPUT_BINDINGS_VALIDATED_ONLY',
                    nativeEffects: false,
                    qualificationStatus: 'unverified',
                    approvalSHA256: parsed['approval-sha256'],
                    root: parsed.root,
                    sourceCommit: admitted.approval.sourceCommit,
                    current: identity(admitted.packages.current),
                    ...(installOnly
                        ? { case: MAC_INSTALL_ONLY_CASE }
                        : { prior: identity(admitted.packages.prior) }),
                }).toString(),
                state,
            };
        state.phase = 'space-and-once-only-claim';
        assert.ok(io.freeBytes() >= BigInt(admitted.approval.minimumFreeBytes));
        await io.claim(admitted); // Exclusive durable SPENT, before any process submission. Never reused.
        state.phase = 'source-identity';
        await io.sourceContext(admitted.approval.sourceRoot, admitted.approval);
        io.allocateRoot();
        state.phase = 'adapter-initialization';
        const effects = await (dependencies.createEffects ?? createMacNativeEffects)(admitted, io);
        await effects.initialize();
        io.publish(
            path.join(parsed.root, 'evidence/admission.json'),
            bounded(admitted.summary, NATIVE_LIMITS.admissionBytes),
            NATIVE_LIMITS.admissionBytes,
            0o600,
            true,
        );
        if (installOnly) {
            state.phase = 'install-only-case';
            state.actions = await (dependencies.runInstallOnlyActions ?? runMacInstallOnlyActions)({
                inputs: {
                    lane: 'darwin-' + admitted.metadata.arch,
                    fixtureParent: parsed.root,
                    bundleIdentifier: 'dev.diagnostichub.desktop',
                    current: identity(admitted.packages.current),
                },
                effects,
            });
            state.phase = 'install-only-publication';
            const output = await publishInstallOnly(admitted, io, state.actions);
            state.publicationComplete = true;
            state.phase = 'completed-install-only-unqualified';
            return { exitCode: 0, output, state };
        }
        state.phase = 'nine-lifecycle-cases';
        state.actions = await (dependencies.runActions ?? runMacInstallerActions)({
            inputs: {
                lane: 'darwin-' + admitted.metadata.arch,
                fixtureParent: parsed.root,
                bundleIdentifier: 'dev.diagnostichub.desktop',
                current: identity(admitted.packages.current),
                previous: identity(admitted.packages.prior),
            },
            effects,
        });
        io.gate();
        const status = state.actions.result.status;
        // Known completed failures retain their exact case and terminal evidence. Unknown
        // effects/owners must stop here without further filesystem/child work.
        assert.ok(['verified', 'failed', 'unavailable'].includes(status));
        assert.equal(io.needsHold(), false);
        assert.equal(state.actions.custody.pending, null);
        assert.ok(state.actions.custody.owners.every((owner) => owner.closed));
        state.phase = 'receipt-publication';
        publishTerminalFacts(io, parsed.root);
        const observation = createMacInstallerObservation({
            context: {
                version: admitted.packages.current.version,
                sourceCommit: admitted.approval.sourceCommit,
                sourceTree: admitted.approval.sourceTree,
            },
            runtime: {
                ...admitted.metadata,
                executableSHA256: admitted.approval.pins.find((pin) => pin.role === 'node').sha256,
            },
            artifacts: await artifactRecords(admitted, io),
            command: [
                admitted.metadata.executable,
                '--import',
                admitted.approval.pins.find((pin) => pin.role === 'tsx').path,
                path.join(NATIVE_WORKSPACE, 'tests/macos-installer-native-cli.mjs'),
                ...argv,
            ],
            compactCommandEvidence: true, // Exact 33-part CLI grammar is retained once in digest-bound stages; byte caps unchanged, no truncation.
            startedAt: admitted.approval.issuedAt,
        });
        observation.attachNativeActions(state.actions.result);
        observation.completeNativeActions(new Date(io.nowUTC()).toISOString());
        const { stageBytes, receiptBytes } = observation.serialize(); // BOTH full buffers checked before either allocation.
        io.publish(
            path.join(parsed.root, 'evidence/stages.json'),
            stageBytes,
            NATIVE_LIMITS.stageBytes,
            0o600,
            true,
        );
        io.publish(
            path.join(parsed.root, 'evidence/observation.json'),
            receiptBytes,
            NATIVE_LIMITS.resultBytes,
            0o600,
            true,
        );
        io.gate();
        assert.equal(io.needsHold(), false);
        state.publicationComplete = true;
        state.phase = status === 'verified' ? 'completed-unqualified' : 'completed-' + status;
        return {
            exitCode: status === 'verified' ? 0 : 2,
            output: bounded({
                status:
                    status === 'verified'
                        ? 'ACTIONS_OBSERVED_REVIEW_REQUIRED'
                        : 'ACTIONS_' + status.toUpperCase() + '_EVIDENCE_RETAINED',
                qualificationStatus: 'unverified',
                stages: { bytes: stageBytes.length, sha256: digest(stageBytes) },
                receipt: { bytes: receiptBytes.length, sha256: digest(receiptBytes) },
                root: parsed.root,
                nativeEffects: true,
                descendantClosure: 'UNKNOWN',
                sidecarOrigin: 'locally-derived-offline-fixture-not-release-publication',
                ...(status !== 'verified' ? { actions: publicActionSummary(state.actions) } : {}),
            }).toString(),
            state,
        };
    } catch (error) {
        state.failure = error; // Private custody only; never serialized into public diagnostics.
        const io = state.io;
        state.holdRequired = Boolean(
            io?.needsHold() ||
            (state.actions && !state.publicationComplete) ||
            state.actions?.custody?.pending ||
            state.actions?.custody?.owners?.some((owner) => !owner.closed),
        );
        const output =
            !io || io.beforeExpiry()
                ? bounded({
                      status: 'BLOCKED_OR_RETAINED_UNKNOWN',
                      phase: state.phase,
                      root: parsed?.root ?? null,
                      rootAllocated: io?.state.rootAllocated ?? false,
                      onceOnlyClaim: io?.state.claim ?? null,
                      holdRequired: state.holdRequired,
                      qualificationStatus: 'unverified',
                      reason: io?.state.reason ?? 'NATIVE_PREFLIGHT_OR_ACTION_REFUSAL',
                      actions: publicActionSummary(state.actions),
                  }).toString()
                : '';
        return { exitCode: 2, output, state };
    }
}

function publicActionSummary(actions) {
    return actions
        ? {
              status: actions.result.status,
              reason: actions.result.reason ?? null,
              cases: actions.result.cases.map(({ id, status }) => ({ id, status })),
          }
        : null;
}
function retainNativeStateForever() {
    return new Promise(() => {
        setInterval(() => {}, 1000);
    });
}
// Inert streams/parking may be injected by tests. This is the sole public-output boundary.
export async function finishMacNativeEntry(
    result,
    {
        stdout = process.stdout,
        globals = globalThis,
        setExitCode = (code) => {
            process.exitCode = code;
        },
        park = retainNativeStateForever,
    } = {},
) {
    globals.__hubNativeRetained = result.state; // Before every fallible public-channel operation.
    const parking = result.state.holdRequired ? park(result.state) : null;
    const outputFailure = () => {
        result.state.publicOutputFailure = 'PUBLIC_OUTPUT_FAILED';
        result.exitCode = 2;
        setExitCode(2);
    };
    setExitCode(result.exitCode);
    try {
        stdout.on('error', outputFailure); // Remains installed for late asynchronous errors.
        if (result.output && (!result.state.io || result.state.io.beforeExpiry())) {
            assert.ok(Buffer.byteLength(result.output) <= NATIVE_LIMITS.resultBytes);
            result.state.publicOutputAttempted = true;
            stdout.write(result.output); // One attempt; no raw error output, retry or stream close.
        }
    } catch {
        outputFailure();
    }
    if (parking) await parking;
    return result;
}

// Only this entry branch writes output or parks retained native ownership. Unit imports never enter it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await runMacNativeCLI(process.argv.slice(2));
    await finishMacNativeEntry(result);
}

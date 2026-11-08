// Authored control data only. No installer, native adapter, process or real observation runs.
import { digest, installerCases, laneFiles } from '../../scripts/lib/staged-artifact-gate.mjs';
import { WINDOWS_SETUP_ASSET } from '../../scripts/lib/windows-setup-release.mjs';
export const installerJSON = (value) => Buffer.from(JSON.stringify(value) + '\n');
export function installerMemoryFixture(lane = 'darwin-arm64') {
    const selected = {
        version: '0.6.0',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        runId: '123',
        runAttempt: '2',
        lane,
    };
    const artifacts = laneFiles(selected.version, lane).map((name) => ({
        name,
        bytes: 7,
        sha256: digest('synthetic-' + name),
    }));
    const expected = { ...selected, artifacts };
    const files = new Map();
    const values = new Map();
    const receipt = {
        schemaVersion: 2,
        kind: 'native-installer-lifecycle',
        status: 'passed',
        ...expected,
        runtime: {
            platform: lane.split('-')[0],
            arch: lane.slice(lane.indexOf('-') + 1),
            node: '24.21.0',
            osRelease: 'synthetic',
            executable: lane.startsWith('win32') ? 'C:\\synthetic\\node.exe' : '/synthetic/node',
            executableSHA256: 'c'.repeat(64),
        },
        review: { reviewer: 'synthetic-schema-control', reviewedAt: '2026-11-07T00:00:00.000Z' },
        cases: installerCases(lane).map((id) => {
            const name = lane.startsWith('darwin')
                ? 'Diagnostic-Hub-macos-' + lane.slice(7) + '.zip'
                : lane.startsWith('win32')
                  ? WINDOWS_SETUP_ASSET
                  : id.startsWith('linux-folder:')
                    ? 'Diagnostic-Hub-linux-x64.tar.gz'
                    : 'Diagnostic-Hub-linux-x64.AppImage';
            const value = {
                schemaVersion: 1,
                kind: 'installer-case-observation',
                ...selected,
                caseId: id,
                package: structuredClone(artifacts.find((x) => x.name === name)),
                observation: null,
            };
            if (lane.startsWith('darwin') && id.endsWith(':offline-launch')) {
                const held = { pid: 42, exitObserved: false, closeObserved: false, reason: null };
                value.observation = {
                    kind: 'macos-owned-offline-launch/v1',
                    prequit: {
                        ownerId: 'synthetic-owner',
                        identity: {
                            pid: 42,
                            version: selected.version,
                            ready: true,
                            packaged: true,
                            offline: true,
                        },
                        scope: 'installer-case',
                        closure: held,
                    },
                    closed: {
                        ownerId: 'synthetic-owner',
                        closure: {
                            ...held,
                            exitObserved: true,
                            closeObserved: true,
                            exitCode: 0,
                            signal: null,
                            quitIntent: true,
                            quitScheduledAck: true,
                            quitComplete: true,
                            streams: { stdoutEOF: true, stderrEOF: true },
                            genericPending: 0,
                            shutdownPending: 0,
                            mainPendingCount: 0,
                            publicationFDCount: 0,
                            mainPending: 0,
                            rejectedOwnedCalls: 0,
                            mainTransportClosed: true,
                            rendererTransportClosed: true,
                            shutdown: { complete: true, incident: null },
                            physicalDescendantClosure: false,
                        },
                    },
                };
            }
            const file = 'cases/' + id.replace(':', '/') + '.json',
                bytes = installerJSON(value),
                reference = { path: file, bytes: bytes.length, sha256: digest(bytes) };
            files.set(file, bytes);
            values.set(id, value);
            return {
                id,
                status: 'passed',
                command: ['synthetic-never-executed', id],
                exitCode: 0,
                signal: null,
                evidence: [reference],
                lifecycleEvidence: { ...reference },
            };
        }),
    };
    function change(id, update) {
        const value = values.get(id);
        update(value);
        const item = receipt.cases.find((item) => item.id === id),
            ref = item.lifecycleEvidence,
            bytes = installerJSON(value);
        files.set(ref.path, bytes);
        Object.assign(ref, { bytes: bytes.length, sha256: digest(bytes) });
        item.evidence = [{ ...ref }];
    }
    return {
        receipt,
        expected,
        files,
        values,
        change,
        read: async (file) => Buffer.from(files.get(file)),
    };
}

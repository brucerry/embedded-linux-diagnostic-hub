// Separate non-shipping build entry. Import has no product/session/listen/timer effects.
import { request, type RequestOptions, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as filesystem from 'node:fs/promises';
import { Session, url as inspectorURL } from 'node:inspector';
import { prepareInstrumentedGateway } from './instrumented-gateway-entry';
import { startInstrumentedGatewayCheck } from '../../scripts/lib/instrumented-gateway-check.mjs';
import { startInstrumentedInspectorCompatibility } from '../../scripts/lib/instrumented-gateway-compatibility.mjs';
import { activateOwnedInstrumentedGatewayChild, INSTRUMENTED_CHILD_INPUT_LIMIT } from '../../scripts/lib/instrumented-gateway-child.mjs';
import { createOwnedWebFiles } from '../../scripts/lib/owned-web-files.mjs';
import { readStableArtifactFile } from '../../scripts/lib/web-archive-producer.mjs';
import { startInstrumentedChildOutput } from '../../scripts/lib/instrumented-gateway-output.mjs';
import { sourceDigest } from '../../scripts/lib/committed-source-bridge.mjs';

/** The containing, separately admitted child controller supplies the copied, prelaunch byte binding.
 * This exported function has no CLI, environment reader, process launcher or automatic activation.
 */
export function runPreparedInstrumentedGatewayCheck(prepared: Parameters<typeof startInstrumentedGatewayCheck>[0], token: string) {
    return startInstrumentedGatewayCheck(prepared, token, {
        prepare: prepareInstrumentedGateway,
        request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => request(options, callback),
        setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
        clearTimer: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); },
        now: () => performance.now(),
    });
}

/** Replay the exact CJS bytes through a private in-process Inspector before any Gateway factory. */
export function runPreparedInstrumentedGatewayCompatibility(prepared: Parameters<typeof startInstrumentedInspectorCompatibility>[0]) {
    assert.equal(inspectorURL(), undefined, 'An existing debug endpoint is unsupported.');
    return startInstrumentedInspectorCompatibility(prepared, {
        sessionFactory: () => new Session(),
        setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
        clearTimer: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); },
        now: () => performance.now(),
    });
}

/** Explicit activation only from the exact separate activate.cjs file, never on import. No spawn,
 * external debug endpoint, process signal, forced exit, deletion or automatic retry exists here.
 */
export function activateInstrumentedGatewayChildFromFile(inputPath: string, guard: { assertActive(root:string):void; prepareClose(root:string,allowFailure:boolean):unknown; assertClosePrepared(root:string,allowFailure:boolean):void; snapshot():unknown }) {
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
    assert.equal(process.version, 'v24.22.0'); assert.deepEqual(process.execArgv, []);
    assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
    assert.equal(inspectorURL(), undefined);
    const root = path.posix.dirname(inputPath) + '/instrumented';
    const owned = createOwnedWebFiles(filesystem);
    return activateOwnedInstrumentedGatewayChild(inputPath, {
        root, uid: process.getuid!(), filesystem: owned.filesystem,
        assertContainment: () => guard.assertActive(root),
        prepareContainmentClose: (allowFailure:boolean) => guard.prepareClose(root,allowFailure),
        assertContainmentClose: (allowFailure:boolean) => guard.assertClosePrepared(root,allowFailure),
        containmentSnapshot: () => guard.snapshot(),
        readInput: async (file: string, maximum: number) => {
            assert.equal(maximum, INSTRUMENTED_CHILD_INPUT_LIMIT);
            return (await readStableArtifactFile(path.dirname(file), path.basename(file), maximum, owned.filesystem)).bytes;
        },
        observeNode: async () => {
            assert.equal(await owned.filesystem.realpath(process.execPath), process.execPath);
            const bytes = (await readStableArtifactFile(path.dirname(process.execPath), path.basename(process.execPath), 128 * 1024 ** 2, owned.filesystem)).bytes;
            return { path: process.execPath, sha256: sourceDigest(bytes), version: process.version, execArgv: [...process.execArgv], nodeOptions: null };
        },
        startHold: () => setInterval(() => {}, 1000),
        clearHold: (timer: ReturnType<typeof setInterval>) => { clearInterval(timer); },
        runOwnership: runPreparedInstrumentedGatewayCheck,
        runCompatibility: runPreparedInstrumentedGatewayCompatibility,
        writeOutput: (bytes: Buffer) => startInstrumentedChildOutput(bytes, process.stdout, () => { process.exitCode = 1; }),
        assertFilesSettled: () => { owned.owner.assertSettled(); },
        setExitCode: (code: number) => { process.exitCode = code; },
    });
}

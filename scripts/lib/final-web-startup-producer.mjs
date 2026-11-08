import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    parseWebArchiveBuildRecord,
    parseLocalWebArchiveBuildRecord,
    readStableArtifactFile,
} from './web-archive-producer.mjs';
import { inspectInnerArchive } from './inner-archive-inspection.mjs';
import {
    createFinalWebHost,
    observeFinalWebStartup,
    createLocalWebHost,
    observeLocalWebStartup,
} from './final-web-runtime.mjs';
import {
    validateFinalWebStartupObservation,
    validateLocalWebStartupObservation,
} from './final-web-startup-evidence.mjs';

const retained = new Set(),
    admittedPages = new WeakSet();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const limit = 1024 ** 2;
function selectedEngine(value) {
    assert.ok(['chromium', 'firefox', 'webkit'].includes(value), 'Unsupported final-web engine.');
    return value;
}
function keys(value, names) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
function canonicalJSON(bytes, cap) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= cap);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    assert.equal(text, JSON.stringify(value) + '\n', 'Canonical evidence bytes required.');
    return value;
}
/** Validate the actual ZIP/sidecar/build record before any host allocation or page action.
 * The caller supplies its selection independently; this check does not authenticate that selection.
 */
export function inspectFinalWebStartupInput(input) {
    return inspectInput(input, false);
}
export function inspectLocalWebStartupInput(input) {
    return inspectInput(input, true);
}
function inspectInput(input, local) {
    keys(input, ['archiveBytes', 'buildRecordBytes', 'checksumBytes', 'context', 'observer']);
    for (const [key, cap] of [
        ['archiveBytes', 128 * 1024 ** 2],
        ['buildRecordBytes', 16 * 1024 ** 2],
        ['checksumBytes', 1024],
    ])
        assert.ok(Buffer.isBuffer(input[key]) && input[key].length > 0 && input[key].length <= cap);
    const context = structuredClone(input.context),
        observer = structuredClone(input.observer);
    keys(
        observer,
        local
            ? ['diagnosticId', 'toolingCommit']
            : ['runId', 'runAttempt', 'jobId', 'toolingCommit'],
    );
    if (local) {
        assert.match(observer.diagnosticId, /^[a-f0-9]{32}$/);
        assert.equal(observer.diagnosticId, context.diagnosticId);
    } else
        for (const key of ['runId', 'runAttempt', 'jobId'])
            assert.match(observer[key], /^[1-9][0-9]{0,31}$/);
    assert.match(observer.toolingCommit, /^[a-f0-9]{40}$/);
    const record = (local ? parseLocalWebArchiveBuildRecord : parseWebArchiveBuildRecord)(
        input.buildRecordBytes,
        context,
    );
    assert.ok(
        input.checksumBytes.equals(
            Buffer.from(record.archive.sha256 + '  ' + record.archive.name + '\n'),
        ),
    );
    assert.equal(hash(input.checksumBytes), record.checksum.sha256);
    inspectInnerArchive(input.archiveBytes, record, 'web');
    const digest = createHash('sha256');
    for (const bytes of [
        Buffer.from(JSON.stringify({ context, observer })),
        input.buildRecordBytes,
        input.archiveBytes,
        input.checksumBytes,
    ])
        digest.update(String(bytes.length) + ':').update(bytes);
    return { record, context, observer, fingerprint: digest.digest('hex') };
}
/** Existing stable descriptor reader, explicit IO, fixed names and bounded reads only. No download/build. */
export async function readFinalWebStartupInput(root, selectionFile, filesystem) {
    return readInput(root, selectionFile, filesystem, false);
}
export async function readLocalWebStartupInput(root, selectionFile, filesystem) {
    return readInput(root, selectionFile, filesystem, true);
}
async function readInput(root, selectionFile, filesystem, local) {
    assert.ok(path.isAbsolute(root));
    assert.equal(await filesystem.realpath(root), root);
    assert.match(
        selectionFile,
        local
            ? /^validation\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/)?local-web-startup-selection\.json$/
            : /^validation\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/)?web-startup-selection\.json$/,
    );
    const bytes = (await readStableArtifactFile(root, selectionFile, 16 * 1024, filesystem)).bytes;
    const selected = canonicalJSON(bytes, 16 * 1024);
    keys(selected, ['artifactDirectory', 'context', 'observer']);
    assert.match(
        selected.artifactDirectory,
        local
            ? /^validation\/local-web-[A-Za-z0-9][A-Za-z0-9_-]{0,89}$/
            : /^validation\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/,
    );
    const directory = path.join(root, selected.artifactDirectory);
    assert.equal(await filesystem.realpath(directory), directory);
    // Validate the version before deriving an input filename; the complete context is checked below.
    assert.match(
        selected.context.version,
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/,
    );
    assert.ok(selected.context.version.length <= 160);
    const name = 'Diagnostic-Hub-Web-' + selected.context.version + '.zip';
    const input = {
        context: selected.context,
        observer: selected.observer,
        buildRecordBytes: (
            await readStableArtifactFile(
                directory,
                local ? 'local-web-build.json' : 'web-build.json',
                16 * 1024 ** 2,
                filesystem,
            )
        ).bytes,
        archiveBytes: (await readStableArtifactFile(directory, name, 128 * 1024 ** 2, filesystem))
            .bytes,
        checksumBytes: (await readStableArtifactFile(directory, name + '.sha256', 1024, filesystem))
            .bytes,
    };
    return { input, fingerprint: inspectInput(input, local).fingerprint };
}

export class FinalWebStartupCaseFailure extends Error {
    constructor(errors, owner) {
        super('Final ZIP startup case failed; inspect retained custody before continuing.', {
            cause: errors[0],
        });
        this.errors = Object.freeze([...errors]);
        this.owner = owner;
    }
}
/** A real caller supplies its fresh, already-owned SDK Page. This producer owns only that
 * admitted page and its exact-byte host. The caller continues to own the context/browser/process.
 * No browser launch, hidden hook, process signal, cleanup retry or release success is implied.
 */
export async function produceFinalWebStartupCase(
    raw,
    page,
    hostPorts,
    expectedEngine = 'chromium',
) {
    return produceStartupCase(raw, page, hostPorts, expectedEngine, false);
}
export async function produceLocalWebStartupCase(
    raw,
    page,
    hostPorts,
    expectedEngine = 'chromium',
) {
    return produceStartupCase(raw, page, hostPorts, expectedEngine, true);
}
async function produceStartupCase(raw, page, hostPorts, expectedEngine, local) {
    selectedEngine(expectedEngine);
    const checked = inspectInput(raw, local);
    const input = {
        ...checked,
        archiveBytes: Buffer.from(raw.archiveBytes),
        buildRecordBytes: Buffer.from(raw.buildRecordBytes),
        checksumBytes: Buffer.from(raw.checksumBytes),
    };
    assert.ok(page && !admittedPages.has(page) && page.url() === 'about:blank' && !page.isClosed());
    const browser = page.context().browser();
    assert.equal(
        browser.browserType().name(),
        expectedEngine,
        'SDK engine differs from selection.',
    );
    const version = browser.version();
    const host = (local ? createLocalWebHost : createFinalWebHost)(
        input.archiveBytes,
        input.buildRecordBytes,
        input.context,
        {},
        hostPorts,
    );
    admittedPages.add(page);
    let pageCloseObserved = false,
        pageCloseAcknowledged = false,
        hostCloseAcknowledged = false,
        phase = 'admitted',
        observation;
    const errors = [];
    const owner = Object.freeze({
        page,
        host,
        snapshot: () =>
            Object.freeze({
                phase,
                pageCloseObserved,
                pageCloseAcknowledged,
                hostCloseAcknowledged,
                host: host.snapshot(),
                contextRetirement: 'caller-owned-not-observed',
                browserProcessRetirement: 'caller-owned-not-observed',
            }),
    });
    retained.add(owner);
    try {
        assert.equal(
            page.once('close', () => {
                pageCloseObserved = true;
            }),
            page,
        );
        phase = 'observing';
        await host.listen();
        observation = await (local ? observeLocalWebStartup : observeFinalWebStartup)(
            host,
            page,
            input.observer,
        );
    } catch (error) {
        errors.push(error);
    }
    phase = 'closing';
    try {
        await page.close();
        assert.ok(
            pageCloseObserved && page.isClosed(),
            'Page close event/acknowledgement missing.',
        );
        pageCloseAcknowledged = true;
    } catch (error) {
        errors.push(error);
    }
    try {
        const state = await host.close();
        assert.ok(
            state.listenerClosed && state.sockets === 0 && state.responses === 0 && !state.failure,
            'Host close not acknowledged cleanly.',
        );
        hostCloseAcknowledged = true;
    } catch (error) {
        errors.push(error);
    }
    if (pageCloseAcknowledged && hostCloseAcknowledged) {
        phase = 'retired';
        retained.delete(owner);
    } else phase = 'retirement-unproved';
    if (errors.length) throw new FinalWebStartupCaseFailure(errors, owner);
    try {
        const record = {
            schemaVersion: 1,
            kind: local ? 'local-web-startup-case' : 'final-web-startup-case',
            status: 'observed',
            caseId: (local ? 'local-web-' : 'web-') + expectedEngine + '-startup',
            observation: observation.record,
            observationSHA256: observation.sha256,
            retirement: {
                pageCloseEvent: true,
                pageCloseAcknowledged: true,
                hostListenerClosed: true,
                sockets: 0,
                responses: 0,
                contextRetirement: null,
                browserProcessRetirement: null,
            },
            releaseAcceptance: false,
        };
        const bytes = Buffer.from(JSON.stringify(record) + '\n');
        verifyStartupCase(
            bytes,
            {
                archiveBytes: input.archiveBytes,
                buildRecordBytes: input.buildRecordBytes,
                checksumBytes: input.checksumBytes,
                context: input.context,
                observer: input.observer,
            },
            version,
            expectedEngine,
            local,
        );
        return Object.freeze({ record: structuredClone(record), bytes, sha256: hash(bytes) });
    } catch (error) {
        throw new FinalWebStartupCaseFailure([error], owner);
    }
}
/** Consume exact retained case bytes against independently selected inputs and the SDK version.
 * Component consistency only: terminal runner results, service provenance, browser executable,
 * whole-process retirement and the full-product policies/measurements remain separate gates.
 */
export function verifyFinalWebStartupCase(
    bytes,
    input,
    browserVersion,
    expectedEngine = 'chromium',
) {
    return verifyStartupCase(bytes, input, browserVersion, expectedEngine, false);
}
export function verifyLocalWebStartupCase(
    bytes,
    input,
    browserVersion,
    expectedEngine = 'chromium',
) {
    return verifyStartupCase(bytes, input, browserVersion, expectedEngine, true);
}
function verifyStartupCase(bytes, input, browserVersion, expectedEngine, local) {
    selectedEngine(expectedEngine);
    const checked = inspectInput(input, local),
        value = canonicalJSON(bytes, limit);
    keys(value, [
        'schemaVersion',
        'kind',
        'status',
        'caseId',
        'observation',
        'observationSHA256',
        'retirement',
        'releaseAcceptance',
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.kind, local ? 'local-web-startup-case' : 'final-web-startup-case');
    assert.equal(value.status, 'observed');
    assert.equal(value.caseId, (local ? 'local-web-' : 'web-') + expectedEngine + '-startup');
    assert.equal(value.releaseAcceptance, false);
    assert.deepEqual(value.retirement, {
        pageCloseEvent: true,
        pageCloseAcknowledged: true,
        hostListenerClosed: true,
        sockets: 0,
        responses: 0,
        contextRetirement: null,
        browserProcessRetirement: null,
    });
    const o = value.observation;
    keys(o, [
        'schemaVersion',
        'kind',
        'scope',
        'observationProfile',
        'selectedSource',
        'archive',
        'observer',
        'host',
        'observations',
        'executableIdentity',
        'gatewayRuntime',
        'productOwnership',
        'processRetirement',
        'reviewedPolicy',
        'normalGC',
        'forcedGC',
        'releaseAcceptance',
    ]);
    assert.equal(o.schemaVersion, 2);
    assert.equal(o.kind, local ? 'local-web-runtime-observation' : 'final-web-runtime-observation');
    assert.equal(o.scope, local ? 'local-public-ui-startup' : 'public-ui-startup');
    assert.equal(value.observationSHA256, hash(Buffer.from(JSON.stringify(o) + '\n')));
    assert.deepEqual(o.selectedSource, {
        commit: checked.context.sourceCommit,
        tree: checked.context.sourceTree,
        version: checked.context.version,
        buildRecordSHA256: hash(input.buildRecordBytes),
    });
    assert.deepEqual(o.archive, checked.record.archive);
    assert.ok(
        typeof browserVersion === 'string' &&
            browserVersion.length > 0 &&
            browserVersion.length <= 256,
    );
    assert.deepEqual(o.observer, {
        ...checked.observer,
        engineReported: expectedEngine,
        browserVersionReported: browserVersion,
    });
    for (const field of [
        'executableIdentity',
        'gatewayRuntime',
        'productOwnership',
        'processRetirement',
        'reviewedPolicy',
        'normalGC',
        'forcedGC',
    ])
        assert.equal(o[field], null);
    assert.equal(o.releaseAcceptance, false);
    assert.deepEqual(o.observationProfile, {
        maxResponseBytes: 256 * 1024 ** 2,
        maxResponses: 4096,
    });
    keys(o.host, ['origin', 'prefix', 'hostOwner']);
    assert.match(o.host.origin, /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/);
    assert.ok(Number(o.host.origin.split(':').at(-1)) <= 65535);
    assert.equal(o.host.prefix, '/artifact/');
    assert.match(o.host.hostOwner, /^[a-f0-9]{64}$/);
    // The emitter and retained reader share one strict resource schema, including repeated
    // response counts and exact count/byte totals. Keep this case's narrower pins above.
    (local ? validateLocalWebStartupObservation : validateFinalWebStartupObservation)(
        o,
        checked.record,
        {
            ...checked.context,
            ...checked.observer,
            engine: expectedEngine,
            browserVersion,
            buildRecordSHA256: hash(input.buildRecordBytes),
        },
    );
    return Object.freeze({
        status: local ? 'local-artifact-bound-startup-only' : 'artifact-bound-startup-only',
        source: structuredClone(o.selectedSource),
        archive: structuredClone(o.archive),
        releaseAcceptance: false,
    });
}

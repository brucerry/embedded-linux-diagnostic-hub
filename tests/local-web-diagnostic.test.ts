import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import {
    produceLocalWebArchive,
    parseLocalWebArchiveBuildRecord,
    parseWebArchiveBuildRecord,
    validateLocalWebArchiveBuildRecord,
    validateWebArchiveBuildRecord,
} from '../scripts/lib/web-archive-producer.mjs';
import {
    createLocalWebHost,
    createFinalWebHost,
    observeFinalWebStartup,
    observeLocalWebStartup,
} from '../scripts/lib/final-web-runtime.mjs';
import {
    inspectLocalWebStartupInput,
    inspectFinalWebStartupInput,
    produceLocalWebStartupCase,
    verifyLocalWebStartupCase,
    verifyFinalWebStartupCase,
    readLocalWebStartupInput,
} from '../scripts/lib/final-web-startup-producer.mjs';
import {
    validateLocalWebStartupObservation,
    validateFinalWebStartupObservation,
} from '../scripts/lib/final-web-startup-evidence.mjs';
import { readbackFixture } from './fixtures/archive-readback-memory';
import { memoryFilesystem } from './fixtures/gateway-producer-memory';
import {
    localArchiveFixture,
    localStartupFixture,
    acknowledgedGate,
} from './fixtures/local-web-startup-memory';

test('local archive producer binds real codec bytes, source and owned build facts without service IDs', async () => {
    const f = localArchiveFixture();
    const record = await produceLocalWebArchive(f.context, f.source.provider, f.io);
    assert.equal(record.kind, 'local-web-source-build-archive');
    assert.equal(record.context.scope, 'local-web-diagnostic');
    assert.deepEqual(Object.keys(record.context).sort(), [
        'diagnosticId',
        'scope',
        'sourceCommit',
        'sourceTree',
        'version',
    ]);
    assert.equal(record.serviceProvenance, null);
    assert.equal(record.releaseAcceptance, false);
    assert.equal(f.files.has('web-build.json'), false);
    assert.equal(record.build.custody.childClose, true);
    assert.equal(record.build.custody.descendantRetirement, 'not-observed');
    const bytes = f.files.get('local-web-build.json')!;
    assert.deepEqual(parseLocalWebArchiveBuildRecord(bytes, f.context), record);
    assert.equal(sourceDigest(f.files.get(record.archive.name)!), record.archive.sha256);
    const strictContext = {
        scope: 'web',
        version: f.context.version,
        sourceCommit: f.context.sourceCommit,
        sourceTree: f.context.sourceTree,
        runId: '123',
        runAttempt: '1',
        jobKey: 'web_archive',
    };
    assert.throws(() => parseWebArchiveBuildRecord(bytes, strictContext));
    assert.throws(() => validateWebArchiveBuildRecord(record, strictContext));
});

for (const field of ['runId', 'runAttempt', 'jobKey', 'jobId']) {
    test('local context rejects injected service field ' + field + ' before IO', async () => {
        const f = localArchiveFixture();
        await assert.rejects(produceLocalWebArchive({ ...f.context, [field]: '123' }, {}, {}));
        assert.equal(f.files.size, 0);
    });
}
for (const change of ['source', 'command', 'exit', 'pipe', 'checksum-write', 'record-write']) {
    test('local archive cannot emit a completed record after ' + change + ' failure', async () => {
        const f = localArchiveFixture();
        if (change === 'source')
            f.source.files.set('package.json', Buffer.from('{"version":"0.6.1"}'));
        else if (change === 'checksum-write')
            f.io.writeChecksum = async () => {
                throw Error('synthetic write failure');
            };
        else if (change === 'record-write')
            f.io.writeRecord = async () => ({
                name: 'web-build.json',
                bytes: 1,
                sha256: '0'.repeat(64),
            });
        else {
            const original = f.io.build;
            f.io.build = async () => {
                const value = await original();
                if (change === 'command') value.command[5] = '--serve';
                if (change === 'exit') value.exitCode = 1;
                if (change === 'pipe') value.custody.stdout.closed = false;
                return value;
            };
        }
        await assert.rejects(produceLocalWebArchive(f.context, f.source.provider, f.io));
        assert.equal(f.files.has('local-web-build.json'), false);
    });
}

test('local reader rejects service archive records and qualification relabeling', async () => {
    const strict = await readbackFixture('web'),
        f = localArchiveFixture();
    assert.throws(() =>
        parseLocalWebArchiveBuildRecord(strict.files.get('web-build.json'), f.context),
    );
    const local = await produceLocalWebArchive(f.context, f.source.provider, f.io);
    assert.throws(() =>
        validateLocalWebArchiveBuildRecord({ ...local, releaseAcceptance: true }, f.context),
    );
    assert.throws(() =>
        validateLocalWebArchiveBuildRecord(
            { ...local, serviceProvenance: { authenticated: true } },
            f.context,
        ),
    );
});

for (const engine of ['chromium', 'firefox', 'webkit']) {
    test(
        'local ' +
            engine +
            ' startup uses actual archive host/observer and acknowledged page/host joins',
        async () => {
            const f = await localStartupFixture();
            f.controls.engine = engine;
            const result = await produceLocalWebStartupCase(f.input, f.page, f.ports, engine);
            assert.equal(result.record.kind, 'local-web-startup-case');
            assert.equal(result.record.caseId, 'local-web-' + engine + '-startup');
            assert.equal(result.record.observation.kind, 'local-web-runtime-observation');
            assert.equal(result.record.observation.scope, 'local-public-ui-startup');
            assert.equal(result.record.observation.observer.diagnosticId, f.context.diagnosticId);
            assert.equal(result.record.observation.observations.resources.length, 2);
            assert.equal(result.record.retirement.pageCloseAcknowledged, true);
            assert.equal(result.record.retirement.hostListenerClosed, true);
            assert.equal(result.record.retirement.browserProcessRetirement, null);
            assert.equal(result.record.observation.executableIdentity, null);
            assert.equal(result.record.releaseAcceptance, false);
            assert.equal(f.controls.pageCloses, 1);
            assert.equal(f.controls.closes, 1);
            assert.equal(
                verifyLocalWebStartupCase(result.bytes, f.input, 'synthetic-sdk-version', engine)
                    .status,
                'local-artifact-bound-startup-only',
            );
            assert.throws(() => inspectFinalWebStartupInput(f.input));
            assert.throws(() =>
                verifyFinalWebStartupCase(result.bytes, f.input, 'synthetic-sdk-version', engine),
            );
            assert.throws(() =>
                validateFinalWebStartupObservation(result.record.observation, f.record, {}),
            );
        },
    );
}

test('issued local and service hosts cannot cross observer modes before any listen or page action', async () => {
    const f = await localStartupFixture(),
        strict = await readbackFixture('web');
    const localHost = createLocalWebHost(
        f.input.archiveBytes,
        f.input.buildRecordBytes,
        f.context,
        {},
        f.ports,
    );
    await assert.rejects(
        observeFinalWebStartup(localHost, f.page, {
            runId: '1',
            runAttempt: '1',
            jobId: '1',
            toolingCommit: 'c'.repeat(40),
        }),
    );
    await localHost.close();
    const serviceHost = createFinalWebHost(
        strict.files.get(strict.record.archive.name),
        strict.files.get('web-build.json'),
        strict.selection.context,
        {},
        f.ports,
    );
    await assert.rejects(observeLocalWebStartup(serviceHost, f.page, f.input.observer));
    await serviceHost.close();
    assert.equal(f.controls.creates, 0);
    assert.equal(f.page.url(), 'about:blank');
});

for (const change of ['archive', 'checksum', 'record', 'observer', 'service-id']) {
    test('local startup rejects changed ' + change + ' input before host creation', async () => {
        const f = await localStartupFixture(),
            input: any = { ...f.input, observer: { ...f.input.observer } };
        if (change === 'archive') {
            input.archiveBytes = Buffer.from(input.archiveBytes);
            input.archiveBytes[0] ^= 1;
        }
        if (change === 'checksum') input.checksumBytes = Buffer.from('not the archive checksum\n');
        if (change === 'record') input.buildRecordBytes = Buffer.from('{}\n');
        if (change === 'observer') input.observer.diagnosticId = 'b'.repeat(32);
        if (change === 'service-id') input.observer.runId = '1';
        await assert.rejects(produceLocalWebStartupCase(input, f.page, f.ports));
        assert.equal(f.controls.creates, 0);
        assert.equal(f.controls.pageCloses, 0);
    });
}
for (const failure of [
    'primary',
    'pageError',
    'drift',
    'failedRequest',
    'omitCloseEvent',
    'pageCloseError',
    'hostCloseError',
]) {
    test(
        'local startup preserves ' + failure + ' failure and attempts only owned closure once',
        async () => {
            const f = await localStartupFixture();
            f.controls[failure] =
                failure === 'primary' || (failure.endsWith('Error') && failure !== 'pageError')
                    ? Error('synthetic failure')
                    : true;
            await assert.rejects(produceLocalWebStartupCase(f.input, f.page, f.ports));
            assert.equal(f.controls.pageCloses, 1);
            assert.equal(f.controls.closes, 1);
        },
    );
}

test('local success remains pending until page and then host close acknowledge', async () => {
    const f = await localStartupFixture(),
        page = acknowledgedGate(),
        host = acknowledgedGate();
    f.controls.pageCloseGate = page;
    f.controls.hostCloseGate = host;
    let settled = false;
    const result = produceLocalWebStartupCase(f.input, f.page, f.ports).finally(() => {
        settled = true;
    });
    await page.entered;
    assert.equal(settled, false);
    assert.equal(f.controls.closes, 0);
    page.release();
    await host.entered;
    assert.equal(settled, false);
    host.release();
    assert.equal((await result).record.releaseAcceptance, false);
});

test('local selection uses a separate filename and bounded stable local record reads', async () => {
    const f = await localStartupFixture(),
        fs = memoryFilesystem();
    fs.directory('/project/validation/local-web-test');
    for (const [name, bytes] of f.files)
        fs.write('/project/validation/local-web-test/' + name, bytes);
    const selected = {
        artifactDirectory: 'validation/local-web-test',
        context: f.context,
        observer: f.input.observer,
    };
    fs.write(
        '/project/validation/local-web-startup-selection.json',
        Buffer.from(JSON.stringify(selected) + '\n'),
    );
    const loaded = await readLocalWebStartupInput(
        '/project',
        'validation/local-web-startup-selection.json',
        fs.fs,
    );
    assert.equal(loaded.fingerprint, inspectLocalWebStartupInput(f.input).fingerprint);
    await assert.rejects(
        readLocalWebStartupInput('/project', 'validation/web-startup-selection.json', fs.fs),
    );
});

for (const change of [
    'kind',
    'scope',
    'engine',
    'source',
    'response',
    'lifecycle',
    'qualification',
    'policy',
]) {
    test('local semantic reader rejects rehashed ' + change + ' substitution', async () => {
        const f = await localStartupFixture(),
            out = await produceLocalWebStartupCase(f.input, f.page, f.ports);
        const value: any = structuredClone(out.record),
            o = value.observation;
        if (change === 'kind') value.kind = 'final-web-startup-case';
        if (change === 'scope') o.scope = 'public-ui-startup';
        if (change === 'engine') o.observer.engineReported = 'firefox';
        if (change === 'source') o.selectedSource.commit = '0'.repeat(40);
        if (change === 'response') o.observations.responseObjectsRead++;
        if (change === 'lifecycle') o.observations.pageState.crashes = 1;
        if (change === 'qualification') value.releaseAcceptance = true;
        if (change === 'policy') o.reviewedPolicy = { passed: true };
        value.observationSHA256 = sourceDigest(Buffer.from(JSON.stringify(o) + '\n'));
        assert.throws(() =>
            verifyLocalWebStartupCase(
                Buffer.from(JSON.stringify(value) + '\n'),
                f.input,
                'synthetic-sdk-version',
            ),
        );
        if (change === 'response' || change === 'lifecycle' || change === 'policy')
            assert.throws(() =>
                validateLocalWebStartupObservation(o, f.record, {
                    ...f.context,
                    ...f.input.observer,
                    engine: 'chromium',
                    browserVersion: 'synthetic-sdk-version',
                    buildRecordSHA256: sourceDigest(f.input.buildRecordBytes),
                }),
            );
    });
}

for (const input of [[], ['--scope=local-web-diagnostic']]) {
    test(
        'local file driver refuses absent execution capability before any IO: ' + input.length,
        async () => {
            const { mainLocal } = await import('../scripts/produce-web-archive.mjs');
            await assert.rejects(
                mainLocal(input, undefined),
                /Default producer execution held: source-owned Git\/file\/environment capabilities required/,
            );
        },
    );
}

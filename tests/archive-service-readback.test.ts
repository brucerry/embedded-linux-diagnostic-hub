import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { sourceDigest } from '../scripts/lib/committed-source-bridge.mjs';
import { carrierCRC32, inspectArtifactCarrier } from '../scripts/lib/artifact-carrier-zip.mjs';
import { parseGatewayArchiveBuildRecord } from '../scripts/lib/gateway-build-record.mjs';
import {
    observeArchiveReadback,
    validateArchiveReadbackSelection,
    projectGitHubArchiveServiceObservation,
    archiveReadbackSnapshot,
    requireArchiveReleaseProvenance,
    ArchiveReadbackFailure,
} from '../scripts/lib/archive-service-readback.mjs';
import { readbackFixture, carrier } from './fixtures/archive-readback-memory';

async function tickUntil(predicate: () => boolean) {
    for (let i = 0; i < 5000 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate());
}
for (const scope of ['web', 'gateway'] as const)
    test(scope + ' exact carrier/source/build correlation stays unqualified', async () => {
        const f = await readbackFixture(scope),
            capability = await observeArchiveReadback(f.selection, f.ports),
            facts = archiveReadbackSnapshot(capability);
        assert.equal(facts.status, 'correlated-unqualified');
        assert.equal(facts.selection.context.scope, scope);
        assert.equal(facts.carrier.sha256, sourceDigest(f.encoded));
        assert.equal(facts.archive.sha256, f.record.archive.sha256);
        assert.equal(facts.record.sha256, sourceDigest(f.files.get(scope + '-build.json')));
        assert.equal(f.active.size, 0);
        assert.equal(f.services, 2);
        assert.deepEqual(f.events, [
            'open:service',
            'close:service',
            'open:artifact',
            'close:artifact',
            'open:service',
            'close:service',
        ]);
        for (const key of [
            'serviceAuthentication',
            'artifactJobAttribution',
            'workflowJobKeyAssociation',
            'innerArchiveInspection',
            'readerTerminalStatus',
            'productRuntime',
        ])
            assert.equal(facts[key], null);
        assert.equal(facts.releaseAcceptance, false);
        assert.throws(() => requireArchiveReleaseProvenance(capability), /release remains blocked/);
        facts.serviceAuthentication = { verified: true };
        facts.releaseAcceptance = true;
        assert.equal(archiveReadbackSnapshot(capability).releaseAcceptance, false);
        assert.throws(() => archiveReadbackSnapshot({ ...capability }), /Unissued/);
    });

test('canonical Gateway parser rejects custody/command/inventory mutations and noncanonical records', async () => {
    const f = await readbackFixture();
    assert.deepEqual(
        parseGatewayArchiveBuildRecord(f.files.get('gateway-build.json'), f.selection.context),
        f.record,
    );
    for (const mutate of [
        (v: any) => {
            v.lockPreparation.owner = 'f'.repeat(32);
        },
        (v: any) => {
            v.build.lifecycle.pid = null;
        },
        (v: any) => {
            v.lockPreparation.id = v.build.id;
        },
        (v: any) => {
            v.builder.esbuildEntryFormat = 'native-executable';
        },
        (v: any) => {
            v.tarInventory.expandedBytes += 512;
        },
        (v: any) => {
            v.preparedLockSHA256 = 'f'.repeat(64);
        },
        (v: any) => {
            v.context.runAttempt = '2';
        },
        (v: any) => {
            v.retirement = { status: 'passed' };
        },
        (v: any) => {
            v.lockPreparation.command.push('--online');
        },
        (v: any) => {
            v.stage.ownerCompletion = 'retired';
        },
    ]) {
        const v = structuredClone(f.record);
        mutate(v);
        assert.throws(() =>
            parseGatewayArchiveBuildRecord(
                Buffer.from(JSON.stringify(v) + '\n'),
                f.selection.context,
            ),
        );
    }
    const text = f.files.get('gateway-build.json')!.toString();
    for (const bytes of [
        Buffer.from('\ufeff' + text),
        Buffer.from('{"schemaVersion":1,' + text.slice(1)),
        Buffer.from(text + ' '),
        Buffer.from([0xff]),
    ])
        assert.throws(() => parseGatewayArchiveBuildRecord(bytes, f.selection.context));
});

test('service run/job/artifact substitutions and false terminal labels refuse before artifact admission', async () => {
    for (const mutate of [
        (v: any) => {
            v.run.attempt = '2';
        },
        (v: any) => {
            v.run.id = '124';
        },
        (v: any) => {
            v.run.headSHA = 'f'.repeat(40);
        },
        (v: any) => {
            v.job.id = '701';
        },
        (v: any) => {
            v.job.runAttempt = '2';
        },
        (v: any) => {
            v.job.conclusion = 'failure';
        },
        (v: any) => {
            v.job.status = 'in_progress';
        },
        (v: any) => {
            v.artifact.id = '601';
        },
        (v: any) => {
            v.artifact.expired = true;
        },
        (v: any) => {
            v.artifact.runId = '124';
        },
        (v: any) => {
            v.artifact.digest = null;
        },
        (v: any) => {
            v.artifact.jobId = '700';
        },
        (v: any) => {
            v.job.name = 'other';
        },
        (v: any) => {
            v.run.workflowPath = '.github/workflows/other.yml';
        },
    ]) {
        const f = await readbackFixture();
        f.controls.before = mutate;
        await assert.rejects(observeArchiveReadback(f.selection, f.ports));
        assert.ok(!f.events.includes('open:artifact'));
        assert.equal(f.active.size, 0);
    }
});

test('selected artifact digest and changed post-read service metadata cannot issue evidence', async () => {
    for (const mode of ['digest', 'post-change']) {
        const f = await readbackFixture();
        if (mode === 'digest')
            f.controls.before = (v: any) => {
                v.artifact.digest = 'sha256:' + 'f'.repeat(64);
            };
        else
            f.controls.after = (v: any) => {
                v.artifact.digest = 'sha256:' + 'f'.repeat(64);
            };
        await assert.rejects(observeArchiveReadback(f.selection, f.ports));
        assert.equal(f.active.size, 0);
    }
});

test('honestly rehashed archive/sidecar/record tampering does not substitute producer facts', async () => {
    for (const mode of ['archive', 'sidecar', 'record']) {
        const f = await readbackFixture();
        const name =
            mode === 'archive'
                ? f.record.archive.name
                : mode === 'sidecar'
                  ? f.record.checksum.name
                  : 'gateway-build.json';
        f.files.set(name, Buffer.from('changed bytes'));
        f.repack();
        await assert.rejects(observeArchiveReadback(f.selection, f.ports));
        assert.equal(f.active.size, 0);
    }
});

test('carrier supports stored ZIP and stored DEFLATE with acknowledged data descriptors', async () => {
    assert.equal(carrierCRC32(Buffer.from('123456789')), 0xcbf43926);
    const f = await readbackFixture();
    f.repack(true, true);
    const capability = await observeArchiveReadback(f.selection, f.ports);
    assert.equal(archiveReadbackSnapshot(capability).releaseAcceptance, false);
    assert.equal(f.active.size, 0);
});

test('carrier rejects aliases, extra entries, wrong CRC, overlap and compressed DEFLATE without fallback', async () => {
    const f = await readbackFixture(),
        expected = new Map([...f.files].map(([name]) => [name, 128 * 1024 ** 2]));
    for (const mode of [
        'traversal',
        'high-bit-name',
        'extra',
        'crc',
        'overlap',
        'link',
        'reparse',
        'deflate',
    ]) {
        let bytes: Buffer;
        if (mode === 'traversal') {
            const files = new Map(f.files);
            const first = [...files.keys()][0];
            const data = files.get(first)!;
            files.delete(first);
            files.set('../escape.txt', data);
            bytes = carrier(files);
        } else if (mode === 'extra')
            bytes = carrier(new Map([...f.files, ['extra.txt', Buffer.from('extra')]]));
        else if (mode === 'deflate')
            bytes = Buffer.from(zipSync(Object.fromEntries(f.files), { level: 6 }));
        else {
            bytes = Buffer.from(f.encoded);
            const end = bytes.length - 22,
                central = bytes.readUInt32LE(end + 16);
            if (mode === 'crc') {
                const length = bytes.readUInt16LE(26);
                bytes[30 + length] ^= 1;
            }
            if (mode === 'overlap') {
                const second = central + 46 + bytes.readUInt16LE(central + 28);
                bytes.writeUInt32LE(0, second + 42);
            }
            if (mode === 'link') bytes.writeUInt32LE((0o120777 * 65536) >>> 0, central + 38);
            if (mode === 'reparse') bytes.writeUInt32LE(0x400, central + 38);
            if (mode === 'high-bit-name') {
                bytes[30] |= 0x80;
                bytes[central + 46] |= 0x80;
            }
        }
        assert.throws(() => inspectArtifactCarrier(bytes, expected), mode);
    }
});

test('held response close prevents artifact admission and evidence until actual acknowledgement', async () => {
    const f = await readbackFixture();
    f.controls.holdCloseKind = 'service';
    let done = false;
    const task = observeArchiveReadback(f.selection, f.ports).then((v) => {
        done = true;
        return v;
    });
    await tickUntil(() => !!f.controls.releaseClose);
    assert.equal(done, false);
    assert.equal(f.active.size, 1);
    assert.ok(!f.events.includes('open:artifact'));
    f.controls.holdCloseKind = null;
    f.controls.releaseClose();
    await task;
    assert.equal(done, true);
    assert.equal(f.active.size, 0);
});

test('read failure plus rejected close preserves primary error and actual response custody', async () => {
    const f = await readbackFixture();
    const primary = Error('synthetic read failure'),
        cleanup = Error('synthetic close failure');
    Object.assign(f.controls, {
        readErrorKind: 'artifact',
        primary,
        closeErrorKind: 'artifact',
        cleanup,
    });
    await assert.rejects(observeArchiveReadback(f.selection, f.ports), (error: any) => {
        assert.ok(error instanceof ArchiveReadbackFailure);
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.cause, primary);
        assert.equal(error.cause.errors[1], cleanup);
        assert.deepEqual(
            error.owner.snapshot().pending.map((v: any) => v.state),
            ['close-unproved'],
        );
        return true;
    });
    assert.equal(f.active.size, 1);
    assert.equal(f.services, 1);
    const before = f.events.length;
    await assert.rejects(observeArchiveReadback(f.selection, f.ports), /Reader custody remains/);
    const relabeled = structuredClone(f.selection);
    relabeled.reader.runId = '999';
    relabeled.reader.runAttempt = '2';
    await assert.rejects(observeArchiveReadback(relabeled, f.ports), /Reader custody remains/);
    assert.equal(f.events.length, before);
});

test('stale response cannot retire a fresh reader and identical producer/reader is rejected early', async () => {
    const f = await readbackFixture();
    f.controls.foreignKind = 'artifact';
    await assert.rejects(observeArchiveReadback(f.selection, f.ports), (error: any) => {
        assert.equal(error.owner.snapshot().pending[0].state, 'acquisition-unproved');
        return true;
    });
    assert.equal(f.active.size, 1);
    assert.ok(!f.events.includes('close:artifact'));
    for (const mode of ['identical', 'other-run', 'other-attempt']) {
        const g = await readbackFixture();
        g.selection.reader = {
            runId: mode === 'other-run' ? '999' : g.selection.context.runId,
            runAttempt: mode === 'other-attempt' ? '2' : g.selection.context.runAttempt,
            jobId: g.selection.service.jobId,
            toolingCommit: 'f'.repeat(40),
        };
        await assert.rejects(observeArchiveReadback(g.selection, g.ports), /jobs must be separate/);
        assert.deepEqual(g.events, []);
    }
});

test('actual REST field projection binds repository/run/attempt/job/artifact without inventing upload-job proof', async () => {
    const f = await readbackFixture(),
        normalized = f.observation();
    const raw: any = {
        run: {
            id: 123,
            run_attempt: 1,
            head_sha: normalized.run.headSHA,
            workflow_id: 500,
            path: normalized.run.workflowPath,
            status: 'completed',
            conclusion: 'success',
            repository: { id: 4242, full_name: normalized.repository },
            head_repository: { id: 4242, full_name: normalized.repository },
        },
        job: {
            id: 700,
            run_id: 123,
            run_attempt: 1,
            head_sha: normalized.job.headSHA,
            name: normalized.job.name,
            status: 'completed',
            conclusion: 'success',
        },
        artifact: {
            id: 600,
            name: normalized.artifact.name,
            size_in_bytes: normalized.artifact.sizeInBytes,
            digest: normalized.artifact.digest,
            expired: false,
            workflow_run: {
                id: 123,
                head_sha: normalized.artifact.headSHA,
                repository_id: 4242,
                head_repository_id: 4242,
            },
        },
    };
    assert.deepEqual(projectGitHubArchiveServiceObservation(raw, f.selection), normalized);
    for (const mutate of [
        (v: any) => {
            v.run.id = Number.MAX_SAFE_INTEGER + 1;
        },
        (v: any) => {
            v.artifact.workflow_run.repository_id = 4243;
        },
        (v: any) => {
            v.job.run_attempt = 2;
        },
        (v: any) => {
            delete v.artifact.digest;
        },
    ]) {
        const changed = structuredClone(raw);
        mutate(changed);
        assert.throws(() => projectGitHubArchiveServiceObservation(changed, f.selection));
    }
    assert.equal(Object.hasOwn(normalized.artifact, 'jobId'), false);
    assert.equal(Object.hasOwn(normalized.artifact, 'runAttempt'), false);
});

test('pending or rejected acquisition keeps reader admission and does not fabricate response retirement', async () => {
    const f = await readbackFixture();
    f.controls.holdOpenKind = 'service';
    let done = false;
    const task = observeArchiveReadback(f.selection, f.ports).then((value) => {
        done = true;
        return value;
    });
    await tickUntil(() => !!f.controls.releaseOpen);
    assert.equal(done, false);
    const count = f.events.length;
    const relabeled = structuredClone(f.selection);
    relabeled.reader.runId = '998';
    await assert.rejects(observeArchiveReadback(relabeled, f.ports), /Reader custody remains/);
    assert.equal(f.events.length, count);
    f.controls.holdOpenKind = null;
    f.controls.releaseOpen();
    await task;
    assert.equal(f.active.size, 0);
    const g = await readbackFixture(),
        primary = Error('synthetic unknown acquisition');
    g.controls.throwOpenKind = 'artifact';
    g.controls.primary = primary;
    await assert.rejects(observeArchiveReadback(g.selection, g.ports), (error: any) => {
        assert.equal(error.cause, primary);
        assert.equal(error.owner.snapshot().pending[0].state, 'acquisition-unproved');
        return true;
    });
    await assert.rejects(observeArchiveReadback(g.selection, g.ports), /Reader custody remains/);
});

test('stored-block metadata must validate before a declared 128 MiB allocation is attempted', async () => {
    const f = await readbackFixture();
    f.repack(true, false);
    const bytes = Buffer.from(f.encoded),
        cap = 128 * 1024 ** 2,
        central = bytes.readUInt32LE(bytes.length - 22 + 16);
    bytes.writeUInt32LE(cap, 22);
    bytes.writeUInt32LE(cap, central + 24);
    const expected = new Map([...f.files.keys()].map((name) => [name, cap])),
        original = Buffer.alloc,
        allocation = Error('forbidden premature allocation');
    let attempted = 0;
    try {
        (Buffer as any).alloc = (size: number, ...args: any[]) => {
            if (size === cap) {
                attempted++;
                throw allocation;
            }
            return (original as any)(size, ...args);
        };
        assert.throws(
            () => inspectArtifactCarrier(bytes, expected),
            (error: any) => error !== allocation,
        );
        assert.equal(attempted, 0);
    } finally {
        (Buffer as any).alloc = original;
    }
});

test('carrier checksum-name boundary is admitted early and oversized selections never open ports', async () => {
    for (const scope of ['web', 'gateway'] as const) {
        const f = await readbackFixture(scope),
            prefix = scope === 'web' ? 'Diagnostic-Hub-Web-' : 'Diagnostic-Hub-Gateway-',
            ext = scope === 'web' ? '.zip' : '.tar.gz',
            maximum = 200 - prefix.length - ext.length - '.sha256'.length;
        const selected = structuredClone(f.selection);
        selected.context.version = '0.6.0-' + 'a'.repeat(maximum - '0.6.0-'.length);
        assert.equal((prefix + selected.context.version + ext + '.sha256').length, 200);
        assert.deepEqual(validateArchiveReadbackSelection(selected), selected);
        selected.context.version += 'a';
        await assert.rejects(observeArchiveReadback(selected, f.ports));
        assert.deepEqual(f.events, []);
    }
});

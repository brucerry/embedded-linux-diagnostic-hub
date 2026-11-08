import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readbackFixture } from './fixtures/archive-readback-memory';
import { memoryFilesystem } from './fixtures/gateway-producer-memory';
import {
    inspectFinalWebStartupInput,
    readFinalWebStartupInput,
    produceFinalWebStartupCase,
    verifyFinalWebStartupCase,
    FinalWebStartupCaseFailure,
} from '../scripts/lib/final-web-startup-producer.mjs';
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const tick = async () => {
    for (let i = 0; i < 32; i++) await Promise.resolve();
};
const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
        release = r;
    });
    return { promise, release };
};
async function fixture() {
    const f = await readbackFixture('web');
    const input = {
        archiveBytes: Buffer.from(f.files.get(f.record.archive.name)!),
        buildRecordBytes: Buffer.from(f.files.get('web-build.json')!),
        checksumBytes: Buffer.from(f.files.get(f.record.checksum.name)!),
        context: structuredClone(f.selection.context),
        observer: { runId: '111', runAttempt: '1', jobId: '222', toolingCommit: 'c'.repeat(40) },
    };
    const controls: any = {
        creates: 0,
        closes: 0,
        pageCloseCalls: 0,
        closeGate: null,
        hostGate: null,
        listenGate: null,
        primary: null,
        pageCloseError: null,
        hostCloseError: null,
        omitCloseEvent: false,
        engine: 'chromium',
        repeatScriptResponse: false,
    };
    const server: any = new EventEmitter();
    let handler: any;
    server.listen = (_port: number, address: string, callback: () => void) => {
        assert.equal(_port, 0);
        assert.equal(address, '127.0.0.1');
        if (controls.listenGate) controls.listenGate.promise.then(callback);
        else callback();
    };
    server.address = () => ({ address: '127.0.0.1', port: 43123 });
    server.close = (callback: (e: unknown) => void) => {
        controls.closes++;
        if (controls.hostGate)
            controls.hostGate.promise.then(() => callback(controls.hostCloseError));
        else callback(controls.hostCloseError);
    };
    const ports = {
        createServer(h: any) {
            controls.creates++;
            handler = h;
            return server;
        },
    };
    const request = (url: string) => {
        const response: any = new EventEmitter();
        response.writeHead = (status: number) => {
            response.status = status;
            return response;
        };
        response.end = (b: Buffer) => {
            response.body = Buffer.from(b ?? '');
            response.emit('close');
        };
        response.destroy = () => response.emit('close');
        handler({ method: 'GET', url }, response);
        return response;
    };
    const page: any = new EventEmitter();
    let closed = false,
        url = 'about:blank';
    page.url = () => url;
    page.isClosed = () => closed;
    page.context = () => ({
        browser: () => ({
            browserType: () => ({ name: () => controls.engine }),
            version: () => 'synthetic-sdk-version',
        }),
    });
    page.getByRole = (_role: string, _options: unknown) => ({ waitFor: async () => {} });
    page.goto = async (target: string) => {
        if (controls.primary) throw controls.primary;
        url = target;
        const document = request('/artifact/');
        const response = {
            status: () => document.status,
            url: () => target,
            body: async () => document.body,
        };
        page.emit('response', response);
        for (let i = 0; i < (controls.repeatScriptResponse ? 2 : 1); i++) {
            const script = request('/artifact/assets/main.js');
            page.emit('response', {
                status: () => script.status,
                url: () => target + 'assets/main.js',
                body: async () => script.body,
            });
        }
        return response;
    };
    page.close = async () => {
        controls.pageCloseCalls++;
        if (controls.closeGate) await controls.closeGate.promise;
        if (controls.pageCloseError) throw controls.pageCloseError;
        closed = true;
        if (!controls.omitCloseEvent) page.emit('close');
    };
    return { input, page, controls, ports, f };
}
test('real producer sequence connects the actual archive host, startup observer and strict case reader', async () => {
    const f = await fixture();
    const result = await produceFinalWebStartupCase(f.input, f.page, f.ports);
    assert.equal(hash(result.bytes), result.sha256);
    const value = verifyFinalWebStartupCase(result.bytes, f.input, 'synthetic-sdk-version');
    assert.equal(value.status, 'artifact-bound-startup-only');
    assert.equal(value.releaseAcceptance, false);
    assert.equal(f.controls.pageCloseCalls, 1);
    assert.equal(f.controls.closes, 1);
    assert.equal(result.record.observation.observations.resources.length, 2);
    assert.equal(result.record.retirement.browserProcessRetirement, null);
});
test('case reader rejects rehashed older observation without current page lifecycle facts', async () => {
    const f = await fixture(),
        out = await produceFinalWebStartupCase(f.input, f.page, f.ports);
    const record: any = structuredClone(out.record);
    assert.equal(record.observation.schemaVersion, 2);
    record.observation.schemaVersion = 1;
    delete record.observation.observations.pageState;
    record.observationSHA256 = hash(Buffer.from(JSON.stringify(record.observation) + '\n'));
    assert.throws(() =>
        verifyFinalWebStartupCase(
            Buffer.from(JSON.stringify(record) + '\n'),
            f.input,
            'synthetic-sdk-version',
        ),
    );
});
for (const engine of ['firefox', 'webkit']) {
    test(
        'explicit ' +
            engine +
            ' producer binds the actual host and observation to its selected engine',
        async () => {
            const f = await fixture();
            f.controls.engine = engine;
            const out = await produceFinalWebStartupCase(f.input, f.page, f.ports, engine);
            assert.equal(out.record.caseId, 'web-' + engine + '-startup');
            assert.equal(out.record.observation.observer.engineReported, engine);
            assert.equal(hash(out.bytes), out.sha256);
            assert.equal(
                verifyFinalWebStartupCase(out.bytes, f.input, 'synthetic-sdk-version', engine)
                    .status,
                'artifact-bound-startup-only',
            );
            // The old Chromium reader remains narrow unless its caller explicitly selects another engine.
            assert.throws(() =>
                verifyFinalWebStartupCase(out.bytes, f.input, 'synthetic-sdk-version'),
            );
            assert.equal(out.record.retirement.browserProcessRetirement, null);
            assert.equal(out.record.observation.reviewedPolicy, null);
            assert.equal(out.record.observation.normalGC, null);
            assert.equal(out.record.observation.forcedGC, null);
            assert.equal(out.record.releaseAcceptance, false);
            assert.equal(f.controls.pageCloseCalls, 1);
            assert.equal(f.controls.closes, 1);
        },
    );
    test(engine + ' reader rejects honestly rehashed engine and case substitutions', async () => {
        const f = await fixture();
        f.controls.engine = engine;
        const out = await produceFinalWebStartupCase(f.input, f.page, f.ports, engine);
        for (const field of ['case', 'reported']) {
            const record = structuredClone(out.record);
            if (field === 'case') record.caseId = 'web-chromium-startup';
            else record.observation.observer.engineReported = 'chromium';
            record.observationSHA256 = hash(Buffer.from(JSON.stringify(record.observation) + '\n'));
            assert.throws(() =>
                verifyFinalWebStartupCase(
                    Buffer.from(JSON.stringify(record) + '\n'),
                    f.input,
                    'synthetic-sdk-version',
                    engine,
                ),
            );
        }
    });
}
test('unknown or unselected SDK engines fail before host allocation and page custody', async () => {
    for (const selection of ['firefox', 'webkit', 'unknown']) {
        const f = await fixture();
        await assert.rejects(produceFinalWebStartupCase(f.input, f.page, f.ports, selection));
        assert.equal(f.controls.creates, 0);
        assert.equal(f.controls.pageCloseCalls, 0);
    }
});
test('case reader accepts actual repeated response emission with exact count and byte totals', async () => {
    const f = await fixture();
    f.controls.repeatScriptResponse = true;
    const result = await produceFinalWebStartupCase(f.input, f.page, f.ports);
    const facts = result.record.observation.observations;
    const script = facts.resources.find((row: any) => row.path === 'assets/main.js');
    const document = facts.resources.find((row: any) => row.path === 'index.html');
    assert.equal(script.responses, 2);
    assert.equal(document.responses, 1);
    assert.equal(facts.responseObjectsRead, 3);
    assert.equal(facts.responseBodyBytes, 2 * script.bytes + document.bytes);
    assert.equal(
        verifyFinalWebStartupCase(result.bytes, f.input, 'synthetic-sdk-version').releaseAcceptance,
        false,
    );
    assert.equal(f.controls.pageCloseCalls, 1);
    assert.equal(f.controls.closes, 1);
});
const invalidResourceFacts: Array<[string, (facts: any) => void]> = [
    [
        'string response count',
        (facts) => {
            facts.resources[0].responses = '2';
        },
    ],
    [
        'foreign resource path',
        (facts) => {
            facts.resources[0].path = 'assets/foreign.js';
        },
    ],
    [
        'repeated count without object total',
        (facts) => {
            facts.resources[0].responses++;
            facts.responseBodyBytes += facts.resources[0].bytes;
        },
    ],
    [
        'missing response count',
        (facts) => {
            delete facts.resources[0].responses;
        },
    ],
    [
        'zero response count',
        (facts) => {
            facts.resources[0].responses = 0;
        },
    ],
    [
        'negative response count',
        (facts) => {
            facts.resources[0].responses = -1;
        },
    ],
    [
        'fractional response count',
        (facts) => {
            facts.resources[0].responses = 1.5;
        },
    ],
    [
        'unsafe response count',
        (facts) => {
            facts.resources[0].responses = Number.MAX_SAFE_INTEGER + 1;
        },
    ],
    [
        'over-profile response count',
        (facts) => {
            facts.resources[0].responses = 4097;
        },
    ],
    [
        'count total mismatch',
        (facts) => {
            facts.responseObjectsRead++;
        },
    ],
    [
        'byte total mismatch',
        (facts) => {
            facts.responseBodyBytes++;
        },
    ],
    [
        'repeated response with unadjusted byte total',
        (facts) => {
            facts.resources[0].responses++;
            facts.responseObjectsRead++;
        },
    ],
    [
        'changed payload bytes with matching aggregates',
        (facts) => {
            facts.resources[0].bytes++;
            facts.responseBodyBytes += facts.resources[0].responses;
        },
    ],
    [
        'changed payload hash',
        (facts) => {
            facts.resources[0].sha256 = 'a'.repeat(64);
        },
    ],
    [
        'unexpected resource field',
        (facts) => {
            facts.resources[0].qualified = true;
        },
    ],
    [
        'duplicate resource',
        (facts) => {
            facts.resources.push({ ...facts.resources[0] });
        },
    ],
    [
        'unsorted resources',
        (facts) => {
            facts.resources.reverse();
        },
    ],
    [
        'omitted navigation resource with matching aggregates',
        (facts) => {
            const row = facts.resources.find((row: any) => row.path === 'index.html');
            facts.resources = facts.resources.filter((item: any) => item.path !== 'index.html');
            facts.responseObjectsRead -= row.responses;
            facts.responseBodyBytes -= row.bytes * row.responses;
        },
    ],
];
for (const [label, mutate] of invalidResourceFacts)
    test('case reader rejects rehashed ' + label, async () => {
        const f = await fixture();
        f.controls.repeatScriptResponse = true;
        const out = await produceFinalWebStartupCase(f.input, f.page, f.ports);
        const record = structuredClone(out.record);
        mutate(record.observation.observations);
        // Rehash the forged observation so rejection must enforce semantic evidence checks.
        record.observationSHA256 = hash(Buffer.from(JSON.stringify(record.observation) + '\n'));
        assert.throws(() =>
            verifyFinalWebStartupCase(
                Buffer.from(JSON.stringify(record) + '\n'),
                f.input,
                'synthetic-sdk-version',
            ),
        );
    });
for (const mode of ['archive', 'checksum', 'source', 'extra'])
    test('bad ' + mode + ' input refuses host/page effects', async () => {
        const f = await fixture();
        if (mode === 'archive') f.input.archiveBytes[0] ^= 1;
        if (mode === 'checksum') f.input.checksumBytes[0] ^= 1;
        if (mode === 'source') f.input.context.sourceCommit = 'd'.repeat(40);
        if (mode === 'extra') (f.input as any).releaseAcceptance = true;
        await assert.rejects(produceFinalWebStartupCase(f.input, f.page, f.ports));
        assert.equal(f.controls.creates, 0);
        assert.equal(f.controls.pageCloseCalls, 0);
    });
test('caller mutation after admission cannot relabel the frozen observation', async () => {
    const f = await fixture(),
        original = {
            ...f.input,
            context: structuredClone(f.input.context),
            observer: { ...f.input.observer },
            archiveBytes: Buffer.from(f.input.archiveBytes),
        };
    const hold = gate();
    f.controls.listenGate = hold;
    const operation = produceFinalWebStartupCase(f.input, f.page, f.ports);
    f.input.context.sourceCommit = 'e'.repeat(40);
    f.input.observer.runId = '999';
    f.input.archiveBytes.fill(0);
    hold.release();
    const result = await operation;
    assert.equal(
        verifyFinalWebStartupCase(result.bytes, original, 'synthetic-sdk-version')
            .releaseAcceptance,
        false,
    );
});
test('primary observation error and both cleanup failures remain distinct with custody retained', async () => {
    const f = await fixture(),
        primary = Error('synthetic navigation'),
        pageError = Error('synthetic page close'),
        hostError = Error('synthetic listener close');
    f.controls.primary = primary;
    f.controls.pageCloseError = pageError;
    f.controls.hostCloseError = hostError;
    await assert.rejects(produceFinalWebStartupCase(f.input, f.page, f.ports), (error: any) => {
        assert.ok(error instanceof FinalWebStartupCaseFailure);
        assert.equal(error.errors[0].cause, primary);
        assert.equal(error.cause, error.errors[0]);
        assert.deepEqual(error.errors.slice(1), [pageError, hostError]);
        assert.equal(error.owner.snapshot().phase, 'retirement-unproved');
        return true;
    });
    assert.equal(f.controls.pageCloseCalls, 1);
    assert.equal(f.controls.closes, 1);
});
for (const role of ['page', 'host'])
    test('held ' + role + ' close acknowledgement prevents completed evidence', async () => {
        const f = await fixture(),
            hold = gate();
        f.controls[role === 'page' ? 'closeGate' : 'hostGate'] = hold;
        let settled = false;
        const operation = produceFinalWebStartupCase(f.input, f.page, f.ports).then((v) => {
            settled = true;
            return v;
        });
        await tick();
        assert.equal(settled, false);
        if (role === 'page') assert.equal(f.controls.closes, 0);
        hold.release();
        await operation;
        assert.equal(settled, true);
    });
test('a resolved page close without its actual close event cannot emit success', async () => {
    const f = await fixture();
    f.controls.omitCloseEvent = true;
    await assert.rejects(produceFinalWebStartupCase(f.input, f.page, f.ports), (error: any) => {
        assert.equal(error.owner.snapshot().pageCloseAcknowledged, false);
        assert.equal(error.owner.snapshot().phase, 'retirement-unproved');
        return true;
    });
});
test('a fully acknowledged observation failure retires owned resources but preserves its original error', async () => {
    const f = await fixture(),
        primary = Error('synthetic navigation');
    f.controls.primary = primary;
    await assert.rejects(produceFinalWebStartupCase(f.input, f.page, f.ports), (error: any) => {
        assert.equal(error.errors[0].cause, primary);
        assert.equal(error.owner.snapshot().phase, 'retired');
        return true;
    });
});
for (const mode of [
    'pass-label',
    'source',
    'resource',
    'observer',
    'version',
    'process-proof',
    'extra',
    'bom',
])
    test('reader rejects forged ' + mode + ' case bytes', async () => {
        const f = await fixture(),
            out = await produceFinalWebStartupCase(f.input, f.page, f.ports),
            r: any = structuredClone(out.record);
        if (mode === 'pass-label') r.status = 'passed';
        if (mode === 'source') r.observation.selectedSource.commit = 'f'.repeat(40);
        if (mode === 'resource') r.observation.observations.resources[0].sha256 = 'a'.repeat(64);
        if (mode === 'observer') r.observation.observer.jobId = '999';
        if (mode === 'version') r.observation.observer.browserVersionReported = 'wrong';
        if (mode === 'process-proof') r.retirement.browserProcessRetirement = true;
        if (mode === 'extra') r.qualificationScope = 'full-product';
        r.observationSHA256 = hash(Buffer.from(JSON.stringify(r.observation) + '\n'));
        const bytes = Buffer.from(JSON.stringify(r) + '\n');
        assert.throws(() =>
            verifyFinalWebStartupCase(
                mode === 'bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes,
                f.input,
                'synthetic-sdk-version',
            ),
        );
    });
test('unselected engine and replayed page cannot allocate a new listener', async () => {
    const f = await fixture();
    f.controls.engine = 'firefox';
    await assert.rejects(produceFinalWebStartupCase(f.input, f.page, f.ports));
    assert.equal(f.controls.creates, 0);
    f.controls.engine = 'chromium';
    await produceFinalWebStartupCase(f.input, f.page, f.ports);
    await assert.rejects(produceFinalWebStartupCase(f.input, f.page, f.ports));
    assert.equal(f.controls.creates, 1);
});
test('real stable input reader consumes exact bounded file bytes through memory descriptors', async () => {
    const f = await fixture(),
        io = memoryFilesystem(),
        selection = {
            artifactDirectory: 'validation/web-source',
            context: f.input.context,
            observer: f.input.observer,
        };
    io.write(
        '/project/validation/web-startup-selection.json',
        Buffer.from(JSON.stringify(selection) + '\n'),
    );
    for (const [name, bytes] of f.f.files)
        io.write('/project/validation/web-source/' + name, bytes);
    const loaded = await readFinalWebStartupInput(
        '/project',
        'validation/web-startup-selection.json',
        io.fs,
    );
    assert.equal(loaded.fingerprint, inspectFinalWebStartupInput(f.input).fingerprint);
    assert.equal(io.handles.size, 0);
    await assert.rejects(
        readFinalWebStartupInput('/project', '../web-startup-selection.json', io.fs),
    );
    const close = Error('synthetic descriptor close');
    io.hooks.close = () => {
        throw close;
    };
    await assert.rejects(
        readFinalWebStartupInput('/project', 'validation/web-startup-selection.json', io.fs),
        (error) => error === close,
    );
    assert.equal(io.handles.size, 1, 'Unacknowledged fake descriptor is retained, not deleted.');
});

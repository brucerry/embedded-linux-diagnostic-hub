import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
    WINDOWS_WINDOW_QUERY_SOURCE,
    decodeWindowsWindowQuery,
    assessWindowsWindowQuery,
    windowQueryEvidence,
    type WindowQueryCapture,
} from './fixtures/windows-installer-window-query';
import { resolveOfflineNativeWindow } from './fixtures/windows-installer-offline';

// Pure captured-data cases; no PowerShell, process lookup, windows, files or native adapter.
// Host-absolute synthetic paths do not qualify Windows path/Win32 behavior.
function fixture() {
    const root = path.resolve('/synthetic/window-query/install');
    const expected = { pid: 234, creationTimeMs: 1800000000123, profile: '/synthetic/profile' };
    const native = {
        pid: expected.pid,
        executable: path.join(root, 'Diagnostic Hub.exe'),
        createdAt: new Date(expected.creationTimeMs).toISOString().replace('.123Z', '.1230000Z'),
        handle: 87,
        visible: true,
        minimized: false,
        title: 'Synthetic Hub',
        version: '0.6.0',
    };
    const body = { schemaVersion: 1, state: 'observed', ...native };
    const capture = (value: unknown = body): WindowQueryCapture => ({
        requestedPID: expected.pid,
        returned: true,
        exitCode: 0,
        signal: null,
        stdoutEOF: true,
        stderrEOF: true,
        failure: 'none',
        stdout: Buffer.from(JSON.stringify(value)),
        stderr: new Uint8Array(),
    });
    return { root, expected, native, body, capture };
}

test('fixed query is inert bounded source with only the selected process/window observations', () => {
    assert.ok(Buffer.byteLength(WINDOWS_WINDOW_QUERY_SOURCE) < 8192);
    for (const text of [
        '[ValidateRange(1,2147483647)]',
        '[int]$TargetProcessId',
        'Get-Process -Id $TargetProcessId',
        '$owned.StartTime.ToUniversalTime()',
        'IsWindowVisible',
        'IsIconic',
        "state='observed'",
        "'inaccessible'",
        "'missing'",
    ])
        assert.ok(WINDOWS_WINDOW_QUERY_SOURCE.includes(text), text);
    assert.equal(
        /\b(?:Invoke-Expression|Start-Process|Stop-Process|CloseMainWindow|SendMessage|PostMessage)\b/.test(
            WINDOWS_WINDOW_QUERY_SOURCE,
        ),
        false,
    );
});

test('strict decoding retains raw query completion and maps valid seven-digit UTC observation fields', () => {
    const f = fixture(),
        raw = f.capture(),
        decoded = decodeWindowsWindowQuery(raw);
    assert.equal(decoded.state, 'observed');
    assert.equal(decoded.raw, raw);
    assert.deepEqual(decoded.native, f.native);
    assert.equal(assessWindowsWindowQuery(f.root, f.expected, '0.6.0', raw).matched, true);
});

test('missing and inaccessible are distinct unknown observations, while an observed absent window is a negative fact', () => {
    const f = fixture();
    for (const state of ['missing', 'inaccessible'] as const) {
        const raw = f.capture({ schemaVersion: 1, state, requestedPID: f.expected.pid });
        const decoded = decodeWindowsWindowQuery(raw);
        assert.equal(decoded.state, state);
        assert.equal(decoded.native, undefined);
        assert.equal(decoded.raw, raw);
        assert.equal(assessWindowsWindowQuery(f.root, f.expected, '0.6.0', raw).matched, false);
    }
    const raw = f.capture({ ...f.body, handle: 0, visible: false });
    const decoded = decodeWindowsWindowQuery(raw);
    assert.equal(decoded.state, 'observed');
    assert.equal(decoded.native!.visible, false);
    assert.equal(assessWindowsWindowQuery(f.root, f.expected, '0.6.0', raw).matched, false);
});

test('failed or uncertain query/exit/pipe outcomes cannot be converted into process observations', () => {
    const f = fixture();
    const changes: Partial<WindowQueryCapture>[] = [
        { returned: false },
        { exitCode: null },
        { exitCode: 1 },
        { signal: 'SIGTERM' },
        { stdoutEOF: false },
        { stderrEOF: false },
        { failure: 'spawn-error' },
        { failure: 'capture-error' },
        { failure: 'pending' },
        { stderr: Buffer.from('synthetic query diagnostic') },
    ];
    for (const change of changes) {
        const raw = Object.assign(f.capture(), change),
            decoded = decodeWindowsWindowQuery(raw);
        assert.equal(decoded.state, 'query-unconfirmed');
        assert.equal(decoded.native, undefined);
        assert.equal(decoded.raw, raw);
        assert.equal(assessWindowsWindowQuery(f.root, f.expected, '0.6.0', raw).matched, false);
    }
});

test('malformed JSON, UTF8, duplicate keys, nested records and nonmatching missing PID are rejected', () => {
    const f = fixture();
    const captures = [
        f.capture(null),
        f.capture([]),
        f.capture({ ...f.body, native: {} }),
        f.capture({ schemaVersion: 1, state: 'missing', requestedPID: 999 }),
        { ...f.capture(), stdout: Buffer.from('{') },
        { ...f.capture(), stdout: Buffer.from([0xff]) },
        {
            ...f.capture(),
            stdout: Buffer.from(JSON.stringify(f.body).replace('"pid":234', '"pid":234,"pid":234')),
        },
        {
            ...f.capture(),
            stdout: Buffer.from(
                JSON.stringify(f.body).replace('"pid":234', '"pid":234,"\\u0070id":234'),
            ),
        },
    ];
    for (const raw of captures) assert.equal(decodeWindowsWindowQuery(raw).state, 'malformed');
    const title = 'quoted key text "pid":234, bracket } and slash \\';
    assert.equal(decodeWindowsWindowQuery(f.capture({ ...f.body, title })).state, 'observed');
});

test('PID, creation time, absolute path, handle and explicit window-field types are strict', () => {
    const f = fixture();
    for (const change of [
        { pid: 0 },
        { pid: 235 },
        { pid: '234' },
        { executable: 'relative.exe' },
        { executable: '/synthetic/../foreign.exe' },
        { createdAt: '2026-02-30T12:00:00.123Z' },
        { createdAt: 'not-a-date' },
        { handle: Number.MAX_SAFE_INTEGER + 1 },
        { handle: -1 },
        { visible: 'true' },
        { minimized: null },
        { title: 'x'.repeat(513) },
        { version: '' },
        { extra: true },
    ]) {
        const decoded = decodeWindowsWindowQuery(f.capture({ ...f.body, ...change }));
        assert.equal(decoded.state, 'malformed', JSON.stringify(change));
        assert.equal(decoded.native, undefined);
    }
});

test('actual successor matcher owns identity acceptance and leaves observed mismatches distinct from unavailable facts', () => {
    const f = fixture();
    for (const change of [
        { executable: path.join(f.root, 'foreign.exe') },
        { createdAt: new Date(f.expected.creationTimeMs - 10).toISOString() },
        { handle: 0 },
        { visible: false },
        { minimized: true },
        { version: '0.5.0' },
    ]) {
        const raw = f.capture({ ...f.body, ...change }),
            result = assessWindowsWindowQuery(f.root, f.expected, '0.6.0', raw);
        assert.equal(result.state, 'observed');
        assert.equal(result.matched, false);
        assert.equal(result.reason, 'NATIVE_IDENTITY_MISMATCH');
        assert.equal(result.raw, raw);
    }
    assert.equal(
        assessWindowsWindowQuery(f.root, { ...f.expected, pid: 235 }, '0.6.0', f.capture()).matched,
        false,
    );
    assert.equal(
        assessWindowsWindowQuery(f.root, f.expected, '0.6.0', f.capture({ ...f.body, title: '' }))
            .matched,
        true,
    );
});

test('actual offline-ready boundary consumes raw decoding and rejects contradictory projections or missing query evidence', () => {
    const f = fixture(),
        request = { root: f.root, profile: f.expected.profile, version: '0.6.0' };
    const good = resolveOfflineNativeWindow(request, f.expected, {
        native: f.native,
        windowQuery: f.capture(),
    });
    assert.equal(good.matched, true);
    assert.equal(good.query!.state, 'observed');
    const contradictory = resolveOfflineNativeWindow(request, f.expected, {
        native: { ...f.native, pid: 235 },
        windowQuery: f.capture(),
    });
    assert.equal(contradictory.matched, false);
    assert.equal(contradictory.query!.reason, 'QUERY_PROJECTION_MISMATCH');
    for (const state of ['missing', 'inaccessible']) {
        const raw = f.capture({ schemaVersion: 1, state, requestedPID: f.expected.pid });
        const result = resolveOfflineNativeWindow(request, f.expected, {
            native: f.native,
            windowQuery: raw,
        });
        assert.equal(result.matched, false);
        assert.equal(result.native, undefined);
        assert.equal(result.query!.raw, raw);
    }
    // Existing synthetic fixture contract remains usable; this is not native admission.
    assert.equal(
        resolveOfflineNativeWindow(request, f.expected, { native: f.native }).matched,
        true,
    );
});

test('raw bytes/outcome remain unchanged and evidence retains complete captures or explicit over-bound custody', () => {
    const f = fixture(),
        raw = f.capture(),
        snapshot = structuredClone(raw),
        stdout = raw.stdout;
    const prototype = Object.getPrototypeOf(stdout),
        properties = Object.getOwnPropertyDescriptors(stdout);
    const result = assessWindowsWindowQuery(f.root, f.expected, '0.6.0', raw),
        evidence = windowQueryEvidence(result);
    assert.equal(result.raw, raw);
    assert.deepEqual(structuredClone(raw), snapshot);
    assert.equal(raw.stdout, stdout);
    assert.equal(Object.getPrototypeOf(raw.stdout), prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptors(raw.stdout), properties);
    assert.deepEqual(Buffer.from(evidence.stdoutBase64!, 'base64'), Buffer.from(raw.stdout));
    assert.deepEqual(Buffer.from(evidence.stderrBase64!, 'base64'), Buffer.from(raw.stderr));
    const over = { ...raw, stdout: new Uint8Array(8193) },
        rejected = decodeWindowsWindowQuery(over);
    assert.equal(rejected.state, 'malformed');
    assert.equal(rejected.raw, over);
    const summary = windowQueryEvidence(rejected);
    assert.equal(summary.stdoutBase64, undefined);
    assert.equal(summary.stdoutBytes, 8193);
    assert.equal(
        decodeWindowsWindowQuery(null as unknown as WindowQueryCapture).state,
        'malformed',
    );
    assert.equal(
        windowQueryEvidence(decodeWindowsWindowQuery(null as unknown as WindowQueryCapture)).state,
        'malformed',
    );
});

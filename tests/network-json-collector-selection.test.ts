import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkCollector, type ExecLimits } from '../backend/ssh/network';
import { validateNetworkEvidence } from '../shared/diagnostics/network/evidence';
import { records } from '../shared/diagnostics/network/json';
import type { Probe, ProbeResult } from '../shared/types';

const stamp = '2026-11-04T12:00:00.000Z';
const probe: Probe = {
    id: 'ethernet',
    title: 'Recorded Ethernet collection',
    category: 'hardware',
    description: 'Synthetic responses; no command is executed.',
    command: 'synthetic Ethernet primary (recording executor only)',
};
// This is invalid JSON, despite containing a plausible Ethernet interface.
// The pre-fix integer rewriter mistakenly quoted the bare numeric key.
const malformed =
    '[{"ifname":"json-only0","ifindex":41,"link_type":"ether",18446744073709551615:1}]\n';
const sysfs =
    '/sys/class/net/eth7/carrier=1\n' +
    '/sys/class/net/eth7/operstate=up\n' +
    '/sys/class/net/eth2/carrier=0\n' +
    '/sys/class/net/lo/carrier=1\n';
const validLargeCounter =
    '[{"ifname":"json-valid0","ifindex":42,"link_type":"ether",' +
    '"stats64":{"rx":{"bytes":18446744073709551615}}}]\n';

const linkCommand =
    'if command -v ip >/dev/null 2>&1; then ip -j -d -s link show; ' +
    'else printf "ip is not installed.\\n" >&2; exit 127; fi';
const neighborCommand =
    'if command -v ip >/dev/null 2>&1; then ip -j neigh show; ' +
    'else printf "ip is not installed.\\n" >&2; exit 127; fi';
const toolCommand = (quotedName: string) =>
    `if command -v ethtool >/dev/null 2>&1; then ethtool ${quotedName}; ` +
    'else printf "ethtool is not installed.\\n" >&2; exit 127; fi';

async function collect(raw: string, primaryStdout: string, unavailable = false) {
    const calls: { id: string; command: string; limits: ExecLimits; response: ProbeResult }[] = [];
    const output = await new NetworkCollector().collect(probe, async (id, command, limits) => {
        assert.ok(Number.isFinite(limits.timeoutMs) && limits.timeoutMs > 0);
        assert.ok(limits.timeoutMs <= 12000);
        assert.ok(limits.maxBytes > 0 && limits.maxBytes <= 262144);
        const isPrimary = id === 'ethernet';
        const exitCode = isPrimary && unavailable ? 127 : 0;
        const response: ProbeResult = {
            id,
            command,
            status: exitCode === 0 ? 'collected' : 'unavailable',
            stdout: isPrimary
                ? primaryStdout
                : id === 'ip-link-json:all'
                  ? raw
                  : id === 'ip-neighbor-json:all'
                    ? '[]\n'
                    : `Settings for ${id.slice('ethtool:'.length)}:\n\tLink detected: yes\n`,
            stderr:
                isPrimary && unavailable
                    ? 'No readable network attributes are exposed by the running kernel.\n'
                    : '',
            exitCode,
            durationMs: 1,
            collectedAt: stamp,
            truncated: false,
        };
        calls.push({ id, command, limits: { ...limits }, response: structuredClone(response) });
        return response;
    });
    const { networkEvidence, ...primary } = output;
    assert.deepEqual(primary, calls[0].response, 'primary raw evidence is unchanged');
    assert.ok(networkEvidence);
    assert.deepEqual(networkEvidence.omissions, []);
    assert.deepEqual(validateNetworkEvidence(networkEvidence, output), networkEvidence);
    assert.deepEqual(
        networkEvidence.sections,
        calls.slice(1).map(({ id, command, response }) => ({
            ...response,
            id,
            command,
            operation: id.slice(0, id.indexOf(':')),
            scope: id.slice(id.indexOf(':') + 1),
            source: 'live',
        })),
        'every invoked optional command retains its exact response and metadata',
    );
    const linkEvidence = networkEvidence.sections.find(
        (section) => section.id === 'ip-link-json:all',
    );
    assert.ok(linkEvidence);
    assert.equal(linkEvidence.stdout, raw);
    return { calls: calls.map(({ id, command }) => ({ id, command })), linkEvidence };
}

const baseCalls = [
    { id: 'ethernet', command: probe.command },
    { id: 'ip-link-json:all', command: linkCommand },
    { id: 'ip-neighbor-json:all', command: neighborCommand },
];

test('malformed link JSON selects only legitimate sysfs fallback interfaces', async () => {
    assert.throws(() => JSON.parse(malformed), SyntaxError);
    const actual = await collect(malformed, sysfs);
    assert.deepEqual(actual.calls, [
        ...baseCalls,
        { id: 'ethtool:eth7', command: toolCommand("'eth7'") },
        { id: 'ethtool:eth2', command: toolCommand("'eth2'") },
    ]);
});

test('malformed link JSON without sysfs fallback cannot create an interface command target', async () => {
    assert.throws(() => JSON.parse(malformed), SyntaxError);
    const actual = await collect(malformed, '', true);
    assert.deepEqual(actual.calls, baseCalls);
});

test('valid link JSON with a 64-bit counter keeps its exact target and raw evidence', async () => {
    assert.doesNotThrow(() => JSON.parse(validLargeCounter));
    const actual = await collect(validLargeCounter, sysfs);
    assert.deepEqual(actual.calls, [
        ...baseCalls,
        { id: 'ethtool:json-valid0', command: toolCommand("'json-valid0'") },
    ]);
    assert.equal(
        (records(actual.linkEvidence.stdout)[0].stats64 as { rx: { bytes: unknown } }).rx.bytes,
        '18446744073709551615',
    );
});

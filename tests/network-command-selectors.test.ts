import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkCollector } from '../backend/ssh/network';
const stamp = '2028-02-29T00:00:00.000Z';
function result(id: string, stdout: string) {
 return { id, stdout, stderr: '', exitCode: 0, status: 'collected' as const, durationMs: 1, collectedAt: stamp, truncated: false };
}
async function ethernet(records: unknown[]) {
 const calls: { id: string; command: string }[] = [];
 const raw = JSON.stringify(records);
 const output = await new NetworkCollector().collect({ id: 'ethernet', command: 'fixed primary' } as any, async (id, command) => {
  calls.push({ id, command });
  return result(id, id === 'ip-link-json:all' ? raw : '');
 });
 assert.equal(output.networkEvidence!.sections.find((s) => s.operation === 'ip-link-json')!.stdout, raw);
 return { output, calls: calls.filter((c) => c.id.startsWith('ethtool:')) };
}

const quoted = [
 ['eth0', "'eth0'"],
 ["wl'an;$(echo X)", "'wl'\\''an;$(echo X)'"],
 ['wl name`x`', "'wl name`x`'"],
 ['true', "'true'"],
] as const;
const shell = (tool: string, args: string) => `if command -v ${tool} >/dev/null 2>&1; then ${tool} ${args}; else printf "${tool} is not installed.\\n" >&2; exit 127; fi`;
test('Ethernet selectors require actual text and preserve valid siblings plus raw malformed evidence', async () => {
 const f = await ethernet([true, null, undefined, {}, [], { toString: 'not callable' }].map((ifname) => ({ ifname, link_type: 'ether' })).concat([{ ifname: 'eth0', link_type: 'ether' }] as any));
 assert.deepEqual(f.calls, [{ id: 'ethtool:eth0', command: shell('ethtool', "'eth0'") }]);
 assert.equal(f.output.networkEvidence!.omissions.length, 6);
 assert.ok(f.output.networkEvidence!.omissions.every((o) => o.reason === 'Reported interface name is not text; raw evidence is retained.'));
});
test('actual Ethernet and sysfs fallback construction keep hostile text as one quoted argument', async () => {
 const f = await ethernet(quoted.map(([ifname]) => ({ ifname, link_type: 'ether' })));
 assert.deepEqual(f.calls.map((c) => c.command), quoted.map(([, q]) => shell('ethtool', q)));
 const calls: string[] = [];
 await new NetworkCollector().collect({ id: 'ethernet', command: 'fixed primary' } as any, async (id, command) => {
  if (id.startsWith('ethtool:')) calls.push(command);
  return result(id, id === 'ethernet' ? "/sys/class/net/wl'an;$(echo X)/carrier=1\n" : id === 'ip-link-json:all' ? '[]' : '');
 });
 assert.deepEqual(calls, [shell('ethtool', quoted[1][1])]);
});
test('actual WLAN getters retain fixed verbs, quoted names and digits-only PHY selectors', async () => {
 const calls: { id: string; command: string }[] = [];
 const raw = "phy#7;ATTACK\n" + quoted.map(([name]) => `  Interface ${name}\n    type managed\n`).join('');
 await new NetworkCollector().collect({ id: 'wireless', command: 'fixed primary' } as any, async (id, command) => {
  calls.push({ id, command }); return result(id, id === 'wireless' ? raw : '');
 });
 for (const [name, q] of quoted) for (const [op, args] of [['iw-link','link'],['iw-stations','station dump'],['iw-survey','survey dump'],['iw-power-save','get power_save']])
  assert.equal(calls.find((c) => c.id === `${op}:${name}`)?.command, shell('iw', `dev ${q} ${args}`));
 assert.equal(calls.find((c) => c.id === 'iw-phy:phy7')?.command, shell('iw', 'phy phy7 info'));
 assert.ok(calls.every((c) => !c.command.includes('ATTACK')));
});
test('option-like and control selectors remain rejected while malformed entries cannot exhaust valid interface slots', async () => {
 const f = await ethernet([...Array.from({ length: 40 }, () => ({ ifname: false, link_type: 'ether' })),
  ...['-x', '--help', 'bad\nname', 'bad\u0000name'].map((ifname) => ({ ifname, link_type: 'ether' })),
  { ifname: 'valid0', link_type: 'ether' }]);
 assert.deepEqual(f.calls.map((c) => c.id), ['ethtool:valid0']);
 assert.equal(f.output.networkEvidence!.omissions.length, 32);
});
test('literal numeric text is preserved, non-Ethernet and explicitly virtual records keep existing exclusion', async () => {
 const f = await ethernet([{ ifname: '17', link_type: 'ether' }, { ifname: 'lo', link_type: 'ether' },
 { ifname: 'tun0', link_type: 'none' }, { ifname: 'bridge0', link_type: 'ether', linkinfo: { info_kind: 'bridge' } }]);
 assert.deepEqual(f.calls, [{ id: 'ethtool:17', command: shell('ethtool', "'17'") }]);
});

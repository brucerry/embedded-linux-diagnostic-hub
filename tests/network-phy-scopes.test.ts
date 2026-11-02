import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkCollector } from '../backend/ssh/network';
import { validateNetworkEvidence } from '../shared/diagnostics/network/evidence';
const stamp = '2028-02-29T00:00:00.000Z';
function result(id: string, stdout: string) { return { id, stdout, stderr: '', exitCode: 0, status: 'collected' as const, durationMs: 1, collectedAt: stamp, truncated: false }; }
async function collect(digits: string, exhaust = false) {
 const raw = `phy#${digits}\n  Interface wlan0\n    type managed\nphy#1\n  Interface wlan1\n    type managed\n`;
 const calls: {id: string; command: string}[] = [];
 const output = await new NetworkCollector().collect({ id: 'wireless', command: 'fixed synthetic primary' } as any, async (id, command, limits) => {
  calls.push({ id, command });
  return result(id, id === 'wireless' ? raw : exhaust && id === 'iw-regulatory:global' ? 'x'.repeat(limits.maxBytes) : '');
 });
 assert.equal(output.stdout, raw);
 return { output, raw, calls };
}

const warning = 'Network scope cannot be represented; raw evidence is retained.';
test('oversized PHY never becomes a command, section key or budget omission scope; raw discovery remains exact', async () => {
 for (const digits of ['9'.repeat(126), '8'.repeat(8200)]) for (const exhaust of [false, true]) {
  const f = await collect(digits, exhaust), e = f.output.networkEvidence!;
  assert.deepEqual(validateNetworkEvidence(e, f.output), e);
  assert.ok(!f.calls.some((c) => c.id.includes(digits) || c.command.includes(digits)));
  assert.ok(e.omissions.some((o) => o.operation === 'iw-phy' && o.scope === 'unsupported selector' && o.reason === warning));
  assert.ok(e.sections.every((s) => s.id.length <= 256 && s.scope.length <= 128 && typeof s.command === 'string' && s.command.length <= 8192));
  assert.ok(e.omissions.length <= 32 && e.omissions.every((o) => o.scope.length <= 128 && o.reason.length <= 512));
  if (!exhaust) assert.ok(f.calls.some((c) => c.id === 'iw-phy:phy1'));
  else assert.ok(e.omissions.some((o) => o.operation === 'iw-phy' && o.scope === 'phy1'));
 }
});
test('exact scope boundary and ordinary PHY identifiers stay unchanged without imposing a hardware range', async () => {
 for (const digits of ['0', '123', '7'.repeat(125)]) {
  const f = await collect(digits), scope = 'phy' + digits;
  assert.deepEqual(validateNetworkEvidence(f.output.networkEvidence, f.output), f.output.networkEvidence);
  assert.ok(f.calls.some((c) => c.id === 'iw-phy:' + scope && c.command.includes('phy ' + scope + ' info')));
  assert.ok(!f.output.networkEvidence!.omissions.some((o) => o.reason === warning));
 }
});
test('unrepresentable PHY records do not consume valid sibling capability slots or enlarge omission rows', async () => {
 const raw = Array.from({length: 40}, (_, i) => `phy#${String(i).padStart(126, '0')}\n Interface bad${i}\n type managed\n`).join('') + 'phy#2\n Interface wlan2\n type managed\n';
 const calls: string[] = [];
 const output = await new NetworkCollector().collect({id: 'wireless', command: 'fixed primary'} as any, async (id) => {
  calls.push(id); return result(id, id === 'wireless' ? raw : '');
 });
 assert.ok(calls.includes('iw-phy:phy2'));
 assert.equal(output.networkEvidence!.omissions.length, 32);
 assert.ok(output.networkEvidence!.omissions.every((o) => o.scope.length <= 128 && o.reason.length <= 512));
 assert.deepEqual(validateNetworkEvidence(output.networkEvidence, output), output.networkEvidence);
 assert.equal(output.stdout, raw);
});

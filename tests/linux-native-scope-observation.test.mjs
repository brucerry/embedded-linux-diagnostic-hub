import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectLinuxNativeScopeObservation } from '../scripts/lib/linux-native-scope-observation.mjs';

const scope = {device: '27', inode: '1001'};
const before = { ...scope, monotonicNs: '9007199254740992', events: 'populated 1\nfrozen 0\n' };
const after = { ...scope, monotonicNs: '9007199254740993', events: 'populated 0\nfrozen 0\n' };

test('same observed cgroup can become empty without authorizing cleanup', () => {
    const r = inspectLinuxNativeScopeObservation(scope, {before, after});
    assert.equal(r.status, 'same-scope-population-transition-consistent');
    assert.equal(r.scopeOwnership, 'not-verified');
    assert.equal(r.cleanupAuthorized, false);
    assert.equal(r.releaseAcceptance, false);
});

test('missing, reused, populated, frozen and unordered scopes stay unqualified', () => {
    for (const [bad, why] of [
        [null, /No cgroup snapshot/],
        [{...after, inode: '1002'}, /Different scope inode/],
        [{...after, events: before.events}, /still populated/],
        [{...after, events: 'populated 0\nfrozen 1\n'}, /Frozen/],
        [{...after, events: 'populated 0\npopulated 1\n'}, /Malformed/],
        [{...after, monotonicNs: before.monotonicNs}, /out of order/],
    ]) assert.throws(() => inspectLinuxNativeScopeObservation(scope, {before, after: bad}), why);
});

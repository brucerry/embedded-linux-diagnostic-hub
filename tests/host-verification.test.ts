import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostVerification } from '../electron/host-verification';
import type { HostKeyVerification } from '../shared/types';

test('host approval is tied to the current request and rejects stale or malformed replies', async () => {
    const events: (HostKeyVerification | null)[] = [];
    const trust = new HostVerification((request) => events.push(request));
    const first = trust.request('board:22', 'new', 'saved');
    const firstId = events.at(-1)!.id;
    const second = trust.request('board:22', 'different');
    const secondId = events.at(-1)!.id;
    assert.equal(await first, false);
    assert.equal(trust.confirm(firstId, true), false);
    assert.equal(trust.confirm(secondId, 'true'), false);
    assert.equal(trust.confirm(secondId, true), true);
    assert.equal(await second, true);
    assert.equal(events.at(-1), null);
    assert.equal(trust.confirm(secondId, true), false);
});

test('closing or expiring a host approval cancels it and clears the UI', async () => {
    const events: (HostKeyVerification | null)[] = [];
    const trust = new HostVerification((request) => events.push(request), 10);
    const pending = trust.request('board:22', 'key');
    trust.clear();
    assert.equal(await pending, false);
    assert.equal(events.at(-1), null);
    assert.equal(await trust.request('board:22', 'key'), false);
    assert.equal(events.at(-1), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
    LinuxTransactionModel,
    linuxModelReviewSHA256,
    type LinuxModelPlan,
    type LinuxModelPayload,
    type LinuxModelView,
    type LinuxMemoryEffects,
    type LinuxModelKernel,
    type LinuxModelLease,
    type LinuxModelScope,
    type LinuxReservationIdentity,
} from '../electron/linux-transaction-model';
import { INSTALLATION_PRODUCT, validateInstallationManifest } from '../shared/installation';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const id = '11111111-1111-4111-8111-111111111111';
const transaction = '22222222-2222-4222-8222-222222222222';
const oldTransaction = '33333333-3333-4333-8333-333333333333';
const token = '44444444-4444-4444-8444-444444444444';
function manifest(version: string) {
    return validateInstallationManifest({
        schemaVersion: 1,
        product: INSTALLATION_PRODUCT,
        platform: 'linux',
        arch: 'x64',
        layout: 'linux-folder',
        version,
        sourceCommit: 'a'.repeat(40),
        entryPoint: 'app/diagnostic-hub',
        files: [{ kind: 'file', path: 'app/diagnostic-hub', bytes: 7, sha256: hash('fixture') }],
    });
}
function harness(installed = true) {
    const host = {
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
        euid: 1000,
        home: '/home/test',
        appData: '/home/test/data',
        sourceRoot: '/home/test/source',
        version: '0.6.0',
    };
    const root = '/home/test/installed',
        profile = host.appData + '/DiagnosticHub/profiles/' + id;
    const owned = (version: string, ino: number, txn = oldTransaction): LinuxModelPayload => ({
        identity: { uid: 1000, dev: 1, ino },
        manifest: manifest(version),
        verifiedManifestSHA256: hash(JSON.stringify(manifest(version))),
        installationId: id,
        transactionId: txn,
        root,
        profile,
    });
    let world: LinuxModelView = {
        activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
        parents: ['/', '/home', '/home/test', '/home/test/source', '/home/test/data'].map(
            (path, index) => ({
                path,
                uid: path.startsWith('/home/test') ? 1000 : 0,
                mode: 0o40700,
                dev: 1,
                ino: path === host.sourceRoot ? 90 : index + 1,
            }),
        ),
        source: {
            identity: { uid: 1000, dev: 1, ino: 90 },
            manifest: manifest('0.6.0'),
            verifiedManifestSHA256: hash(JSON.stringify(manifest('0.6.0'))),
        },
        root: installed ? owned('0.5.2', 80) : null,
        stage: null,
        previous: null,
        journal: null,
    };
    const plan = (): LinuxModelPlan => ({
        host: clone(host),
        root,
        action: installed ? 'update' : 'install',
        transactionId: transaction,
        installationId: id,
        owner: {
            pid: 777,
            startTicks: '9999',
            executable: host.sourceRoot + '/app/diagnostic-hub',
        },
        consent: true,
        review: clone(world),
        reviewSHA256: linuxModelReviewSHA256(world),
    });
    const calls: string[] = [],
        leases = new Map<object, LinuxReservationIdentity>();
    let hook: (event: string, argument?: unknown) => void | Promise<void> = () => {};
    let nextInode = 81;
    const kernel: LinuxModelKernel = {
        async acquire(wanted) {
            calls.push('reserve');
            await hook('reserve', wanted);
            if ([...leases.values()].some((lease) => lease.key === wanted.key)) return null;
            const handle = {},
                identity = { ...clone(wanted), token };
            leases.set(handle, clone(identity));
            const returned = { handle, identity };
            await hook('reserved', returned);
            return returned;
        },
        async current(handle) {
            calls.push('current');
            await hook('current');
            if (!leases.has(handle)) throw Error('no lease');
            return clone(leases.get(handle)!);
        },
        async release(handle, expected) {
            calls.push('release');
            await hook('release', expected);
            assert.deepEqual(leases.get(handle), expected);
            leases.delete(handle);
            return true;
        },
    };
    const guarded = async (kind: string, guard: LinuxModelView, effect: () => void) => {
        calls.push(kind);
        await hook('before-' + kind, guard);
        assert.deepEqual(world, guard);
        effect();
        await hook('after-' + kind, world);
        return clone(world);
    };
    const effects: LinuxMemoryEffects = {
        kind: 'injected-memory-effects',
        async observe(scope) {
            calls.push('observe');
            assert.equal(scope.root, root);
            assert.equal(scope.source, host.sourceRoot);
            await hook('observe', scope);
            return clone(world);
        },
        async journal(scope, guard, next) {
            assertScope(scope);
            return guarded('journal:' + next.phase, guard, () => {
                world.journal = clone(next);
            });
        },
        async stage(scope, guard, payload) {
            assertScope(scope);
            await hook('stage-input', payload);
            return guarded('stage', guard, () => {
                assert.equal(world.stage, null);
                world.stage = {
                    ...clone(payload),
                    identity: { uid: 1000, dev: 1, ino: nextInode++ },
                };
            });
        },
        async move(scope, guard, from, to) {
            assertScope(scope);
            return guarded('move:' + from + ':' + to, guard, () => {
                assert.equal(world[to], null);
                assert.notEqual(world[from], null);
                world[to] = world[from];
                world[from] = null;
            });
        },
    };
    function assertScope(scope: LinuxModelScope) {
        assert.equal(scope.uid, 1000);
        assert.equal(scope.root, root);
        assert.equal(
            scope.stage,
            '/home/test/.DiagnosticHub-maintenance-' +
                hash(root).slice(0, 20) +
                '/stage-' +
                transaction,
        );
        assert.equal(
            scope.previous,
            '/home/test/.DiagnosticHub-maintenance-' +
                hash(root).slice(0, 20) +
                '/previous-' +
                transaction,
        );
    }
    return {
        host,
        root,
        profile,
        owned,
        plan,
        calls,
        leases,
        kernel,
        effects,
        get world() {
            return world;
        },
        set world(value) {
            world = value;
        },
        setHook(value: typeof hook) {
            hook = value;
        },
    };
}
function mutations(calls: string[]) {
    return calls.filter(
        (call) => call.startsWith('journal:') || call.startsWith('move:') || call === 'stage',
    );
}
test('modeled Linux update is reserved before inspection, stages verified payload and retains exact previous bytes/UUID/profile', async () => {
    const h = harness(),
        original = clone(h.world.root),
        summary = await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
    assert.equal(summary.verdict, 'ACTIVE_PREVIOUS_RETAINED');
    assert.equal(summary.reservation, 'released');
    assert.equal(summary.modelOnly, true);
    assert.deepEqual(h.calls.slice(0, 3), ['reserve', 'current', 'observe']);
    assert.deepEqual(h.world.previous, original);
    assert.equal(h.world.root?.manifest.version, '0.6.0');
    assert.equal(h.world.root?.installationId, id);
    assert.equal(h.world.root?.profile, h.profile);
    assert.equal(h.world.stage, null);
    assert.equal(h.world.journal?.phase, 'candidate-active');
    assert.deepEqual(mutations(h.calls), [
        'journal:copying',
        'stage',
        'journal:prepared',
        'move:root:previous',
        'journal:old-retained',
        'move:stage:root',
        'journal:candidate-active',
    ]);
    assert.equal(h.leases.size, 0);
});
test('modeled fresh install and same-version repair preserve identity and never invent launch/removal/Finalize effects', async () => {
    for (const repair of [false, true]) {
        const h = harness(repair);
        if (repair) h.world.root = h.owned('0.6.0', 80);
        const plan = h.plan();
        if (repair) plan.action = 'repair';
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
            'ACTIVE_PREVIOUS_RETAINED',
        );
        assert.equal(h.world.previous?.manifest.version ?? null, repair ? '0.6.0' : null);
        assert.equal(
            h.calls.some((call) => /launch|delete|finalize|unlink|signal/.test(call)),
            false,
        );
    }
});
for (const problem of [
    'root-user',
    'elevated',
    'windows',
    'arm64',
    'consent',
    'escape',
    'source-overlap',
    'profile-overlap',
    'owner',
    'review',
    'parent',
    'links',
    'source-hash',
    'unknown-fields',
] as const)
    test('admission refuses before reservation: ' + problem, async () => {
        const h = harness(),
            plan = h.plan();
        if (problem === 'root-user') plan.host.uid = 0;
        if (problem === 'elevated') plan.host.euid = 0;
        if (problem === 'windows') plan.host.platform = 'win32';
        if (problem === 'arm64') plan.host.arch = 'arm64';
        if (problem === 'consent') plan.consent = false;
        if (problem === 'escape') plan.root = '/home/test/../elsewhere';
        if (problem === 'source-overlap') plan.root = plan.host.sourceRoot + '/inside';
        if (problem === 'profile-overlap') plan.root = plan.host.appData;
        if (problem === 'owner') plan.owner.executable = '/foreign/runtime';
        if (problem === 'review') plan.reviewSHA256 = '0'.repeat(64);
        if (problem === 'parent') plan.review.parents[2].mode = 0o40777;
        if (problem === 'links')
            (plan.review.source.manifest.files[0] as unknown as { kind: string }).kind = 'link';
        if (problem === 'source-hash') plan.review.source.verifiedManifestSHA256 = '0'.repeat(64);
        if (problem === 'unknown-fields') Object.assign(plan, { unknown: 'refuse' });
        const before = clone(h.world);
        const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(plan);
        assert.equal(summary.verdict, 'REFUSED');
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.world, before);
    });
test('same-root contenders serialize without inspecting or mutating winner state', async () => {
    const h = harness(),
        plan = h.plan();
    let ready!: () => void, resume!: () => void;
    const entered = new Promise<void>((resolve) => {
            ready = resolve;
        }),
        gate = new Promise<void>((resolve) => {
            resume = resolve;
        });
    let first = true;
    h.setHook(async (event) => {
        if (event === 'observe' && first) {
            first = false;
            ready();
            await gate;
        }
    });
    const running = new LinuxTransactionModel(h.kernel, h.effects).run(plan);
    await entered;
    const before = clone(h.world),
        callIndex = h.calls.length;
    const loser = await new LinuxTransactionModel(h.kernel, h.effects).run(plan);
    assert.equal(loser.verdict, 'REFUSED');
    assert.equal(loser.reason, 'RESERVATION_UNAVAILABLE');
    assert.deepEqual(h.calls.slice(callIndex), ['reserve']);
    assert.deepEqual(h.world, before);
    resume();
    assert.equal((await running).verdict, 'ACTIVE_PREVIOUS_RETAINED');
});
test('canonical root/uid reservation keys are stable and do not reuse a different root key', async () => {
    const h = harness();
    let key = '';
    h.setHook((event, value) => {
        if (event === 'reserve') key = (value as { key: string }).key;
    });
    await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
    assert.equal(key, 'dh-linux-' + hash('1000\0' + h.root));
    assert.ok(key.length < 100);
    assert.notEqual(key, 'dh-linux-' + hash('1001\0' + h.root));
    assert.notEqual(key, 'dh-linux-' + hash('1000\0' + h.root + '-other'));
});
for (const problem of [
    'stale-journal',
    'foreign-journal',
    'stage',
    'previous',
    'downgrade',
    'changed-inode',
    'changed-source',
] as const)
    test(
        'stale/foreign/changed state refuses without mutation or reservation takeover: ' + problem,
        async () => {
            const h = harness(),
                plan = h.plan();
            if (problem === 'stale-journal' || problem === 'foreign-journal') {
                // Create a genuine model journal, then use a newly reviewed but conflicting install request.
                await new LinuxTransactionModel(h.kernel, h.effects).run(plan);
                const next = h.plan();
                if (problem === 'foreign-journal') next.transactionId = oldTransaction;
                const before = clone(h.world),
                    index = h.calls.length;
                assert.equal(
                    (await new LinuxTransactionModel(h.kernel, h.effects).run(next)).verdict,
                    problem === 'foreign-journal' ? 'REFUSED' : 'RETAINED_UNKNOWN',
                );
                assert.deepEqual(mutations(h.calls.slice(index)), []);
                assert.deepEqual(h.world, before);
                return;
            }
            if (problem === 'stage') h.world.stage = h.owned('0.6.0', 81, transaction);
            if (problem === 'previous') h.world.previous = h.owned('0.5.1', 82);
            if (problem === 'downgrade') h.world.root = h.owned('0.7.0', 80);
            if (problem === 'changed-inode') h.world.parents[2].ino++;
            if (problem === 'changed-source')
                h.world.source.verifiedManifestSHA256 = '0'.repeat(64);
            // Stage/previous/downgrade are explicitly reviewed and still unavailable; changes are not.
            const request = ['stage', 'previous', 'downgrade'].includes(problem) ? h.plan() : plan;
            const before = clone(h.world);
            const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(request);
            assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
            assert.deepEqual(mutations(h.calls), []);
            assert.deepEqual(h.world, before);
        },
    );
for (const event of [
    'after-journal:copying',
    'after-stage',
    'after-journal:prepared',
    'after-move:root:previous',
    'after-journal:old-retained',
    'after-move:stage:root',
    'after-journal:candidate-active',
])
    test(
        'interruption retains current state and lease with no automatic rollback or later effect: ' +
            event,
        async () => {
            const h = harness();
            let stoppedAt = -1;
            h.setHook((name) => {
                if (name === event) {
                    stoppedAt = h.calls.length;
                    throw Error('private-canary-do-not-publish');
                }
            });
            const adapter = new LinuxTransactionModel(h.kernel, h.effects),
                summary = await adapter.run(h.plan());
            assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
            assert.equal(summary.reservation, 'held');
            assert.equal(h.calls.length, stoppedAt);
            assert.equal(h.leases.size, 1);
            assert.doesNotMatch(JSON.stringify(summary), /canary|\/home|fixture/);
            await assert.rejects(adapter.run(h.plan()), /consumed/);
            assert.equal(h.calls.length, stoppedAt);
        },
    );
test('lease identity changes and ambiguous release preserve UNKNOWN without further observation', async () => {
    for (const problem of [
        'lease-change',
        'release-false',
        'release-throw',
        'reserve-throw',
    ] as const) {
        const h = harness();
        if (problem === 'lease-change')
            h.setHook((event) => {
                if (event === 'current') [...h.leases.values()][0].owner.startTicks = '123';
            });
        if (problem === 'release-false')
            h.kernel.release = async () => {
                h.calls.push('release-false');
                return false;
            };
        if (problem === 'release-throw')
            h.kernel.release = async () => {
                h.calls.push('release-throw');
                throw Error('private');
            };
        if (problem === 'reserve-throw')
            h.kernel.acquire = async () => {
                h.calls.push('reserve-throw');
                throw Error('private');
            };
        const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
        assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
        assert.doesNotMatch(JSON.stringify(summary), /private/);
        if (problem.includes('release') || problem === 'reserve-throw')
            assert.equal(summary.reservation, 'unknown');
        if (problem === 'lease-change') assert.deepEqual(h.calls, ['reserve', 'current']);
    }
});
test('mutable effect arguments cannot rewrite stable package, owner or previous comparison identities', async () => {
    for (const problem of ['candidate', 'guard', 'owner', 'returned-view'] as const) {
        const h = harness();
        const original = clone(h.world.root);
        if (problem === 'candidate')
            h.setHook((event, value) => {
                if (event === 'stage-input')
                    (value as { manifest: { version: string } }).manifest.version = '99.0.0';
            });
        if (problem === 'guard')
            h.setHook((event, value) => {
                if (event === 'before-stage')
                    (value as LinuxModelView).source.manifest.version = '99.0.0';
            });
        if (problem === 'owner')
            h.setHook((event, value) => {
                if (event === 'release')
                    (value as LinuxReservationIdentity).owner.startTicks = 'wrong';
            });
        if (problem === 'returned-view')
            h.setHook((event) => {
                if (event === 'after-stage') h.world.root!.manifest.version = '99.0.0';
            });
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan())).verdict,
            'RETAINED_UNKNOWN',
        );
        if (h.world.previous) assert.deepEqual(h.world.previous, original);
    }
});
test('explicit modeled rollback restores old bytes, retains candidate, preserves profile and does not delete journal', async () => {
    for (const installed of [false, true]) {
        const h = harness(installed),
            original = clone(h.world.root);
        await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
        const active = clone(h.world.root);
        const plan = h.plan();
        plan.action = 'rollback';
        const start = h.calls.length;
        const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(plan);
        assert.equal(summary.verdict, 'ROLLED_BACK_RETAINED');
        assert.deepEqual(h.world.root, original);
        assert.deepEqual(h.world.stage, active);
        assert.equal(h.world.previous, null);
        assert.equal(h.world.journal?.phase, 'rolled-back');
        assert.deepEqual(mutations(h.calls.slice(start)), [
            'journal:rollback-started',
            'move:root:stage',
            'journal:candidate-retained',
            ...(installed ? ['move:previous:root'] : []),
            'journal:rolled-back',
        ]);
        // A separately reviewed repeated rollback acknowledges exactly settled state without moves.
        const again = h.plan();
        again.action = 'rollback';
        const index = h.calls.length;
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(again)).verdict,
            'ROLLED_BACK_RETAINED',
        );
        assert.deepEqual(mutations(h.calls.slice(index)), []);
    }
});
for (const event of [
    'after-journal:rollback-started',
    'after-move:root:stage',
    'after-journal:candidate-retained',
    'after-move:previous:root',
])
    test(
        'interrupted rollback is explicit retained state; a new reviewed model can resume only matching slots: ' +
            event,
        async () => {
            const h = harness(),
                original = clone(h.world.root);
            await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
            const active = clone(h.world.root),
                plan = h.plan();
            plan.action = 'rollback';
            h.setHook((name) => {
                if (name === event) throw Error('inert interruption');
            });
            assert.equal(
                (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
                'RETAINED_UNKNOWN',
            );
            const before = clone(h.world),
                count = h.calls.length;
            assert.equal(h.leases.size, 1);
            // No recovery can steal the still-held lease.
            h.setHook(() => {});
            const resume = h.plan();
            resume.action = 'rollback';
            assert.equal(
                (await new LinuxTransactionModel(h.kernel, h.effects).run(resume)).verdict,
                'REFUSED',
            );
            assert.deepEqual(h.world, before);
            assert.deepEqual(h.calls.slice(count), ['reserve']);
            // Model-only simulated process lifetime releases its own kernel reservation. No real signal/process.
            h.leases.clear();
            assert.equal(
                (await new LinuxTransactionModel(h.kernel, h.effects).run(resume)).verdict,
                'ROLLED_BACK_RETAINED',
            );
            assert.deepEqual(h.world.root, original);
            assert.deepEqual(h.world.stage, active);
        },
    );
test('foreign rollback candidate refuses without deleting, restoring or moving anything', async () => {
    const h = harness();
    await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
    h.world.root!.transactionId = oldTransaction;
    const plan = h.plan();
    plan.action = 'rollback';
    const before = clone(h.world),
        index = h.calls.length;
    assert.equal(
        (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
        'RETAINED_UNKNOWN',
    );
    assert.deepEqual(h.world, before);
    assert.deepEqual(mutations(h.calls.slice(index)), []);
});

test('source-parent identity mismatch and incomplete/aliased parent chains cannot be reviewed into authority', async () => {
    for (const problem of ['source-parent', 'missing-parent', 'aliased-parent'] as const) {
        const h = harness(),
            plan = h.plan();
        if (problem === 'source-parent') plan.review.source.identity.ino++;
        if (problem === 'missing-parent') plan.review.parents.pop();
        if (problem === 'aliased-parent') plan.review.parents[1].ino = plan.review.parents[0].ino;
        plan.reviewSHA256 = linuxModelReviewSHA256(plan.review);
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
            'REFUSED',
        );
        assert.deepEqual(h.calls, []);
    }
});
test('foreign or malformed returned reservation is retained without observing state or releasing another owner', async () => {
    for (const problem of ['foreign-root', 'foreign-owner', 'bad-token'] as const) {
        const h = harness();
        h.setHook((event, value) => {
            if (event !== 'reserved') return;
            const lease = value as LinuxModelLease;
            if (problem === 'foreign-root') lease.identity.root = '/foreign';
            if (problem === 'foreign-owner') lease.identity.owner.startTicks = 'different';
            if (problem === 'bad-token') lease.identity.token = 'invalid';
        });
        const before = clone(h.world);
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan())).verdict,
            'RETAINED_UNKNOWN',
        );
        assert.deepEqual(h.calls, ['reserve']);
        assert.deepEqual(h.world, before);
        assert.equal(h.leases.size, 1);
    }
});
test('malformed returned mutation snapshot cannot unwind custody or publish private data', async () => {
    const h = harness();
    h.effects.journal = async (_scope, _guard, next) => {
        h.calls.push('malformed-journal-return');
        h.world.journal = clone(next);
        const malformed = clone(h.world) as LinuxModelView & { privateCanary?: unknown };
        malformed.privateCanary = malformed;
        return malformed;
    };
    const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
    assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
    assert.equal(summary.pending, 'journal');
    assert.equal(h.leases.size, 1);
    assert.equal(h.calls.at(-1), 'malformed-journal-return');
    assert.doesNotMatch(JSON.stringify(summary), /privateCanary|\/home/);
});
test('incomplete install phases require separate recovery design and cannot be guessed into rollback', async () => {
    for (const event of [
        'after-journal:copying',
        'after-journal:prepared',
        'after-journal:old-retained',
    ]) {
        const h = harness();
        h.setHook((name) => {
            if (name === event) throw Error('model interruption');
        });
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan())).verdict,
            'RETAINED_UNKNOWN',
        );
        // Simulated lifetime only; no real process or historical state is touched.
        h.leases.clear();
        h.setHook(() => {});
        const plan = h.plan();
        plan.action = 'rollback';
        const before = clone(h.world),
            index = h.calls.length;
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
            'RETAINED_UNKNOWN',
        );
        assert.deepEqual(h.world, before);
        assert.deepEqual(mutations(h.calls.slice(index)), []);
    }
});

test('active or uninspectable affected slots refuse before reservation and remain unchanged', async () => {
    for (const slot of ['root', 'stage', 'previous'] as const)
        for (const state of ['active', 'unknown'] as const) {
            const h = harness();
            h.world.activity[slot] = state;
            const before = clone(h.world);
            assert.equal(
                (await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan())).verdict,
                'REFUSED',
            );
            assert.deepEqual(h.calls, []);
            assert.deepEqual(h.world, before);
        }
});
test('fresh activity changing to busy stops before any modeled mutation without signalling', async () => {
    const h = harness(),
        plan = h.plan();
    h.setHook((event) => {
        if (event === 'observe') h.world.activity.root = 'active';
    });
    const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(plan);
    assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
    assert.deepEqual(mutations(h.calls), []);
    assert.equal(
        h.calls.some((call) => /signal|release|kill/.test(call)),
        false,
    );
});

// Exact R1/R2 counterexamples from independent review0370710c. Every backend here is memory-only.
for (const [label, value] of [
    ['string false', 'false'],
    ['object', {}],
    ['number1', 1],
] as const)
    test('R1 truthy nonboolean release never retires custody: ' + label, async () => {
        const h = harness();
        h.kernel.release = async () => {
            h.calls.push('malformed-release');
            return value as unknown as boolean;
        };
        const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
        assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
        assert.equal(summary.reservation, 'unknown');
        assert.equal(h.leases.size, 1);
        assert.equal(h.calls.at(-1), 'malformed-release');
    });
for (const [label, value] of [
    ['false', false],
    ['undefined', undefined],
    ['zero', 0],
    ['empty string', ''],
] as const)
    test(
        'R1 nonnull falsy acquire is unknown even if backend allocated a lease: ' + label,
        async () => {
            const h = harness(),
                original = h.kernel.acquire.bind(h.kernel);
            h.kernel.acquire = async (wanted) => {
                await original(wanted);
                return value as unknown as LinuxModelLease;
            };
            const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
            assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
            assert.equal(summary.reservation, 'unknown');
            assert.equal(h.leases.size, 1);
            assert.deepEqual(h.calls, ['reserve']);
            assert.deepEqual(mutations(h.calls), []);
        },
    );
for (const [label, value] of [
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
] as const)
    test('R2 malformed reviewed journal refuses before reservation: ' + label, async () => {
        const h = harness(),
            plan = h.plan();
        plan.review.journal = value as unknown as LinuxModelView['journal'];
        plan.reviewSHA256 = linuxModelReviewSHA256(plan.review);
        const before = clone(h.world);
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
            'REFUSED',
        );
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.world, before);
    });
for (const slot of ['stage', 'previous'] as const)
    test('R2 malformed reviewed slot refuses before any effect: ' + slot, async () => {
        const h = harness(),
            plan = h.plan();
        plan.review[slot] = false as unknown as LinuxModelPayload;
        plan.reviewSHA256 = linuxModelReviewSHA256(plan.review);
        assert.equal(
            (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
            'REFUSED',
        );
        assert.deepEqual(h.calls, []);
    });
test('R1 exact null acquire and exact true release remain the only settled acknowledgements', async () => {
    const h = harness();
    h.kernel.acquire = async () => {
        h.calls.push('exact-null');
        return null;
    };
    const absent = await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
    assert.equal(absent.verdict, 'REFUSED');
    assert.equal(absent.reservation, 'none');
    assert.deepEqual(h.calls, ['exact-null']);
    const okay = harness();
    assert.equal(
        (await new LinuxTransactionModel(okay.kernel, okay.effects).run(okay.plan())).reservation,
        'released',
    );
    assert.equal(okay.leases.size, 0);
    for (const value of [false, null, undefined, 0, '']) {
        const f = harness();
        f.kernel.release = async () => value as unknown as boolean;
        const summary = await new LinuxTransactionModel(f.kernel, f.effects).run(f.plan());
        assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
        assert.equal(summary.reservation, 'unknown');
        assert.equal(f.leases.size, 1);
    }
});
test('R2 each nullable field rejects all nonnull falsy reviewed representations', async () => {
    for (const field of ['root', 'stage', 'previous', 'journal'] as const)
        for (const value of [false, 0, '', undefined]) {
            const h = harness(),
                plan = h.plan();
            (plan.review as unknown as Record<string, unknown>)[field] = value;
            if (value !== undefined) plan.reviewSHA256 = linuxModelReviewSHA256(plan.review);
            assert.equal(
                (await new LinuxTransactionModel(h.kernel, h.effects).run(plan)).verdict,
                'REFUSED',
                field,
            );
            assert.deepEqual(h.calls, []);
        }
});
test('R2 malformed fresh observation stops before mutation and makes no later query/release', async () => {
    for (const field of ['root', 'stage', 'previous', 'journal'] as const)
        for (const value of [false, 0, '']) {
            const h = harness(),
                plan = h.plan();
            h.setHook((event) => {
                if (event === 'observe')
                    (h.world as unknown as Record<string, unknown>)[field] = value;
            });
            const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(plan);
            assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
            assert.deepEqual(h.calls, ['reserve', 'current', 'observe']);
            assert.equal(h.leases.size, 1);
        }
});
test('R2 malformed returned effect snapshots retain unknown and stop after that exact submission', async () => {
    for (const field of ['root', 'stage', 'previous', 'journal'] as const)
        for (const value of [false, 0, '']) {
            const h = harness();
            h.setHook((event) => {
                if (event === 'after-journal:copying')
                    (h.world as unknown as Record<string, unknown>)[field] = value;
            });
            const summary = await new LinuxTransactionModel(h.kernel, h.effects).run(h.plan());
            assert.equal(summary.verdict, 'RETAINED_UNKNOWN');
            assert.equal(h.calls.at(-1), 'journal:copying');
            assert.deepEqual(mutations(h.calls), ['journal:copying']);
            assert.equal(h.leases.size, 1);
        }
});

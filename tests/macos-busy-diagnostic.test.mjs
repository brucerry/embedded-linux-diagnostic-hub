import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMacBusyFailure } from './macos-installer-native-cli.mjs';

// Authored data only. These controls classify a nonpassing diagnostic; they do not
// run an action, publish a record, construct IO, or establish native evidence.
const methods = [
    'prepare',
    'snapshot',
    'install',
    'snapshot',
    'launchOwned',
    'snapshot',
    'install',
    'snapshot',
    'quitOwned',
];
const phases = [
    'arguments',
    'input-validation',
    'space-and-once-only-claim',
    'source-identity',
    'adapter-initialization',
    'busy-only-case',
    'busy-only-publication',
    'completed-busy-only-unqualified',
];
const stages = [
    'not-started',
    'action-validation',
    'terminal-records',
    'helper-originals',
    'helper-diagnostic',
    'payload-originals',
    'app-originals',
    'shipping-original',
    'case-original',
    'helper-disk',
    'final-gate',
    'unclassified',
];
const keys = [
    'case',
    'status',
    'phase',
    'resultStatus',
    'caseStatus',
    'returnedActions',
    'lastMethod',
    'pendingMethod',
    'pendingPhase',
    'publicationStage',
    'publicationItem',
    'retainedUnknown',
    'releaseAcceptance',
].sort();
const privateCanary = 'PRIVATE_PATH_ENDPOINT_ERROR_OR_CREDENTIAL_CANARY';
function state(count = 7) {
    return {
        phase: 'busy-only-case',
        holdRequired: true,
        busyPublicationStage: 'not-started',
        busyPublicationItem: null,
        actions: {
            result: {
                status: 'failed',
                cases: [
                    {
                        status: 'failed',
                        actions: methods.slice(0, count).map((method) => ({
                            method,
                            returned: true,
                        })),
                    },
                ],
            },
            custody: { pending: null },
        },
    };
}
function safe(value) {
    assert.deepEqual(Object.keys(value).sort(), keys);
    assert.equal(value.case, 'macos-bundle:busy-refusal');
    assert.equal(value.status, 'nonpassing');
    assert.equal(value.releaseAcceptance, false);
    assert.equal(typeof value.retainedUnknown, 'boolean');
    assert.ok([...phases, 'unclassified'].includes(value.phase));
    assert.ok(
        ['unavailable', 'verified', 'failed', 'unknown', 'unclassified'].includes(
            value.resultStatus,
        ),
    );
    assert.ok(
        ['unexecuted', 'running', 'verified', 'failed', 'unknown', 'unclassified'].includes(
            value.caseStatus,
        ),
    );
    assert.ok(
        value.returnedActions === null ||
            (Number.isSafeInteger(value.returnedActions) &&
                value.returnedActions >= 0 &&
                value.returnedActions <= 9),
    );
    for (const key of ['lastMethod', 'pendingMethod'])
        assert.ok([...new Set(methods), 'none', 'unclassified'].includes(value[key]));
    assert.ok(['none', 'submitted', 'returned', 'unclassified'].includes(value.pendingPhase));
    assert.ok(stages.includes(value.publicationStage));
    assert.ok(value.publicationItem === null || [0, 1, 2].includes(value.publicationItem));
    const text = JSON.stringify(value);
    assert.ok(Buffer.byteLength(text) <= 1024);
    assert.equal(text.includes(privateCanary), false);
    return value;
}
function setAt(value, path, replacement) {
    let target = value;
    for (const key of path.slice(0, -1)) target = target[key];
    target[path.at(-1)] = replacement;
}
function accessorAt(value, path, get) {
    let target = value;
    for (const key of path.slice(0, -1)) target = target[key];
    Object.defineProperty(target, path.at(-1), { get, enumerable: true, configurable: true });
}
const selectedPaths = [
    ['phase'],
    ['holdRequired'],
    ['busyPublicationStage'],
    ['busyPublicationItem'],
    ['actions'],
    ['actions', 'result'],
    ['actions', 'result', 'status'],
    ['actions', 'result', 'cases'],
    ['actions', 'result', 'cases', 0],
    ['actions', 'result', 'cases', 0, 'status'],
    ['actions', 'result', 'cases', 0, 'actions'],
    ['actions', 'result', 'cases', 0, 'actions', 0],
    ['actions', 'result', 'cases', 0, 'actions', 0, 'method'],
    ['actions', 'result', 'cases', 0, 'actions', 0, 'returned'],
    ['actions', 'custody'],
    ['actions', 'custody', 'pending'],
    ['actions', 'custody', 'pending', 'method'],
    ['actions', 'custody', 'pending', 'phase'],
];

test('busy diagnostic absent or malformed state remains a closed nonpassing unknown', () => {
    for (const input of [undefined, null, false, 7, privateCanary, [], {}, Object.create(null)]) {
        const result = safe(classifyMacBusyFailure(input));
        assert.equal(result.retainedUnknown, true);
        assert.equal(result.returnedActions, null);
        assert.equal(result.lastMethod, 'unclassified');
    }
    const value = state();
    value.holdRequired = false;
    assert.equal(safe(classifyMacBusyFailure(value)).retainedUnknown, false);
    for (const hold of [null, 0, 'false', {}, undefined]) {
        value.holdRequired = hold;
        assert.equal(safe(classifyMacBusyFailure(value)).retainedUnknown, true);
    }
});

test('busy diagnostic phases use exact known codes and never reflect a private phase', () => {
    for (const phase of phases) {
        const value = state();
        value.phase = phase;
        assert.equal(safe(classifyMacBusyFailure(value)).phase, phase);
    }
    for (const phase of [
        privateCanary,
        'busy-only-case ',
        'BUSY-ONLY-CASE',
        null,
        1,
        {},
        ['busy-only-case'],
    ]) {
        const value = state();
        value.phase = phase;
        assert.equal(safe(classifyMacBusyFailure(value)).phase, 'unclassified');
    }
});

test('busy diagnostic known result and case labels never become acceptance or closure', () => {
    for (const resultStatus of ['unavailable', 'verified', 'failed', 'unknown'])
        for (const caseStatus of ['unexecuted', 'running', 'verified', 'failed', 'unknown']) {
            const value = state();
            value.actions.result.status = resultStatus;
            value.actions.result.cases[0].status = caseStatus;
            const result = safe(classifyMacBusyFailure(value));
            assert.equal(result.resultStatus, resultStatus);
            assert.equal(result.caseStatus, caseStatus);
        }
    const value = state();
    value.actions.result.status = privateCanary;
    value.actions.result.cases[0].status = 'passed';
    const result = safe(classifyMacBusyFailure(value));
    assert.equal(result.resultStatus, 'unclassified');
    assert.equal(result.caseStatus, 'unclassified');
});

test('busy diagnostic counts returned prefix records without asserting validated action completion', () => {
    for (let count = 0; count <= methods.length; count++) {
        const value = state(count);
        // Facts can fail validation after a method returns; they are not traversed here.
        if (count) value.actions.result.cases[0].actions.at(-1).invalidReturnedShape = true;
        const result = safe(classifyMacBusyFailure(value));
        assert.equal(result.returnedActions, count);
        assert.equal(result.lastMethod, count ? methods[count - 1] : 'none');
        assert.equal(result.resultStatus, 'failed');
    }
});

test('busy diagnostic pending submissions and returns must agree with the returned prefix position', () => {
    for (let count = 0; count <= methods.length; count++) {
        if (count < methods.length) {
            const value = state(count);
            value.actions.custody.pending = { method: methods[count], phase: 'submitted' };
            const result = safe(classifyMacBusyFailure(value));
            assert.equal(result.pendingMethod, methods[count]);
            assert.equal(result.pendingPhase, 'submitted');
        }
        if (count > 0) {
            const value = state(count);
            value.actions.custody.pending = { method: methods[count - 1], phase: 'returned' };
            const result = safe(classifyMacBusyFailure(value));
            assert.equal(result.pendingMethod, methods[count - 1]);
            assert.equal(result.pendingPhase, 'returned');
        }
    }
    for (const [count, pending] of [
        [0, { method: 'prepare', phase: 'returned' }],
        [9, { method: 'quitOwned', phase: 'submitted' }],
        [0, { method: 'quitOwned', phase: 'submitted' }],
        [1, { method: 'snapshot', phase: 'returned' }],
        [7, { method: privateCanary, phase: 'submitted' }],
        [7, { method: 'snapshot', phase: privateCanary }],
        [7, undefined],
    ]) {
        const value = state(count);
        value.actions.custody.pending = pending;
        const result = safe(classifyMacBusyFailure(value));
        assert.equal(result.pendingMethod, 'unclassified');
        assert.equal(result.pendingPhase, 'unclassified');
    }
    const result = safe(classifyMacBusyFailure(state()));
    assert.equal(result.pendingMethod, 'none');
    assert.equal(result.pendingPhase, 'none');
});

test('busy diagnostic publisher cursor is distinct from returned action position and is allowlisted', () => {
    for (const stage of stages)
        for (const item of [null, 0, 1, 2]) {
            const value = state(9);
            value.phase = 'busy-only-publication';
            value.actions.result.status = 'verified';
            value.actions.result.cases[0].status = 'verified';
            value.busyPublicationStage = stage;
            value.busyPublicationItem = item;
            const result = safe(classifyMacBusyFailure(value));
            assert.equal(result.publicationStage, stage);
            assert.equal(result.publicationItem, stage === 'unclassified' ? null : item);
            assert.equal(result.returnedActions, 9);
            assert.equal(result.lastMethod, 'quitOwned');
        }
    const value = state(2);
    value.busyPublicationStage = 'helper-originals';
    value.busyPublicationItem = 1;
    const result = safe(classifyMacBusyFailure(value));
    assert.equal(result.phase, 'busy-only-case');
    assert.equal(result.lastMethod, 'snapshot');
    assert.equal(result.publicationStage, 'helper-originals');
    for (const stage of [privateCanary, 'helper-originals ', {}, null]) {
        value.busyPublicationStage = stage;
        assert.equal(safe(classifyMacBusyFailure(value)).publicationStage, 'unclassified');
    }
    value.busyPublicationStage = 'helper-originals';
    for (const item of [-1, 3, 1.5, '1', privateCanary, {}, undefined]) {
        value.busyPublicationItem = item;
        assert.equal(safe(classifyMacBusyFailure(value)).publicationItem, null);
    }
});

test('busy diagnostic malformed sparse reordered and overlong action transcripts remain unknown', () => {
    const replacements = [
        null,
        {},
        'prepare',
        new Array(1),
        [{ method: 'snapshot', returned: true }],
        [{ method: 'prepare', returned: false }],
        [{ method: 'prepare' }],
        [
            { method: 'prepare', returned: true },
            { method: 'install', returned: true },
        ],
        methods.concat('quitOwned').map((method) => ({ method, returned: true })),
    ];
    for (const actions of replacements) {
        const value = state();
        value.actions.result.cases[0].actions = actions;
        const result = safe(classifyMacBusyFailure(value));
        assert.equal(result.returnedActions, null);
        assert.equal(result.lastMethod, 'unclassified');
    }
    for (const cases of [null, {}, [], new Array(1), [state().actions.result.cases[0], {}]]) {
        const value = state();
        value.actions.result.cases = cases;
        const result = safe(classifyMacBusyFailure(value));
        assert.equal(result.returnedActions, null);
        assert.equal(result.lastMethod, 'unclassified');
        assert.equal(result.caseStatus, 'unclassified');
    }
});

test('busy diagnostic never invokes accessors at any selected state or action position', () => {
    let reads = 0;
    for (const path of selectedPaths) {
        const value = state();
        value.actions.custody.pending = { method: 'snapshot', phase: 'submitted' };
        accessorAt(value, path, () => {
            reads++;
            throw Error(privateCanary);
        });
        safe(classifyMacBusyFailure(value));
    }
    const value = state();
    const inherited = Object.create({
        phase: 'busy-only-case',
        holdRequired: false,
        actions: value.actions,
    });
    const result = safe(classifyMacBusyFailure(inherited));
    assert.equal(result.phase, 'unclassified');
    assert.equal(result.retainedUnknown, true);
    assert.equal(result.returnedActions, null);
    assert.equal(reads, 0);
});

test('busy diagnostic rejects live and revoked proxies without invoking their traps', () => {
    let traps = 0;
    const handler = Object.fromEntries(
        ['get', 'set', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor', 'has'].map(
            (name) => [
                name,
                () => {
                    traps++;
                    throw Error(privateCanary);
                },
            ],
        ),
    );
    for (const path of [[], ...selectedPaths]) {
        const live = new Proxy({}, handler),
            revoked = Proxy.revocable({}, handler);
        revoked.revoke();
        for (const proxy of [live, revoked.proxy]) {
            const value = state();
            value.actions.custody.pending = { method: 'snapshot', phase: 'submitted' };
            if (path.length) {
                setAt(value, path, proxy);
                safe(classifyMacBusyFailure(value));
            } else safe(classifyMacBusyFailure(proxy));
        }
    }
    assert.equal(traps, 0);
});

test('busy diagnostic does not traverse errors facts endpoints or any unselected private data', () => {
    let reads = 0;
    const privateObject = new Proxy(
        {},
        {
            get() {
                reads++;
                throw Error(privateCanary);
            },
            ownKeys() {
                reads++;
                throw Error(privateCanary);
            },
            getOwnPropertyDescriptor() {
                reads++;
                throw Error(privateCanary);
            },
        },
    );
    const failure = {};
    for (const name of ['message', 'name', 'stack', 'toJSON', 'toString'])
        Object.defineProperty(failure, name, {
            get() {
                reads++;
                throw Error(privateCanary);
            },
        });
    const value = state();
    value.failure = failure;
    value.io = privateObject;
    value.root = privateCanary;
    value.endpoint = privateCanary;
    value.actions.result.reason = privateCanary;
    value.actions.custody.owners = privateObject;
    for (const action of value.actions.result.cases[0].actions) {
        action.facts = privateObject;
        action.error = failure;
        action.id = privateCanary;
    }
    const result = safe(classifyMacBusyFailure(value));
    assert.equal(result.returnedActions, 7);
    assert.equal(result.lastMethod, 'install');
    assert.equal(reads, 0);
});

test('busy diagnostic is deterministic without mutating retained or frozen evidence', () => {
    const value = state(9);
    value.actions.result.status = 'verified';
    value.actions.result.cases[0].status = 'verified';
    const before = JSON.stringify(value);
    const freeze = (object) => {
        for (const child of Object.values(object))
            if (child && typeof child === 'object') freeze(child);
        return Object.freeze(object);
    };
    freeze(value);
    const first = safe(classifyMacBusyFailure(value)),
        second = safe(classifyMacBusyFailure(value));
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(value), before);
    assert.equal(first.status, 'nonpassing');
    assert.equal(first.releaseAcceptance, false);
    assert.equal(first.retainedUnknown, true);
    assert.equal(Object.hasOwn(first, 'closure'), false);
    assert.equal(Object.hasOwn(first, 'nativeEffects'), false);
});

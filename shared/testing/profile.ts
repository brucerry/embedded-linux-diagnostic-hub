import {
    DOMAINS,
    PROFILE_BYTES,
    type BoardProfile,
    type BoardTest,
    type Inventory,
    type Readiness,
    type Resource,
    type Selector,
    type TestPlan,
} from './types';
import {
    bool,
    bounded,
    choice,
    digest,
    id,
    list,
    number,
    object,
    text,
    unique,
} from './validation';
import { dtStrings } from './inventory';

export const ADAPTERS = {
    'led.pattern': {
        domain: 'led',
        version: '1.0.0',
        effects:
            'Temporarily changes brightness and trigger; captures, restores and verifies both. Operator observation is required.',
    },
    'uart.loopback': {
        domain: 'uart',
        version: '1.0.0',
        effects:
            'Opens the approved port, changes serial settings and transmits bytes; restores settings and closes its handle. External loopback required.',
    },
    'i2c.identity': {
        domain: 'i2c',
        version: '1.0.0',
        effects:
            'Performs one approved byte-register read, including its register-address transfer. No scans, force access or driver changes.',
    },
} as const;
export const PARAMETER_RANGES: Record<string, [number, number]> = {
    cycles: [1, 20],
    level: [0, 65535],
    intervalMs: [100, 1000],
    baud: [1200, 1000000],
    timeoutMs: [100, 5000],
    register: [0, 255],
    expected: [0, 255],
    mask: [1, 255],
};
export const UART_BAUDS = [
    1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000,
];
export function validateTest(input: unknown): BoardTest {
    const v = object(
        input,
        ['id', 'name', 'adapter', 'resource', 'required', 'fixture', 'expected', 'parameters'],
        'Test',
    );
    const adapter = choice(
        v.adapter,
        Object.keys(ADAPTERS) as (keyof typeof ADAPTERS)[],
        'Test adapter',
    );
    const keys =
        adapter === 'led.pattern'
            ? ['cycles', 'level', 'intervalMs']
            : adapter === 'uart.loopback'
              ? ['baud', 'payload', 'timeoutMs']
              : ['register', 'expected', 'mask'];
    const raw = object(v.parameters, keys, 'Parameters');
    const parameters: BoardTest['parameters'] = {};
    for (const key of keys) {
        const value = raw[key];
        if (value === null) {
            parameters[key] = null;
            continue;
        }
        if (key === 'payload') parameters[key] = text(value, key, 4096, false);
        else {
            parameters[key] = number(value, key, ...PARAMETER_RANGES[key]);
        }
    }
    if (
        adapter === 'uart.loopback' &&
        parameters.baud !== null &&
        !UART_BAUDS.includes(parameters.baud as number)
    )
        throw Error('baud: unsupported serial speed.');
    return {
        id: id(v.id, 'Test ID'),
        name: text(v.name, 'Test name', 160, false),
        adapter,
        resource: id(v.resource, 'Resource reference'),
        required: bool(v.required, 'Required'),
        fixture: text(v.fixture, 'Fixture', 1024),
        expected: text(v.expected, 'Expected behavior', 1024),
        parameters,
    };
}
export function validateProfile(input: unknown): BoardProfile {
    bounded(input, PROFILE_BYTES, 'Profile');
    const v = object(
        input,
        [
            'schemaVersion',
            'id',
            'revision',
            'name',
            'boardRevision',
            'match',
            'resources',
            'tests',
            'sequences',
        ],
        'Profile',
    );
    if (v.schemaVersion !== 1) throw Error('Unsupported profile schema. Use schemaVersion 1.');
    const match = object(v.match, ['model', 'compatible', 'manual'], 'Board match');
    const resources = unique(
        list(v.resources, 'Resources', 64).map((raw) => {
            const r = object(raw, ['id', 'domain', 'selector'], 'Resource');
            const s = object(
                r.selector,
                ['path', 'ofNode', 'name', 'identity', 'controller', 'address'],
                'Selector',
            );
            const selector: Selector = {};
            for (const k of Object.keys(s)) {
                if (k === 'address') selector.address = number(s[k], 'Address', 3, 119);
                else {
                    const value = text(s[k], k, 512, false);
                    if (
                        ['path', 'ofNode', 'controller'].includes(k) &&
                        (!value.startsWith('/') ||
                            value.split('/').includes('..') ||
                            /[\r\n\t]/.test(value))
                    )
                        throw Error(`${k}: invalid resource path.`);
                    (selector as Record<string, unknown>)[k] = value;
                }
            }
            return {
                id: id(r.id, 'Logical resource ID'),
                domain: choice(r.domain, DOMAINS, 'Resource domain'),
                selector,
            };
        }),
        (r) => r.id,
        'Resources',
    );
    const tests = unique(list(v.tests, 'Tests', 64).map(validateTest), (t) => t.id, 'Tests');
    for (const test of tests) {
        const resource = resources.find((r) => r.id === test.resource);
        if (!resource || resource.domain !== ADAPTERS[test.adapter].domain)
            throw Error(`${test.id}: missing or incompatible resource reference.`);
    }
    const sequences = unique(
        list(v.sequences, 'Sequences', 16).map((raw) => {
            const s = object(raw, ['id', 'name', 'tests', 'stopOnFailure'], 'Sequence');
            const refs = unique(
                list(s.tests, 'Sequence tests', 64).map((x) => id(x, 'Test reference')),
                (x) => x,
                'Sequence',
            );
            if (refs.some((ref) => !tests.some((t) => t.id === ref)))
                throw Error('Sequence references an unknown test.');
            return {
                id: id(s.id, 'Sequence ID'),
                name: text(s.name, 'Sequence name', 160, false),
                tests: refs,
                stopOnFailure: bool(s.stopOnFailure, 'Stop on failure'),
            };
        }),
        (s) => s.id,
        'Sequences',
    );
    return {
        schemaVersion: 1,
        id: id(v.id, 'Profile ID'),
        revision: text(v.revision, 'Revision', 64, false),
        name: text(v.name, 'Profile name', 160, false),
        boardRevision: text(v.boardRevision, 'Declared board revision', 128),
        match: {
            model: text(match.model, 'Model'),
            compatible: text(match.compatible, 'Compatible'),
            manual: bool(match.manual, 'Manual matching'),
        },
        resources,
        tests,
        sequences,
    };
}
export function validateReadiness(input: unknown, tests: BoardTest[]): Readiness {
    const v = object(input, ['reviewed', 'fixtures'], 'Readiness');
    const raw = object(
        v.fixtures,
        tests.map((t) => t.id),
        'Fixtures',
    );
    const fixtures: Readiness['fixtures'] = {};
    for (const key of Object.keys(raw)) {
        const f = object(raw[key], ['ready', 'identity'], 'Fixture');
        fixtures[key] = {
            ready: bool(f.ready, 'Fixture ready'),
            identity: text(f.identity, 'Fixture identity', 160),
        };
    }
    return { reviewed: bool(v.reviewed, 'Plan reviewed'), fixtures };
}
export function matches(resource: Resource, selector: Selector): boolean {
    return Object.entries(selector).every(
        ([k, value]) => (resource as unknown as Record<string, unknown>)[k] === value,
    );
}
export async function preparePlan(input: unknown, inventory: Inventory): Promise<TestPlan> {
    const profile = validateProfile(input);
    const boardProblems: string[] = [];
    if (profile.match.model && profile.match.model !== inventory.device.model)
        boardProblems.push('Board model does not match this profile.');
    if (profile.match.compatible && !inventory.device.compatible.includes(profile.match.compatible))
        boardProblems.push('Board compatible identity does not match.');
    if (!profile.match.model && !profile.match.compatible && !profile.match.manual)
        boardProblems.push('Specify board matching criteria or review explicit manual mappings.');
    return {
        profile,
        inventory,
        profileDigest: await digest(profile),
        cases: profile.tests.map((test) => {
            const mapping = profile.resources.find((r) => r.id === test.resource)!;
            const candidates = Object.keys(mapping.selector).length
                ? inventory.resources.filter(
                      (r) => r.domain === mapping.domain && matches(r, mapping.selector),
                  )
                : [];
            const resource = candidates.length === 1 ? candidates[0] : null;
            const problems = [...boardProblems];
            if (!inventory.complete)
                problems.push(
                    'Discovery is incomplete. Resolve discovery errors before active testing.',
                );
            if (!resource)
                problems.push(
                    candidates.length
                        ? 'Resource mapping is ambiguous.'
                        : 'Resource mapping is missing.',
                );
            const status =
                resource &&
                inventory.nodes.find((n) => n.path === resource.ofNode)?.properties.status;
            if (status) {
                try {
                    if (!['okay', 'ok'].includes(dtStrings(status)[0]))
                        problems.push(
                            'The device tree declares this resource disabled or unavailable.',
                        );
                } catch {
                    problems.push('The device-tree resource status cannot be decoded.');
                }
            }
            if (
                !test.expected.trim() ||
                !test.fixture.trim() ||
                Object.values(test.parameters).some((v) => v === null)
            )
                problems.push(
                    'Complete expected behavior, approved parameters and fixture requirements.',
                );
            if (!inventory.capabilities.timeout)
                problems.push('A supported timeout supervisor is required.');
            if (test.adapter === 'uart.loopback' && !inventory.capabilities.python3)
                problems.push('Installed Python 3 with termios is required for UART loopback.');
            if (test.adapter === 'i2c.identity' && !inventory.capabilities.i2cget)
                problems.push('Installed i2cget is required.');
            if (resource?.console) problems.push('This UART is an active kernel console.');
            if (resource && !resource.writable)
                problems.push('The selected resource is not writable by this SSH user.');
            if (resource?.metadata.busy === 'yes')
                problems.push('The resource has a known conflicting owner.');
            if (
                test.adapter === 'led.pattern' &&
                resource &&
                (!/^\d+$/.test(resource.metadata.maxBrightness ?? '') ||
                    Number(test.parameters.level) > Number(resource.metadata.maxBrightness))
            )
                problems.push('Brightness exceeds the observed LED limit.');
            if (
                test.adapter === 'i2c.identity' &&
                resource &&
                (!/^\d+$/.test(resource.metadata.bus ?? '') ||
                    !Number.isInteger(Number(resource.metadata.bus)) ||
                    Number(resource.metadata.bus) > 65535 ||
                    resource.address === null ||
                    resource.address < 3 ||
                    resource.address > 119)
            )
                problems.push('I2C bus/address resolution is incomplete.');
            return { test, resource, problems, effects: ADAPTERS[test.adapter].effects };
        }),
    };
}
export function draftProfile(inventory: Inventory): BoardProfile {
    const resources = inventory.resources.slice(0, 64).map((r, i) => ({
        id: `${r.domain}-${i + 1}`,
        domain: r.domain,
        selector: r.ofNode
            ? {
                  ofNode: r.ofNode,
                  ...(r.domain === 'led' ? { name: r.name } : {}),
                  ...(r.address !== null ? { address: r.address } : {}),
              }
            : { path: r.path },
    }));
    const defaults = (domain: string): BoardTest['parameters'] => {
        if (domain === 'led') return { cycles: 3, level: null, intervalMs: 500 };
        if (domain === 'uart')
            return { baud: 115200, payload: 'Diagnostic Hub loopback\r\n', timeoutMs: 2000 };
        return { register: null, expected: null, mask: 255 };
    };
    const tests = resources
        .filter((r) => ['led', 'uart', 'i2c'].includes(r.domain))
        .map<BoardTest>((r) => ({
            id: `test-${r.id}`,
            name: `${r.domain.toUpperCase()} · ${r.id}`,
            adapter:
                r.domain === 'led'
                    ? 'led.pattern'
                    : r.domain === 'uart'
                      ? 'uart.loopback'
                      : 'i2c.identity',
            resource: r.id,
            required: true,
            fixture: '',
            expected: '',
            parameters: defaults(r.domain),
        }));
    return validateProfile({
        schemaVersion: 1,
        id: 'board-profile',
        revision: '1',
        name: inventory.device.model || 'New board profile',
        boardRevision: '',
        match: {
            model: inventory.device.model,
            compatible: inventory.device.compatible[0] || '',
            manual: !inventory.device.model && !inventory.device.compatible.length,
        },
        resources,
        tests,
        sequences: [
            {
                id: 'bench',
                name: 'Bench sequence',
                tests: tests.map((t) => t.id),
                stopOnFailure: false,
            },
        ],
    });
}

import { validateProfile, validateReadiness } from './profile';
import { PROFILE_BYTES, type BoardProfile, type Readiness } from './types';
import { id, list, object, text, unique } from './validation';

export interface DirectRequest {
    profile: BoardProfile;
    testIds: string[];
    sequence: string;
    readiness: Readiness;
}

/** Run is the prepared engineer's execution action; no extra agreement UI is needed. */
export function parseDirectRequest(source: string): DirectRequest {
    if (new TextEncoder().encode(source).length > PROFILE_BYTES + 32 * 1024)
        throw Error('JSON request exceeds 160 KiB.');
    let raw: unknown;
    try {
        raw = JSON.parse(source);
    } catch {
        throw Error('Paste valid profile or run-request JSON.');
    }
    const wrapped = Boolean(raw && typeof raw === 'object' && 'profile' in raw);
    const request = wrapped
        ? object(raw, ['profile', 'sequence', 'testIds', 'fixtures'], 'JSON run')
        : {};
    const profile = validateProfile(wrapped ? request.profile : raw);
    if (request.sequence !== undefined && request.testIds !== undefined)
        throw Error('Choose sequence or testIds, not both.');
    const sequence =
        request.sequence !== undefined
            ? text(request.sequence, 'Sequence', 64, false)
            : request.testIds === undefined
              ? profile.sequences[0]?.id || ''
              : '';
    const saved = profile.sequences.find((s) => s.id === sequence);
    if (sequence && !saved) throw Error('Sequence references an unknown saved sequence.');
    const testIds =
        request.testIds !== undefined
            ? unique(
                  list(request.testIds, 'Selected tests', 64).map((x) => id(x, 'Test ID')),
                  (x) => x,
                  'Selected tests',
              )
            : (saved?.tests ?? profile.tests.map((t) => t.id));
    if (!testIds.length || testIds.some((x) => !profile.tests.some((t) => t.id === x)))
        throw Error('Select at least one known test.');
    if (!profile.match.model && !profile.match.compatible && !profile.match.manual)
        throw Error('Specify board matching criteria or explicit manual mappings.');
    for (const test of profile.tests.filter((t) => testIds.includes(t.id))) {
        if (
            !test.fixture.trim() ||
            !test.expected.trim() ||
            Object.values(test.parameters).some((v) => v === null)
        )
            throw Error(
                `${test.id}: complete fixture requirements, expected behavior and parameters.`,
            );
        if (!Object.keys(profile.resources.find((r) => r.id === test.resource)!.selector).length)
            throw Error(`${test.id}: specify a resource selector.`);
    }
    const fixtures =
        request.fixtures ??
        Object.fromEntries(testIds.map((x) => [x, { ready: true, identity: '' }]));
    return {
        profile,
        testIds,
        sequence,
        readiness: validateReadiness({ reviewed: true, fixtures }, profile.tests),
    };
}

import assert from 'node:assert/strict';
import { sha256 } from './memory-resource-identity';

export const nativeGenerationCase = 'native-renderer-generation-reset-reopen';
export const nativeCaseContract = {
    versionchange: {
        applicability: 'not-applicable',
        reason: 'NativeCaptureStore owns physical capture files and a disposable SQLite membership index; it has no IndexedDB database/versionchange event.',
        requiredCase: nativeGenerationCase,
    },
    'export-cancel': {
        boundary: 'trusted-main Save destination cancelled while the snapshot/export is owned',
    },
    'export-failure': {
        boundary:
            'trusted-main held Save destination, then actual stream read failure preserving the existing destination',
    },
} as const;
Object.values(nativeCaseContract).forEach(Object.freeze);
Object.freeze(nativeCaseContract);
export interface NativeCoverageContract {
    schema: 1;
    reviewed: true;
    sourceSHA256: string;
    platform: 'win32';
    arch: 'x64';
    electron: '44.5.1';
    backend: 'native-files-and-disposable-sqlite-index';
    cases: typeof nativeCaseContract;
}
/** Review is external metadata: never infer it from hashing the supplied document itself. */
export function parseNativeCoverage(
    bytes: Uint8Array,
    expectedSHA256: string,
    sourceSHA256: string,
) {
    assert.match(
        expectedSHA256,
        /^[a-f0-9]{64}$/,
        'Supply the independently reviewed native coverage digest.',
    );
    assert.equal(sha256(bytes), expectedSHA256, 'Native coverage contract bytes changed.');
    const contract = JSON.parse(Buffer.from(bytes).toString()) as NativeCoverageContract;
    assert.deepEqual(Object.keys(contract).sort(), [
        'arch',
        'backend',
        'cases',
        'electron',
        'platform',
        'reviewed',
        'schema',
        'sourceSHA256',
    ]);
    assert.equal(contract.schema, 1);
    assert.equal(
        contract.reviewed,
        true,
        'Native backend applicability requires independent review.',
    );
    assert.equal(contract.sourceSHA256, sourceSHA256);
    assert.equal(contract.platform, 'win32');
    assert.equal(contract.arch, 'x64');
    assert.equal(contract.electron, '44.5.1');
    assert.equal(contract.backend, 'native-files-and-disposable-sqlite-index');
    assert.deepEqual(contract.cases, nativeCaseContract);
    Object.values(contract.cases).forEach(Object.freeze);
    Object.freeze(contract.cases);
    Object.freeze(contract);
    return Object.freeze({ contract, sha256: expectedSHA256 });
}
export type ReviewedNativeCoverage = ReturnType<typeof parseNativeCoverage>;
export function nativeCoverageDraft(sourceSHA256: string) {
    return {
        schema: 1,
        reviewed: false,
        sourceSHA256,
        platform: 'win32',
        arch: 'x64',
        electron: '44.5.1',
        backend: 'native-files-and-disposable-sqlite-index',
        cases: nativeCaseContract,
    };
}

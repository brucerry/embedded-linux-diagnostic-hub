import assert from 'node:assert/strict';
import path from 'node:path';
import policy from './security-query-diagnostic-policy.json' with { type: 'json' };

// Inert, finite policy data: no environment reads, discovery or process launch on import.
export const queryRuntimeImages = Object.freeze(
    policy.runtimeImages.map((row) => Object.freeze({ ...row })),
);
const metadataNames = ['ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH'];
function metadata(environment) {
    const values = {};
    for (const name of metadataNames) {
        const names = Reflect.ownKeys(environment).filter(
            (key) => typeof key === 'string' && key.toUpperCase() === name.toUpperCase(),
        );
        assert(names.length === 1 && names[0] === name, 'Exact image metadata spelling required');
        const descriptor = Object.getOwnPropertyDescriptor(environment, name);
        assert(descriptor && Object.hasOwn(descriptor, 'value'), 'Image metadata must be data');
        assert(typeof descriptor.value === 'string', 'Image metadata must be a string');
        values[name] = descriptor.value;
    }
    return values;
}
export function selectQueryRuntime(environment) {
    const values = metadata(environment);
    assert(values.RUNNER_OS === 'Windows' && values.RUNNER_ARCH === 'X64', 'Exact image platform');
    const row = queryRuntimeImages.find(
        (candidate) =>
            candidate.imageOS === values.ImageOS && candidate.imageVersion === values.ImageVersion,
    );
    assert(row, 'Unreviewed query runtime image');
    return row;
}
export function requireQueryRuntimeSelection(value) {
    assert(value !== null && typeof value === 'object', 'Bound query runtime selection required');
    const fields = ['imageOS', 'imageVersion', 'node', 'arch', 'manifestCommit'];
    assert(
        Reflect.ownKeys(value).length === fields.length &&
            fields.every((key) =>
                Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'),
            ),
        'Exact query runtime selection fields required',
    );
    const row = queryRuntimeImages.find(
        (candidate) =>
            candidate.imageOS === value?.imageOS && candidate.imageVersion === value?.imageVersion,
    );
    assert(row, 'Unreviewed query runtime selection');
    // A bound selection has exactly the reviewed fields, including its manifest identity.
    assert(
        fields.every((key) => value[key] === row[key]),
        'Exact query runtime selection required',
    );
    return row;
}
export function queryRuntimePaths(selection, cache) {
    const row = requireQueryRuntimeSelection(selection);
    assert(
        typeof cache === 'string' && path.win32.isAbsolute(cache) && !cache.includes('\0'),
        'Exact tool cache required',
    );
    const directory = row.node.slice(1);
    return Object.freeze({
        executable: path.win32.join(cache, 'node', directory, row.arch, 'node.exe'),
        completeMarker: path.win32.join(cache, 'node', directory, row.arch + '.complete'),
    });
}
export function requireSelectedQueryVersion(selection, version, platform, arch) {
    const row = requireQueryRuntimeSelection(selection);
    // Compare without embedding untrusted values in an assertion message.
    assert(platform === 'win32' && arch === row.arch, 'Exact query runtime platform required');
    assert(version === row.node, 'Exact selected query runtime required');
    return row;
}
/** Early leaf rejection only; the durable parent selection must still be validated afterward. */
export function requireKnownQueryRuntime(version, platform, arch) {
    assert(
        platform === 'win32' &&
            arch === 'x64' &&
            queryRuntimeImages.some((row) => row.node === version && row.arch === arch),
        'Reviewed query runtime required before binding reads',
    );
}

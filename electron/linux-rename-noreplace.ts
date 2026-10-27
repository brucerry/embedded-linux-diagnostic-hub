/** Source-only ABI adapter. This module never loads a .node file or supplies execution authority. */
export interface LinuxRenameHost {
    platform: string;
    arch: string;
    napiVersion: number;
}
export type LinuxRenameNoReplace = (
    sourceParentFD: number,
    sourceName: string,
    destinationParentFD: number,
    destinationName: string,
) => void;
export const LINUX_RENAME_ABI = Object.freeze({
    abiVersion: 1,
    napiVersion: 8,
    statusVersion: 1,
    platform: 'linux',
    arch: 'x64',
} as const);
const codes = [
    '',
    'ERR_DH_RENAME_EXISTS',
    'ERR_DH_RENAME_UNSUPPORTED',
    'ERR_DH_RENAME_PERMISSION',
    'ERR_DH_RENAME_CROSS_DEVICE',
    'ERR_DH_RENAME_ARGUMENT',
    'ERR_DH_RENAME_BAD_FD',
    'ERR_DH_RENAME_UNKNOWN',
    'ERR_DH_RENAME_INTERRUPTED',
    'ERR_DH_RENAME_READ_ONLY',
    'ERR_DH_RENAME_BUSY',
] as const;
function refusal(code: string): never {
    const error = Error(code);
    Object.defineProperty(error, 'code', { value: code, enumerable: true });
    throw error;
}
function name(value: string) {
    if (
        typeof value !== 'string' ||
        !value ||
        value.length > 255 ||
        value === '.' ||
        value === '..' ||
        /[\\/\x00-\x1f\x7f]/.test(value) ||
        Buffer.byteLength(value, 'utf8') > 255
    )
        return false;
    for (let at = 0; at < value.length; at++) {
        const code = value.charCodeAt(at);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++at);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}
/** Caller must verify artifact provenance/path/hash BEFORE any separate, explicitly approved native load. */
export function checkedLinuxRenameBinding(
    module: unknown,
    host: LinuxRenameHost,
): LinuxRenameNoReplace {
    try {
        const fields = Object.getOwnPropertyDescriptors(host);
        if (
            Reflect.ownKeys(host).length !== 3 ||
            !['platform', 'arch', 'napiVersion'].every(
                (key) => fields[key] && Object.hasOwn(fields[key], 'value'),
            ) ||
            fields.platform.value !== 'linux' ||
            fields.arch.value !== 'x64' ||
            typeof fields.napiVersion.value !== 'number' ||
            !Number.isInteger(fields.napiVersion.value) ||
            fields.napiVersion.value < 8
        )
            return refusal('ERR_DH_RENAME_HOST');
    } catch {
        return refusal('ERR_DH_RENAME_HOST');
    }
    if (!module || typeof module !== 'object' || Array.isArray(module))
        return refusal('ERR_DH_RENAME_ABI');
    const fields = [
        'abiVersion',
        'napiVersion',
        'statusVersion',
        'platform',
        'arch',
        'renameNoReplace',
    ];
    let descriptors: PropertyDescriptorMap;
    try {
        if (
            Reflect.ownKeys(module).length !== fields.length ||
            Reflect.ownKeys(module).some((key) => typeof key !== 'string' || !fields.includes(key))
        )
            return refusal('ERR_DH_RENAME_ABI');
        descriptors = Object.getOwnPropertyDescriptors(module);
        for (const field of fields)
            if (
                !descriptors[field] ||
                !Object.hasOwn(descriptors[field], 'value') ||
                descriptors[field].get ||
                descriptors[field].set
            )
                return refusal('ERR_DH_RENAME_ABI');
    } catch {
        return refusal('ERR_DH_RENAME_ABI');
    }
    for (const [field, expected] of Object.entries(LINUX_RENAME_ABI))
        if (descriptors[field].value !== expected) return refusal('ERR_DH_RENAME_ABI');
    const invoke = descriptors.renameNoReplace.value as unknown;
    if (typeof invoke !== 'function') return refusal('ERR_DH_RENAME_ABI');
    return (sourceFD, sourceName, destinationFD, destinationName) => {
        if (
            ![sourceFD, destinationFD].every(
                (fd) => Number.isInteger(fd) && fd >= 0 && fd <= 0x7fffffff,
            ) ||
            !name(sourceName) ||
            !name(destinationName) ||
            (sourceFD === destinationFD && sourceName === destinationName)
        )
            return refusal('ERR_DH_RENAME_ARGUMENT');
        let status: unknown;
        try {
            status = Reflect.apply(invoke, undefined, [
                sourceFD,
                sourceName,
                destinationFD,
                destinationName,
            ]);
        } catch {
            return refusal('ERR_DH_RENAME_NATIVE_EXCEPTION');
        }
        // Never retry, including EINTR; only numeric zero is an acknowledged successful syscall.
        if (status === 0) return;
        if (
            typeof status !== 'number' ||
            !Number.isInteger(status) ||
            status < 1 ||
            status >= codes.length
        )
            return refusal('ERR_DH_RENAME_ACK');
        return refusal(codes[status]);
    };
}

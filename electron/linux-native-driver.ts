import {
    createLinuxNativeBackend,
    type LinuxNativeOps,
    type LinuxNativeWindow,
} from './linux-native-backend.ts';
import {
    checkedLinuxModelPlan,
    createLinuxNativeTransaction,
    type LinuxModelPlan,
} from './linux-transaction-model.ts';

function refuse(code: string): never {
    throw Error(code);
}
function data(object: object, name: PropertyKey): unknown {
    const field = Object.getOwnPropertyDescriptor(object, name);
    if (!field || !Object.hasOwn(field, 'value') || field.get || field.set)
        return refuse('ERR_DH_LINUX_DRIVER_HOST');
    return field.value;
}
function method(object: object, name: PropertyKey) {
    const fn = data(object, name);
    if (typeof fn !== 'function') return refuse('ERR_DH_LINUX_DRIVER_HOST');
    return (...args: unknown[]) => Reflect.apply(fn, object, args);
}
/** Capture host functions/constants before any await. This grants no provenance or native authority. */
export function captureLinuxNativeHost(input: LinuxNativeOps): LinuxNativeOps {
    try {
        const filesystem = data(input, 'fs') as object;
        const originalConstants = data(filesystem, 'constants') as object;
        const constants: Record<string, number> = Object.create(null);
        for (const key of Reflect.ownKeys(originalConstants)) {
            const value = data(originalConstants, key);
            if (typeof key !== 'string' || typeof value !== 'number' || !Number.isInteger(value))
                return refuse('ERR_DH_LINUX_DRIVER_HOST');
            constants[key] = value;
        }
        const fs: Record<string, unknown> = { constants: Object.freeze(constants) };
        for (const name of [
            'openSync',
            'fstatSync',
            'lstatSync',
            'readSync',
            'writeSync',
            'closeSync',
            'ftruncateSync',
            'fsyncSync',
            'mkdirSync',
            'readlinkSync',
            'realpathSync',
            'opendirSync',
            'statfsSync',
        ])
            fs[name] = method(filesystem, name);
        const host: Record<string, unknown> = { fs: Object.freeze(fs) };
        for (const key of ['platform', 'arch', 'pid', 'executable']) host[key] = data(input, key);
        for (const key of ['uid', 'euid', 'now', 'uuid', 'server', 'later', 'cancel'])
            host[key] = method(input, key);
        host.moveNoReplace =
            data(input, 'moveNoReplace') === null ? null : method(input, 'moveNoReplace');
        return Object.freeze(host) as unknown as LinuxNativeOps;
    } catch {
        return refuse('ERR_DH_LINUX_DRIVER_HOST');
    }
}

/** One bounded complete-folder transaction using the existing concrete backend.
 * Operations are mandatory: no implicit .node load, native host, process, installer entry or
 * fallback rename exists. Supplying operations is not native qualification/authorization.
 * The caller separately owns approved execution and any retained failure custody. */
export function createLinuxNativeDriver(
    input: LinuxModelPlan,
    window: LinuxNativeWindow,
    operations?: LinuxNativeOps,
) {
    if (!operations) return refuse('ERR_DH_LINUX_NATIVE_LOADER_UNADMITTED');
    let plan: LinuxModelPlan;
    try {
        plan = checkedLinuxModelPlan(input);
    } catch {
        return refuse('ERR_DH_LINUX_DRIVER_PLAN');
    }
    const ops = captureLinuxNativeHost(operations);
    if (!ops.moveNoReplace) return refuse('ERR_DH_LINUX_NATIVE_LOADER_UNADMITTED');
    if (ops.pid !== plan.owner.pid || ops.executable !== plan.owner.executable)
        return refuse('ERR_DH_LINUX_DRIVER_RUNTIME');
    let bounded: LinuxNativeWindow;
    try {
        bounded = {
            startedMs: data(window, 'startedMs') as number,
            deadlineMs: data(window, 'deadlineMs') as number,
        };
    } catch {
        return refuse('ERR_DH_LINUX_DRIVER_WINDOW');
    }
    const backend = createLinuxNativeBackend(plan, bounded, ops);
    const transaction = createLinuxNativeTransaction(backend.kernel, backend.effects);
    return Object.freeze({
        /** No second plan or retry can be supplied after construction. */
        run: (...args: never[]) => {
            if (args.length !== 0) return refuse('ERR_DH_LINUX_DRIVER_ARGUMENTS');
            return transaction.run(plan);
        },
        summary: () => transaction.summary(),
        diagnostics: () => backend.diagnostics(),
        capabilities: Object.freeze({
            nativeQualified: false as const,
            productionDispatch: false as const,
            operations: Object.freeze([
                'install',
                'repair',
                'update',
                'rollback',
                'resume',
            ] as const),
        }),
    });
}

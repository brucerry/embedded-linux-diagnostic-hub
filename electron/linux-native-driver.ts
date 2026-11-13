import {
    createLinuxNativeBackend,
    createLinuxNativePreparationBackend,
    type LinuxNativeOps,
    type LinuxNativeWindow,
} from './linux-native-backend.ts';
import {
    checkedLinuxModelPlan,
    checkedLinuxModelConfiguration,
    checkedLinuxModelView,
    linuxModelReviewSHA256,
    createLinuxNativeTransaction,
    assertLinuxFinalizePreimages,
    type LinuxModelPlan,
    type LinuxModelOwner,
    type LinuxModelView,
} from './linux-transaction-model.ts';
import type { LinuxReviewHost } from './linux-setup-review.ts';

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
        const remove = Object.getOwnPropertyDescriptor(input, 'unlinkOwned');
        host.unlinkOwned =
            !remove || (Object.hasOwn(remove, 'value') && remove.value === null)
                ? null
                : method(input, 'unlinkOwned');
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

/** Actual read-only snapshot preparation for the shipping complete-folder caller.
 * The old full-plan driver remains unchanged. No empty/inactive review is invented. */
export function prepareLinuxNativeDriver(
    input: {
        host: LinuxReviewHost;
        root: string;
        action: LinuxModelPlan['action'];
        dataHome: string;
        menu: boolean;
    },
    window: LinuxNativeWindow,
    operations: LinuxNativeOps,
    actualOwner: LinuxModelOwner,
) {
    const selected = structuredClone(input),
        ops = captureLinuxNativeHost(operations);
    if (ops.pid !== actualOwner.pid || ops.executable !== actualOwner.executable)
        return refuse('ERR_DH_LINUX_DRIVER_RUNTIME');
    const configuration = checkedLinuxModelConfiguration({
        host: selected.host,
        root: selected.root,
        action: selected.action,
        transactionId: ops.uuid(),
        installationId: ops.uuid(),
        owner: { ...actualOwner },
        ...(selected.menu ? { menu: { dataHome: selected.dataHome, selected: true } } : {}),
    });
    const backend = createLinuxNativePreparationBackend(
        configuration,
        window,
        ops,
        selected.dataHome,
    );
    let candidate: ReturnType<typeof backend.prepare> | undefined;
    let prepared: Awaited<ReturnType<typeof backend.prepare>> | undefined;
    let used = false;
    let transaction: ReturnType<typeof createLinuxNativeTransaction> | undefined;
    const requirePrepared = () => {
        if (!prepared) return refuse('ERR_DH_LINUX_DRIVER_PREPARATION');
        return prepared;
    };
    return Object.freeze({
        async inspect() {
            if (!candidate) {
                candidate = backend.prepare(); // Adopt the operation before its first await.
                prepared = await candidate;
                if (
                    selected.action !== 'finalize' &&
                    prepared.view.history?.cleanup?.seal &&
                    prepared.view.history.cleanup.seal.state !== 'published'
                )
                    return refuse('ERR_DH_LINUX_SEAL_RECOVERY_REQUIRED');
                if (selected.action === 'finalize')
                    assertLinuxFinalizePreimages(prepared.view, prepared.configuration);
                if (
                    selected.action === 'finalize' &&
                    (prepared.view.previous || prepared.view.history?.cleanup) &&
                    !ops.unlinkOwned
                )
                    return refuse('ERR_DH_LINUX_FINALIZE_UNLINK_REQUIRED');
                return structuredClone(prepared.view);
            }
            await candidate;
            const view = await backend.effects.observe(structuredClone(requirePrepared().scope));
            if (
                selected.action !== 'finalize' &&
                view.history?.cleanup?.seal &&
                view.history.cleanup.seal.state !== 'published'
            )
                return refuse('ERR_DH_LINUX_SEAL_RECOVERY_REQUIRED');
            if (selected.action === 'finalize')
                assertLinuxFinalizePreimages(view, requirePrepared().configuration);
            if (
                selected.action === 'finalize' &&
                (view.previous || view.history?.cleanup) &&
                !ops.unlinkOwned
            )
                return refuse('ERR_DH_LINUX_FINALIZE_UNLINK_REQUIRED');
            return view;
        },
        describe(view: LinuxModelView) {
            const captured = requirePrepared();
            checkedLinuxModelView(view, captured.configuration);
            return (
                'Diagnostic Hub Linux setup\nOperation: ' +
                selected.action +
                '\nApplication: ' +
                selected.root +
                '\nCandidate version: ' +
                view.source.manifest.version +
                '\nInstalled version: ' +
                (view.root?.manifest.version ?? 'none') +
                '\nSettings/reports: ' +
                selected.host.appData +
                '/DiagnosticHub/profiles/' +
                captured.configuration.installationId +
                (selected.action === 'finalize'
                    ? view.history?.cleanup?.seal && view.history.cleanup.seal.state !== 'published'
                        ? '\nFinish interrupted update confirmation. The previous application copy is already removed. Settings, reports and recovery records are retained. No application launch or new boot observation is performed.'
                        : view.previous || view.history?.cleanup
                          ? '\nConfirm the current no-menu app while it is ready, then remove only the previous application payload. Settings, reports and original recovery records are retained.'
                          : '\nConfirm this initial no-menu installation while its app is ready. Original records are retained; no previous payload exists.'
                    : '\nPrevious payloads are retained. No Finalize or removal is performed.')
            );
        },
        menuSelected(view: LinuxModelView) {
            return Boolean(view.root?.menu);
        },
        plan(view: LinuxModelView, menu: boolean) {
            const captured = requirePrepared();
            if (typeof menu !== 'boolean' || (!captured.configuration.menu && menu))
                return refuse('ERR_DH_LINUX_DRIVER_MENU_REVIEW_REQUIRED');
            const plan = checkedLinuxModelPlan({
                ...captured.configuration,
                ...(captured.configuration.menu
                    ? { menu: { ...captured.configuration.menu, selected: menu } }
                    : {}),
                consent: true,
                review: structuredClone(view),
                reviewSHA256: linuxModelReviewSHA256(view),
            });
            return plan;
        },
        async run(plan: LinuxModelPlan) {
            if (used) return refuse('ERR_DH_LINUX_DRIVER_CONSUMED');
            used = true;
            const captured = requirePrepared();
            const expected = {
                ...plan,
                consent: undefined,
                review: undefined,
                reviewSHA256: undefined,
            };
            const wanted = {
                ...captured.configuration,
                ...(plan.menu ? { menu: { ...plan.menu } } : {}),
                consent: undefined,
                review: undefined,
                reviewSHA256: undefined,
            };
            if (JSON.stringify(expected) !== JSON.stringify(wanted))
                return refuse('ERR_DH_LINUX_DRIVER_SELECTION_CHANGED');
            if (plan.menu) backend.selectMenu(plan.menu.selected);
            transaction = createLinuxNativeTransaction(backend.kernel, backend.effects);
            return transaction.run(plan);
        },
        diagnostics: () => ({
            backend: backend.diagnostics(),
            transaction: transaction?.summary() ?? null,
        }),
    });
}

/** Initial/no-menu current-payload uninstall; no implicit native load or generic cleanup fallback. */
export function prepareLinuxNativeUninstallDriver(
    input: { host: LinuxReviewHost; root: string },
    window: LinuxNativeWindow,
    operations: LinuxNativeOps,
    actualOwner: LinuxModelOwner,
) {
    const selected = structuredClone(input),
        ops = captureLinuxNativeHost(operations);
    if (ops.pid !== actualOwner.pid || ops.executable !== actualOwner.executable)
        return refuse('ERR_DH_LINUX_DRIVER_RUNTIME');
    const configuration = checkedLinuxModelConfiguration({
        host: selected.host,
        root: selected.root,
        action: 'uninstall-current',
        transactionId: ops.uuid(),
        installationId: ops.uuid(),
        owner: { ...actualOwner },
    });
    return createLinuxNativePreparationBackend(configuration, window, ops).initialUninstall();
}

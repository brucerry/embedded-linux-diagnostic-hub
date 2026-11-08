// Exact active component spans; source-binding assertion detects drift. Injected lexical state/IO only.
// This fixture models callback transitions, not React scheduling or a mounted browser.
import { catalogPage, type CatalogRow, type CaptureFilter } from '../../shared/capture-query';
import type { CaptureRepository } from '../../shared/capture-store';
export interface MemoryCaptureState {
    failure: string;
    catalogFailure: string;
    notice: string;
    rows: CatalogRow[];
    next: number | null;
    loading: boolean;
    busy: boolean;
    selected: Set<string>;
    cursor: number;
    back: number[];
    revision: number;
    confirmClear: boolean;
}
type Setters = {
    [K in keyof MemoryCaptureState as `set${Capitalize<K>}`]: (
        v: MemoryCaptureState[K] | ((old: MemoryCaptureState[K]) => MemoryCaptureState[K]),
    ) => void;
};
export interface CaptureCallbackContext {
    state: MemoryCaptureState;
    setters: Setters;
    store: CaptureRepository | null;
    props: { visible: boolean; running: boolean; onBusy(v: boolean): void };
    transport: 'serial' | 'ssh';
    filter: CaptureFilter;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const boundSourceSHA256 = '44d9c42ee7c00905e44e65234c44c554d79b8f0e11222d1e78b1589a7e5cfc5e';
export const boundSpans: readonly string[] = [
    "    useEffect(() => {\n        if (!props.visible || !store) return;\n        const controller = new AbortController();\n        setLoading(true);\n        void catalogPage(store, filter, cursor, controller.signal)\n            .then((page) => {\n                if (!controller.signal.aborted) {\n                    setRows(page.records);\n                    setNext(page.next);\n                    // Refreshing rows does not recover an export or partial-clear failure.\n                    setCatalogFailure('');\n                }\n            })\n            .catch((error) => {\n                if (!controller.signal.aborted) setCatalogFailure(message(error));\n            })\n            .finally(() => {\n                if (!controller.signal.aborted) setLoading(false);\n            });\n        return () => controller.abort();\n    }, [props.visible, store, filter, cursor, props.epoch, revision]);\n",
    '    const action = (value: boolean) => {\n        setBusy(value);\n        props.onBusy(value);\n    };\n',
    "    const clear = async (all: boolean) => {\n        if (!store || props.running || busy) return;\n        action(true);\n        setFailure('');\n        let deleted = 0;\n        try {\n            if (all) {\n                const pin = await store.pin(),\n                    through = pin.through;\n                await pin.release();\n                let after = 0;\n                while (true) {\n                    const page = await store.page(after, 100, through);\n                    for (const capture of page.records)\n                        if (capture.header.transport === transport) {\n                            await store.delete(capture.id);\n                            deleted++;\n                        }\n                    if (page.next === null) break;\n                    after = page.next;\n                }\n                setSelected(new Set());\n            } else {\n                for (const id of [...selected]) {\n                    await store.delete(id);\n                    deleted++;\n                }\n                setSelected(new Set());\n            }\n            setNotice(\n                'Deleted ' +\n                    deleted +\n                    ' stored ' +\n                    label +\n                    ' capture' +\n                    (deleted === 1 ? '' : 's') +\n                    '.',\n            );\n            setConfirmClear(false);\n        } catch (error) {\n            setFailure(\n                'Deleted ' + deleted + ' captures before cleanup stopped: ' + message(error),\n            );\n        } finally {\n            setCursor(0);\n            setBack([]);\n            setRevision((value) => value + 1);\n            action(false);\n        }\n    };\n",
    '            {(failure || catalogFailure) && (\n                <p role="alert" className="automation-warning">\n                    {[failure, catalogFailure].filter(Boolean).join(\' \u00b7 \')}\n                </p>\n            )}\n',
];
export function bindCaptureCallbacks(context: CaptureCallbackContext) {
    const { store, props, transport, filter } = context;
    const label = transport === 'ssh' ? 'SSH' : 'Serial';
    const { failure, catalogFailure, notice, busy, selected, cursor } = context.state;
    const {
        setFailure,
        setCatalogFailure,
        setNotice,
        setRows,
        setNext,
        setLoading,
        setBusy,
        setSelected,
        setCursor,
        setBack,
        setRevision,
        setConfirmClear,
    } = context.setters;
    const refreshCatalog = () => {
        if (!props.visible || !store) return;
        const controller = new AbortController();
        setLoading(true);
        void catalogPage(store, filter, cursor, controller.signal)
            .then((page) => {
                if (!controller.signal.aborted) {
                    setRows(page.records);
                    setNext(page.next);
                    // Refreshing rows does not recover an export or partial-clear failure.
                    setCatalogFailure('');
                }
            })
            .catch((error) => {
                if (!controller.signal.aborted) setCatalogFailure(message(error));
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    };
    const action = (value: boolean) => {
        setBusy(value);
        props.onBusy(value);
    };
    const clear = async (all: boolean) => {
        if (!store || props.running || busy) return;
        action(true);
        setFailure('');
        let deleted = 0;
        try {
            if (all) {
                const pin = await store.pin(),
                    through = pin.through;
                await pin.release();
                let after = 0;
                while (true) {
                    const page = await store.page(after, 100, through);
                    for (const capture of page.records)
                        if (capture.header.transport === transport) {
                            await store.delete(capture.id);
                            deleted++;
                        }
                    if (page.next === null) break;
                    after = page.next;
                }
                setSelected(new Set());
            } else {
                for (const id of [...selected]) {
                    await store.delete(id);
                    deleted++;
                }
                setSelected(new Set());
            }
            setNotice(
                'Deleted ' +
                    deleted +
                    ' stored ' +
                    label +
                    ' capture' +
                    (deleted === 1 ? '' : 's') +
                    '.',
            );
            setConfirmClear(false);
        } catch (error) {
            setFailure(
                'Deleted ' + deleted + ' captures before cleanup stopped: ' + message(error),
            );
        } finally {
            setCursor(0);
            setBack([]);
            setRevision((value) => value + 1);
            action(false);
        }
    };

    return {
        clear,
        refreshCatalog,
        message: [failure, catalogFailure].filter(Boolean).join(' · '),
    };
}

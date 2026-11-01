// Generated from exact active hook spans. The regression asserts each span against current source.
// Injected lexical state/IO only; no React mount/effect scheduling, native/archive opening or deletion.
import { CaptureStorageError } from '../../shared/capture-store';
import { consoleCatalogPage, consoleFilter, type ConsoleFilter } from '../../shared/console-query';
import { ConsoleResultsOwner, readConsolePreview } from '../../src/features/automation/capture/console-results-owner';
import { ConsoleExportDiagnostic } from '../../src/features/automation/capture/console-export-diagnostic';
import type { ConsoleResultsViewProps, ConsolePreview, ConsoleReportFormat, ConsoleExportSelection } from '../../src/features/automation/capture/console-results-view';
import type { ConsoleReportScope } from '../../shared/console-report';
import type { ConsoleExportJob } from '../../src/features/automation/capture/console-export';
import type { BrowserExportDiagnostic } from '../../src/features/automation/capture/browser-export';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export interface MemoryViewState {
 status: ConsoleResultsViewProps['status']; failure: string|null; catalogFailure: string|null;
 rows: ConsoleResultsViewProps['rows']; next: string|null; mode: 'scan'|'indexed';
 preview: ConsolePreview|null; previewLoading: boolean; operation: 'export'|'delete'|null;
 revision: number; exportStatus: string|null; cleanupDiagnostic: ConsoleExportDiagnostic['snapshot'];
 selected: Set<string>; notice: string|null; confirmation: 'selected'|'all'|null;
 cursor: string|undefined; back: (string|undefined)[];
}
type Setters = { [K in keyof MemoryViewState as `set${Capitalize<K>}`]: (value:MemoryViewState[K]|((old:MemoryViewState[K])=>MemoryViewState[K]))=>void };
export interface CallbackContext {
 state: MemoryViewState; setters: Setters;
 options: {visible:boolean}; owner:ConsoleResultsOwner; ready:boolean;
 current:{current:ConsoleResultsOwner|null}; latest:{current:{visible:boolean;running:boolean}};
 activeOperation:{current:'export'|'delete'|null}; armReservation:{current:symbol|null};
 previewGeneration:{current:number}; exportDiagnosticOwner:{current:ConsoleExportDiagnostic};
 applied:ConsoleFilter; filter:ConsoleFilter; format:ConsoleReportFormat; selection:ConsoleExportSelection;
 startConsoleExport:(format:ConsoleReportFormat,scope:ConsoleReportScope,diagnostic?:(v:BrowserExportDiagnostic)=>void)=>Promise<ConsoleExportJob>;
}
export const boundSourceSHA256 = 'cafb9d2cd56d3da00b4968d1e7436fb7872268758cb23c108671e6072b27da48';
export const boundSpans: readonly string[] = ["    const isCurrent = (value: ConsoleResultsOwner) =>\n        current.current === value && latest.current.visible;\n    const reportFailure = (error: unknown) => {\n        setFailure(message(error));\n        if (error instanceof CaptureStorageError && error.code === 'unsupported')\n            setStatus('unsupported');\n    };\n", "    useEffect(() => {\n        if (\n            !options.visible ||\n            !owner ||\n            !ready ||\n            activeOperation.current ||\n            armReservation.current\n        )\n            return;\n        const controller = new AbortController();\n        setStatus('loading');\n        void owner\n            .run(async (archive, check) => {\n                check();\n                return consoleCatalogPage(archive, applied, cursor, controller.signal);\n            })\n            .then((page) => {\n                if (isCurrent(owner) && !controller.signal.aborted) {\n                    setRows(page.captures);\n                    setNext(page.next);\n                    setMode(page.mode);\n                    setStatus('ready');\n                    // A successful read only recovers catalog errors, not a failed action.\n                    setCatalogFailure(null);\n                }\n            })\n            .catch((error) => {\n                if (isCurrent(owner) && !controller.signal.aborted) {\n                    setStatus(\n                        error instanceof CaptureStorageError && error.code === 'unsupported'\n                            ? 'unsupported'\n                            : 'error',\n                    );\n                    setCatalogFailure(message(error));\n                }\n            });\n        return () => controller.abort();\n    }, [options.visible, owner, ready, applied, cursor, revision, options.revision, completedRuns]);\n", "    const clearPreview = () => {\n        previewGeneration.current++;\n        setPreview(null);\n        setPreviewLoading(false);\n    };\n    const begin = (kind: 'export' | 'delete') => {\n        const value = current.current;\n        if (\n            !value ||\n            !ready ||\n            latest.current.running ||\n            armReservation.current ||\n            activeOperation.current ||\n            status !== 'ready' ||\n            previewLoading\n        )\n            return null;\n        activeOperation.current = kind;\n        setOperation(kind);\n        setFailure(null);\n        return value;\n    };\n    const finish = (value: ConsoleResultsOwner) => {\n        activeOperation.current = null;\n        if (isCurrent(value)) {\n            setOperation(null);\n            setRevision((n) => n + 1);\n        }\n    };\n    const exportClicked = async () => {\n        const value = begin('export');\n        if (!value) return;\n        const generation = exportDiagnosticOwner.current.begin(value);\n        if (!generation) {\n            reportFailure(new CaptureStorageError('busy', 'Previous export cleanup is still pending.'));\n            return;\n        }\n        const scope =\n            selection === 'selected'\n                ? { ids: [...selected], title: 'Selected console flows' }\n                : selection === 'filtered'\n                  ? { filter: consoleFilter(filter), title: 'Filtered console flows' }\n                  : { title: 'All retained console flows' };\n        setExportStatus('Preparing complete retained console evidence\u2026');\n        try {\n            const result = await value.export(() => startConsoleExport(format, scope, (diagnostic) => {\n                if (exportDiagnosticOwner.current.update(value, generation, diagnostic)) {\n                    setCleanupDiagnostic(exportDiagnosticOwner.current.snapshot);\n                    setExportStatus(diagnostic.retirement === 'blocked'\n                        ? 'Export cleanup is not acknowledged; results operations remain blocked.'\n                        : 'Waiting for export cleanup acknowledgement.');\n                }\n            }));\n            if (exportDiagnosticOwner.current.owns(value, generation)) {\n                if (isCurrent(value)) setFailure(null);\n                setExportStatus(\n                    result.state === 'saved'\n                        ? 'Export saved.'\n                        : result.state === 'cancelled'\n                          ? 'Export cancelled.'\n                          : 'Complete export sent to the browser. Check Downloads for final save status.',\n                );\n            }\n        } catch (error) {\n            if (exportDiagnosticOwner.current.owns(value, generation)) {\n                if (isCurrent(value)) reportFailure(error);\n                setExportStatus('Export did not complete. Retained evidence is unchanged.');\n            }\n        } finally {\n            if (exportDiagnosticOwner.current.finish(value, generation)) setCleanupDiagnostic(null);\n            finish(value);\n        }\n    };\n    const deleteConfirmed = async () => {\n        if (!confirmation) return;\n        const value = begin('delete'),\n            all = confirmation === 'all';\n        if (!value) return;\n        let deleted = 0;\n        try {\n            await value.run(async (archive, check) => {\n                const remove = async (id: string) => {\n                    check();\n                    await archive.delete(id);\n                    deleted++;\n                    if (isCurrent(value))\n                        setSelected((old) => {\n                            const result = new Set(old);\n                            result.delete(id);\n                            return result;\n                        });\n                };\n                if (!all) {\n                    for (const id of [...selected].sort()) await remove(id);\n                } else {\n                    let after: string | undefined;\n                    while (true) {\n                        check();\n                        const page = await archive.list(after, 25);\n                        for (const row of page.captures) await remove(row.header.id);\n                        if (page.next === null) break;\n                        if (!page.captures.length || page.next <= (after ?? ''))\n                            throw new CaptureStorageError(\n                                'integrity',\n                                'Console deletion cursor did not advance.',\n                            );\n                        after = page.next;\n                    }\n                }\n            });\n            if (isCurrent(value)) {\n                setNotice(\n                    'Deleted ' + deleted + ' retained console flow' + (deleted === 1 ? '.' : 's.'),\n                );\n                setConfirmation(null);\n            }\n        } catch (error) {\n            if (isCurrent(value))\n                setFailure(\n                    'Deleted ' + deleted + ' flows before cleanup stopped: ' + message(error),\n                );\n        } finally {\n            if (isCurrent(value)) {\n                clearPreview();\n                setCursor(undefined);\n                setBack([]);\n            }\n            finish(value);\n        }\n    };\n", "        onPreview(id) {\n            const value = current.current;\n            if (!value || !ready || activeOperation.current || armReservation.current) return;\n            const generation = ++previewGeneration.current;\n            setPreviewLoading(true);\n            setFailure(null);\n            void value\n                .run((archive, check) =>\n                    readConsolePreview(archive, id, () => {\n                        check();\n                        if (generation !== previewGeneration.current)\n                            throw new CaptureStorageError('busy', 'Console preview changed.');\n                    }),\n                )\n                .then((result) => {\n                    if (isCurrent(value) && generation === previewGeneration.current)\n                        setPreview(result);\n                })\n                .catch((error) => {\n                    if (isCurrent(value) && generation === previewGeneration.current)\n                        reportFailure(error);\n                })\n                .finally(() => {\n                    if (isCurrent(value) && generation === previewGeneration.current)\n                        setPreviewLoading(false);\n                });\n        },\n", "        message: [failure, catalogFailure, cleanupDiagnostic?.message].filter(Boolean).join(' \u00b7 ') || null,\n"];
export function bindResultsCallbacks(context:CallbackContext) {
 const {options,owner,ready,current,latest,activeOperation,armReservation,previewGeneration,exportDiagnosticOwner,applied,filter,format,selection,startConsoleExport}=context;
 const {status,failure,catalogFailure,cleanupDiagnostic,previewLoading,selected,confirmation,cursor}=context.state;
 const {setStatus,setFailure,setCatalogFailure,setRows,setNext,setMode,setPreview,setPreviewLoading,setOperation,setRevision,setExportStatus,setCleanupDiagnostic,setSelected,setNotice,setConfirmation,setCursor,setBack}=context.setters;
    const isCurrent = (value: ConsoleResultsOwner) =>
        current.current === value && latest.current.visible;
    const reportFailure = (error: unknown) => {
        setFailure(message(error));
        if (error instanceof CaptureStorageError && error.code === 'unsupported')
            setStatus('unsupported');
    };
    const refreshCatalog = () => {
        if (
            !options.visible ||
            !owner ||
            !ready ||
            activeOperation.current ||
            armReservation.current
        )
            return;
        const controller = new AbortController();
        setStatus('loading');
        void owner
            .run(async (archive, check) => {
                check();
                return consoleCatalogPage(archive, applied, cursor, controller.signal);
            })
            .then((page) => {
                if (isCurrent(owner) && !controller.signal.aborted) {
                    setRows(page.captures);
                    setNext(page.next);
                    setMode(page.mode);
                    setStatus('ready');
                    // A successful read only recovers catalog errors, not a failed action.
                    setCatalogFailure(null);
                }
            })
            .catch((error) => {
                if (isCurrent(owner) && !controller.signal.aborted) {
                    setStatus(
                        error instanceof CaptureStorageError && error.code === 'unsupported'
                            ? 'unsupported'
                            : 'error',
                    );
                    setCatalogFailure(message(error));
                }
            });
        return () => controller.abort();
    };
    const clearPreview = () => {
        previewGeneration.current++;
        setPreview(null);
        setPreviewLoading(false);
    };
    const begin = (kind: 'export' | 'delete') => {
        const value = current.current;
        if (
            !value ||
            !ready ||
            latest.current.running ||
            armReservation.current ||
            activeOperation.current ||
            status !== 'ready' ||
            previewLoading
        )
            return null;
        activeOperation.current = kind;
        setOperation(kind);
        setFailure(null);
        return value;
    };
    const finish = (value: ConsoleResultsOwner) => {
        activeOperation.current = null;
        if (isCurrent(value)) {
            setOperation(null);
            setRevision((n) => n + 1);
        }
    };
    const exportClicked = async () => {
        const value = begin('export');
        if (!value) return;
        const generation = exportDiagnosticOwner.current.begin(value);
        if (!generation) {
            reportFailure(new CaptureStorageError('busy', 'Previous export cleanup is still pending.'));
            return;
        }
        const scope =
            selection === 'selected'
                ? { ids: [...selected], title: 'Selected console flows' }
                : selection === 'filtered'
                  ? { filter: consoleFilter(filter), title: 'Filtered console flows' }
                  : { title: 'All retained console flows' };
        setExportStatus('Preparing complete retained console evidence…');
        try {
            const result = await value.export(() => startConsoleExport(format, scope, (diagnostic) => {
                if (exportDiagnosticOwner.current.update(value, generation, diagnostic)) {
                    setCleanupDiagnostic(exportDiagnosticOwner.current.snapshot);
                    setExportStatus(diagnostic.retirement === 'blocked'
                        ? 'Export cleanup is not acknowledged; results operations remain blocked.'
                        : 'Waiting for export cleanup acknowledgement.');
                }
            }));
            if (exportDiagnosticOwner.current.owns(value, generation)) {
                if (isCurrent(value)) setFailure(null);
                setExportStatus(
                    result.state === 'saved'
                        ? 'Export saved.'
                        : result.state === 'cancelled'
                          ? 'Export cancelled.'
                          : 'Complete export sent to the browser. Check Downloads for final save status.',
                );
            }
        } catch (error) {
            if (exportDiagnosticOwner.current.owns(value, generation)) {
                if (isCurrent(value)) reportFailure(error);
                setExportStatus('Export did not complete. Retained evidence is unchanged.');
            }
        } finally {
            if (exportDiagnosticOwner.current.finish(value, generation)) setCleanupDiagnostic(null);
            finish(value);
        }
    };
    const deleteConfirmed = async () => {
        if (!confirmation) return;
        const value = begin('delete'),
            all = confirmation === 'all';
        if (!value) return;
        let deleted = 0;
        try {
            await value.run(async (archive, check) => {
                const remove = async (id: string) => {
                    check();
                    await archive.delete(id);
                    deleted++;
                    if (isCurrent(value))
                        setSelected((old) => {
                            const result = new Set(old);
                            result.delete(id);
                            return result;
                        });
                };
                if (!all) {
                    for (const id of [...selected].sort()) await remove(id);
                } else {
                    let after: string | undefined;
                    while (true) {
                        check();
                        const page = await archive.list(after, 25);
                        for (const row of page.captures) await remove(row.header.id);
                        if (page.next === null) break;
                        if (!page.captures.length || page.next <= (after ?? ''))
                            throw new CaptureStorageError(
                                'integrity',
                                'Console deletion cursor did not advance.',
                            );
                        after = page.next;
                    }
                }
            });
            if (isCurrent(value)) {
                setNotice(
                    'Deleted ' + deleted + ' retained console flow' + (deleted === 1 ? '.' : 's.'),
                );
                setConfirmation(null);
            }
        } catch (error) {
            if (isCurrent(value))
                setFailure(
                    'Deleted ' + deleted + ' flows before cleanup stopped: ' + message(error),
                );
        } finally {
            if (isCurrent(value)) {
                clearPreview();
                setCursor(undefined);
                setBack([]);
            }
            finish(value);
        }
    };
    const previewActions:Pick<ConsoleResultsViewProps,'onPreview'>={
        onPreview(id) {
            const value = current.current;
            if (!value || !ready || activeOperation.current || armReservation.current) return;
            const generation = ++previewGeneration.current;
            setPreviewLoading(true);
            setFailure(null);
            void value
                .run((archive, check) =>
                    readConsolePreview(archive, id, () => {
                        check();
                        if (generation !== previewGeneration.current)
                            throw new CaptureStorageError('busy', 'Console preview changed.');
                    }),
                )
                .then((result) => {
                    if (isCurrent(value) && generation === previewGeneration.current)
                        setPreview(result);
                })
                .catch((error) => {
                    if (isCurrent(value) && generation === previewGeneration.current)
                        reportFailure(error);
                })
                .finally(() => {
                    if (isCurrent(value) && generation === previewGeneration.current)
                        setPreviewLoading(false);
                });
        },
    };
    return {refreshCatalog,exportClicked,deleteConfirmed,clearPreview,...previewActions,
        message: [failure, catalogFailure, cleanupDiagnostic?.message].filter(Boolean).join(' · ') || null,
    };
}

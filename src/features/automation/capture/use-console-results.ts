import { useEffect, useRef, useState } from 'react';
import { CaptureStorageError } from '../../../../shared/capture-store';
import {
    consoleCatalogPage,
    consoleFilter,
    type ConsoleFilter,
} from '../../../../shared/console-query';
import { openConsoleArchive } from './console-archive';
import { startConsoleExport } from './console-export';
import { ConsoleResultsOwner, readConsolePreview } from './console-results-owner';
import type {
    ConsoleResultsViewProps,
    ConsolePreview,
    ConsoleExportSelection,
    ConsoleReportFormat,
} from './console-results-view';

interface Options {
    visible: boolean;
    running: boolean;
    revision: number;
    onBusy(value: boolean): void;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export interface ConsoleResultsAdmission {
    quiesce(): Promise<() => void>;
}
export function useConsoleResults(
    options: Options,
): ConsoleResultsViewProps & ConsoleResultsAdmission {
    const latest = useRef(options);
    latest.current = options;
    const current = useRef<ConsoleResultsOwner | null>(null),
        disposal = useRef(Promise.resolve()),
        busyOwners = useRef(new Set<symbol>());
    const closingOwners = useRef(new Set<ConsoleResultsOwner>());
    const retiredOwners = useRef(new WeakSet<ConsoleResultsOwner>());
    const armReservation = useRef<symbol | null>(null);
    const [owner, setOwner] = useState<ConsoleResultsOwner | null>(null),
        [ready, setReady] = useState(false),
        [reopen, setReopen] = useState(0);
    const [status, setStatus] = useState<ConsoleResultsViewProps['status']>('loading'),
        [failure, setFailure] = useState<string | null>(null),
        [notice, setNotice] = useState<string | null>(null);
    const [rows, setRows] = useState<ConsoleResultsViewProps['rows']>([]),
        [mode, setMode] = useState<'scan' | 'indexed'>('scan');
    const [filter, setFilter] = useState<ConsoleFilter>({}),
        [applied, setApplied] = useState<ConsoleFilter>({});
    const [cursor, setCursor] = useState<string | undefined>(),
        [back, setBack] = useState<(string | undefined)[]>([]),
        [next, setNext] = useState<string | null>(null),
        [revision, setRevision] = useState(0);
    const previousRunning = useRef(options.running);
    const [completedRuns, setCompletedRuns] = useState(0);
    const [selected, setSelected] = useState(new Set<string>()),
        [preview, setPreview] = useState<ConsolePreview | null>(null),
        [previewLoading, setPreviewLoading] = useState(false);
    const previewGeneration = useRef(0);
    const [format, setFormat] = useState<ConsoleReportFormat>('json'),
        [selection, setSelection] = useState<ConsoleExportSelection>('filtered'),
        [exportStatus, setExportStatus] = useState<string | null>(null);
    const [operation, setOperation] = useState<'export' | 'delete' | null>(null),
        activeOperation = useRef<'export' | 'delete' | null>(null);
    const [confirmation, setConfirmation] = useState<'selected' | 'all' | null>(null);
    const isCurrent = (value: ConsoleResultsOwner) =>
        current.current === value && latest.current.visible;
    const reportFailure = (error: unknown) => {
        setFailure(message(error));
        if (error instanceof CaptureStorageError && error.code === 'unsupported')
            setStatus('unsupported');
    };
    const retire = (value: ConsoleResultsOwner) => {
        if (retiredOwners.current.has(value)) return disposal.current;
        retiredOwners.current.add(value);
        closingOwners.current.add(value);
        const closing = value.close();
        void closing.then(() => closingOwners.current.delete(value)).catch(() => {});
        disposal.current = Promise.all([disposal.current, closing]).then(() => {});
        void disposal.current.catch(() => {});
        return disposal.current;
    };
    useEffect(() => {
        const timer = setTimeout(() => setApplied(filter), 250);
        return () => clearTimeout(timer);
    }, [filter]);
    useEffect(() => {
        // Arming must not itself admit a catalog read ahead of the native writer.
        // Completion still refreshes failed flows with no recorded command result.
        if (previousRunning.current && !options.running) setCompletedRuns((n) => n + 1);
        previousRunning.current = options.running;
    }, [options.running]);
    useEffect(() => {
        if (!options.visible || armReservation.current) return;
        let alive = true;
        const token = Symbol('console results view');
        const busy = (value: boolean) => {
            if (value) busyOwners.current.add(token);
            else busyOwners.current.delete(token);
            latest.current.onBusy(busyOwners.current.size > 0);
        };
        const previous = disposal.current;
        const value = new ConsoleResultsOwner(async () => {
            await previous;
            return openConsoleArchive();
        }, busy);
        current.current = value;
        setOwner(value);
        setReady(false);
        setStatus('loading');
        setFailure(null);
        void value.ready
            .then(() => {
                if (alive) {
                    setReady(true);
                    setStatus('ready');
                    setOperation(null);
                }
            })
            .catch((error) => {
                if (alive) {
                    setStatus(
                        error instanceof CaptureStorageError && error.code === 'unsupported'
                            ? 'unsupported'
                            : 'error',
                    );
                    setFailure(message(error));
                }
            });
        return () => {
            alive = false;
            previewGeneration.current++;
            if (current.current === value) current.current = null;
            const closing = retire(value);
            // Keep a failed cleanup observable and busy; reopening awaits this same rejected boundary.
            void closing.catch((error) =>
                console.error('Console results cleanup:', message(error)),
            );
        };
    }, [options.visible, reopen]);
    useEffect(() => {
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
                    setFailure(null);
                }
            })
            .catch((error) => {
                if (isCurrent(owner) && !controller.signal.aborted) {
                    setStatus('error');
                    reportFailure(error);
                }
            });
        return () => controller.abort();
    }, [options.visible, owner, ready, applied, cursor, revision, options.revision, completedRuns]);
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
        const scope =
            selection === 'selected'
                ? { ids: [...selected], title: 'Selected console flows' }
                : selection === 'filtered'
                  ? { filter: consoleFilter(filter), title: 'Filtered console flows' }
                  : { title: 'All retained console flows' };
        setExportStatus('Preparing complete retained console evidence…');
        try {
            const result = await value.export(() => startConsoleExport(format, scope));
            if (isCurrent(value))
                setExportStatus(
                    result.state === 'saved'
                        ? 'Export saved.'
                        : result.state === 'cancelled'
                          ? 'Export cancelled.'
                          : 'Complete export sent to the browser. Check Downloads for final save status.',
                );
        } catch (error) {
            if (isCurrent(value)) {
                reportFailure(error);
                setExportStatus('Export did not complete. Retained evidence is unchanged.');
            }
        } finally {
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
    return {
        async quiesce() {
            if (armReservation.current || activeOperation.current)
                throw new CaptureStorageError(
                    'busy',
                    'Wait for the current console results operation.',
                );
            const token = Symbol('console writer admission');
            armReservation.current = token;
            const value = current.current;
            if (value) {
                current.current = null;
                setOwner(null);
                setReady(false);
                previewGeneration.current++;
                clearPreview();
                retire(value);
            }
            try {
                // Abort only fences future work; this joins actual requests/returns/disposal.
                await disposal.current;
            } catch (error) {
                if (armReservation.current === token) {
                    armReservation.current = null;
                    setReopen((n) => n + 1);
                }
                throw error;
            }
            return () => {
                if (armReservation.current !== token) return;
                armReservation.current = null;
                setReopen((n) => n + 1);
            };
        },
        status,
        message: failure,
        notice,
        rows,
        selectedIds: selected,
        preview,
        previewLoading,
        page: back.length + 1,
        canPrevious: back.length > 0,
        canNext: next !== null,
        catalogMode: mode,
        filter,
        running: options.running,
        operation,
        exportFormat: format,
        exportSelection: selection,
        exportStatus,
        deletionConfirmation: confirmation,
        onRefresh() {
            if (armReservation.current) return;
            clearPreview();
            if (closingOwners.current.size) {
                // Refresh is an explicit cleanup retry; no new repository opens through a failed fence.
                const retry = Promise.all(
                    [...closingOwners.current].map((value) => value.close()),
                ).then(() => {
                    closingOwners.current.clear();
                    setReopen((n) => n + 1);
                });
                disposal.current = retry;
                void retry.catch(reportFailure);
            } else if (!ready) setReopen((n) => n + 1);
            else setRevision((n) => n + 1);
        },
        onFilter(input) {
            try {
                setFilter(consoleFilter(input));
                setCursor(undefined);
                setBack([]);
                clearPreview();
            } catch (error) {
                reportFailure(error);
            }
        },
        onSelect(id, checked) {
            setSelected((old) => {
                if (checked && !old.has(id) && old.size >= 1000) {
                    setFailure(
                        'Select at most 1000 console flows, or export all/filtered evidence.',
                    );
                    return old;
                }
                const result = new Set(old);
                if (checked) result.add(id);
                else result.delete(id);
                return result;
            });
        },
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
        onClosePreview: clearPreview,
        onPrevious() {
            if (!back.length || activeOperation.current) return;
            clearPreview();
            setCursor(back.at(-1));
            setBack(back.slice(0, -1));
        },
        onNext() {
            if (!next || activeOperation.current) return;
            clearPreview();
            setBack([...back, cursor]);
            setCursor(next);
        },
        onFormat: setFormat,
        onExportSelection: setSelection,
        onExport() {
            void exportClicked();
        },
        onCancelExport() {
            const value = current.current;
            if (value)
                void value.cancelExport().catch((error) => {
                    if (isCurrent(value)) reportFailure(error);
                });
        },
        onClearSelected() {
            setConfirmation('selected');
        },
        onClearAll() {
            setConfirmation('all');
        },
        onConfirmClear() {
            void deleteConfirmed();
        },
        onKeepCaptures() {
            setConfirmation(null);
        },
    };
}

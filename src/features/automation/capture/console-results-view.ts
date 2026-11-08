import type { ConsoleRecord, ConsoleSnapshot } from '../../../../shared/console-journal';
import type { ConsoleFilter } from '../../../../shared/console-query';

/** Passive presentation boundary. The controller owns storage, export and confirmation. */
export type ConsoleReportFormat = 'json' | 'csv' | 'markdown' | 'text';
export type ConsoleExportSelection = 'selected' | 'filtered' | 'all';
export interface ConsolePreview {
    capture: ConsoleSnapshot;
    /** A bounded prefix only. Export always reads the complete retained journal. */
    records: readonly ConsoleRecord[];
    shownBytes: number;
    clipped: boolean;
}
export interface ConsoleResultsViewProps {
    status: 'loading' | 'ready' | 'unsupported' | 'error';
    message: string | null;
    notice: string | null;
    /** At most 25 metadata rows; UUID ordering is a catalog cursor, not time ordering. */
    rows: readonly ConsoleSnapshot[];
    selectedIds: ReadonlySet<string>;
    preview: ConsolePreview | null;
    previewLoading: boolean;
    page: number;
    canPrevious: boolean;
    canNext: boolean;
    catalogMode: 'scan' | 'indexed';
    filter: ConsoleFilter;
    running: boolean;
    operation: 'export' | 'delete' | null;
    exportFormat: ConsoleReportFormat;
    exportSelection: ConsoleExportSelection;
    exportStatus: string | null;
    deletionConfirmation: 'selected' | 'all' | null;
    onRefresh(): void;
    onFilter(filter: ConsoleFilter): void;
    onSelect(id: string, selected: boolean): void;
    onPreview(id: string): void;
    onClosePreview(): void;
    onPrevious(): void;
    onNext(): void;
    onFormat(format: ConsoleReportFormat): void;
    onExportSelection(selection: ConsoleExportSelection): void;
    onExport(): void;
    onCancelExport(): void;
    /** These request confirmation from the controller; the view never deletes. */
    onClearSelected(): void;
    onClearAll(): void;
    onConfirmClear(): void;
    onKeepCaptures(): void;
}

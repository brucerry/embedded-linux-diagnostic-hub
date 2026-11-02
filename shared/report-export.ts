/** Report publication and resource retirement are separate acknowledgements. */
export interface ReportExportStatus {
    id: string;
    filename: string;
    publication: 'unpublished' | 'pending' | 'uncertain' | 'published';
    retirement: 'pending' | 'blocked' | 'unknown' | 'acknowledged';
    cancelRequested: boolean;
    primary?: string;
    cleanup: string[];
    outcome?: 'saved' | 'cancelled' | 'failed';
}
export function reportExportMessage(value: ReportExportStatus): string {
    const publication = value.publication === 'published' ? 'Report saved' :
        value.publication === 'uncertain' ? 'Report publication is uncertain' :
        value.publication === 'pending' ? 'Report publication pending' :
        value.outcome === 'cancelled' ? 'Report export cancelled' :
        value.outcome === 'failed' ? 'Report export failed; no report published' : 'Report export pending';
    return publication + ' · ' + value.filename +
        (value.retirement === 'acknowledged' ? '' : value.retirement === 'unknown'
            ? ' · native retirement status unknown; further export blocked' : value.retirement === 'blocked'
            ? ' · cleanup unconfirmed; export and normal quit remain blocked' : ' · retirement pending') +
        (value.cancelRequested && !value.outcome ? ' · cancellation requested' : '') +
        (value.primary ? ' · ' + value.primary : '') +
        (value.cleanup.length ? ' · ' + value.cleanup.join(' · ') : '');
}

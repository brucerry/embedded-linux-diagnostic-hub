// Pure receipt evidence decision. Both bounded projections retain their provenance.
export function assessLoopbackDiagnostic(journalInput, attachmentInput, sanitize) {
    const issues = [];
    function project(input) {
        if (input === undefined || input === null) return null;
        if (typeof input.overflow !== 'boolean') {
            issues.push('diagnostic-evidence-unproved'); return null;
        }
        const value = sanitize(input);
        if (!value) { issues.push('diagnostic-evidence-unproved'); return null; }
        if (input.overflow || value.overflow !== false)
            issues.push('diagnostic-stage-overflow');
        return value;
    }
    const journal = project(journalInput), attachment = project(attachmentInput);
    if (!journal && !attachment) issues.push('diagnostic-evidence-unproved');
    const reconciliation = journal && attachment
        ? JSON.stringify(journal) === JSON.stringify(attachment) ? 'same' : 'different'
        : journal ? 'journal-only' : attachment ? 'attachment-only' : 'absent';
    let diagnostic = {schema: 2, reconciliation, journal, attachment};
    if (Buffer.byteLength(JSON.stringify(diagnostic)) > 8192) {
        diagnostic = null; issues.push('diagnostic-evidence-unproved');
    }
    return {diagnostic, issues: [...new Set(issues)]};
}

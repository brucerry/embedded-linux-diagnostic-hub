import type { AutomationRecord } from '../../../shared/automation';
export type ExportFormat = 'json' | 'csv' | 'markdown' | 'text';
export function exportResults(
    records: AutomationRecord[],
    format: ExportFormat,
    scope: string,
    evicted: number,
    createdAt = new Date().toISOString(),
) {
    const rows = records.map((r) =>
        structuredClone({
            id: r.id,
            runId: r.runId,
            ordinal: r.ordinal,
            name: r.name,
            command: r.command,
            transport: r.transport,
            target: {
                endpoint: r.target.endpoint,
                ...(r.target.username ? { username: r.target.username } : {}),
                ...(r.target.serialSettings ? { serialSettings: r.target.serialSettings } : {}),
            },
            startedAt: r.startedAt,
            completedAt: r.completedAt,
            localZone: r.localZone,
            durationMs: r.durationMs,
            deviceTime: r.deviceTime
                ? {
                      value: r.deviceTime.value,
                      source: r.deviceTime.source,
                      zone: r.deviceTime.zone,
                      observedAt: r.deviceTime.observedAt,
                  }
                : null,
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            completion: r.completion,
            truncated: r.truncated,
            ...(r.termination
                ? {
                      termination: {
                          signal: r.termination.signal,
                          coreDumped: r.termination.coreDumped,
                          message: r.termination.message,
                          truncated: r.termination.truncated,
                      },
                  }
                : {}),
            chunks: r.chunks.map((c) => ({
                stream: c.stream,
                base64: c.base64,
                receivedAt: c.receivedAt,
            })),
            ...(r.requestBytes ? { requestBytes: r.requestBytes } : {}),
            ...(r.execution
                ? {
                      execution: {
                          timeoutSeconds: r.execution.timeoutSeconds,
                          repeatSeconds: r.execution.repeatSeconds,
                          stepDelaySeconds: r.execution.stepDelaySeconds,
                          ...(r.execution.scheduledStart
                              ? {
                                    scheduledStart: {
                                        epochMs: r.execution.scheduledStart.epochMs,
                                        clock: r.execution.scheduledStart.clock,
                                        zone: r.execution.scheduledStart.zone,
                                        ...(r.execution.scheduledStart.wallTime !== undefined
                                            ? { wallTime: r.execution.scheduledStart.wallTime }
                                            : {}),
                                        ...(r.execution.scheduledStart.utcOffset !== undefined
                                            ? { utcOffset: r.execution.scheduledStart.utcOffset }
                                            : {}),
                                        ...(r.execution.scheduledStart.source
                                            ? { source: r.execution.scheduledStart.source }
                                            : {}),
                                        ...(r.execution.scheduledStart.uncertaintyMs !== undefined
                                            ? {
                                                  uncertaintyMs:
                                                      r.execution.scheduledStart.uncertaintyMs,
                                              }
                                            : {}),
                                    },
                                }
                              : {}),
                          ...(r.execution.serial
                              ? {
                                    serial: {
                                        lineEnding: r.execution.serial.lineEnding,
                                        prompt: r.execution.serial.prompt,
                                        timestampPrefix: r.execution.serial.timestampPrefix,
                                    },
                                }
                              : {}),
                      },
                  }
                : {}),
        }),
    );
    const metadata = {
        schemaVersion: 1,
        kind: 'diagnostic-hub-command-automation',
        createdAt,
        scope,
        retainedRows: rows.length,
        previouslyEvicted: evicted,
        warning:
            'Commands and output can contain secrets. Review before sharing. JSON preserves exact retained text and raw base64 bytes; it never includes connection credentials by design.',
    };
    if (format === 'json') return JSON.stringify({ ...metadata, records: rows }, null, 2);
    if (format === 'csv') {
        const keys = [
            'id',
            'runId',
            'ordinal',
            'name',
            'command',
            'transport',
            'endpoint',
            'username',
            'startedAt',
            'completedAt',
            'localZone',
            'deviceTime',
            'deviceTimeSource',
            'deviceTimeZone',
            'deviceTimeObservedAt',
            'durationMs',
            'exitCode',
            'completion',
            'truncated',
            'stdout',
            'stderr',
            'scope',
            'previouslyEvicted',
            'timeoutSeconds',
            'repeatSeconds',
            'stepDelaySeconds',
            'scheduledStart',
            'startClock',
            'startZone',
            'startUtcOffset',
            'startWallTime',
            'serialLineEnding',
            'serialPrompt',
            'signal',
            'coreDumped',
            'terminationMessage',
            'terminationTruncated',
            'transformedFields',
        ];
        const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
        const out = [keys.map(quote).join(',')];
        for (const r of rows) {
            const v: Record<string, unknown> = {
                ...r,
                endpoint: r.target.endpoint,
                username: r.target.username ?? '',
                deviceTime: r.deviceTime?.value ?? '',
                deviceTimeSource: r.deviceTime?.source ?? '',
                deviceTimeZone: r.deviceTime?.zone ?? '',
                deviceTimeObservedAt: r.deviceTime?.observedAt ?? '',
                scope,
                previouslyEvicted: evicted,
                timeoutSeconds: r.execution?.timeoutSeconds,
                repeatSeconds: r.execution?.repeatSeconds,
                stepDelaySeconds: r.execution?.stepDelaySeconds,
                scheduledStart: r.execution?.scheduledStart
                    ? new Date(r.execution.scheduledStart.epochMs).toISOString()
                    : '',
                startClock: r.execution?.scheduledStart?.clock,
                startZone: r.execution?.scheduledStart?.zone,
                startUtcOffset: r.execution?.scheduledStart?.utcOffset,
                startWallTime: r.execution?.scheduledStart?.wallTime,
                serialLineEnding: r.execution?.serial?.lineEnding,
                serialPrompt: r.execution?.serial?.prompt,
                signal: r.termination?.signal,
                coreDumped: r.termination?.coreDumped,
                terminationMessage: r.termination?.message,
                terminationTruncated: r.termination?.truncated,
            };
            const transformed: string[] = [];
            const cells = keys.slice(0, -1).map((k) => {
                let text = String(v[k] ?? '');
                if (/^[\s\x00-\x1f\x7f-\x9f]*[=+\-@]/.test(text)) {
                    text = "'" + text;
                    transformed.push(k);
                }
                return quote(text);
            });
            out.push([...cells, quote(transformed.join(';'))].join(','));
        }
        return out.join('\r\n');
    }
    const visible = (s: string) =>
        s
            .replace(/\r\n/g, '\n')
            .replace(
                /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
                (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
            );
    const headerValue = (s: string) => visible(s).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    const safe = (s: string) =>
        visible(s)
            .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
            .replace(/([\\\x60*_{}[\]()#+.!|~-])/g, '\\$1');
    const fence = (s: string) => {
        const text = visible(s),
            runs = text.match(/\x60+/g) ?? [];
        const delimiter = '\x60'.repeat(Math.max(3, ...runs.map((x) => x.length + 1)));
        return delimiter + 'text\n' + text + '\n' + delimiter;
    };
    const lead =
        'Automation QA results\nScope: ' +
        headerValue(scope) +
        '; exported rows: ' +
        rows.length +
        '; previously evicted: ' +
        evicted +
        '\n' +
        metadata.warning +
        '\nPresentation: nonprinting controls are shown as \\xNN. CSV protects formula-like cells with an apostrophe and lists transformedFields. Use JSON for exact retained data.\n';
    return (
        lead +
        '\n' +
        rows
            .map((r) => {
                const header =
                    r.ordinal +
                    '. ' +
                    headerValue(r.name) +
                    ' [' +
                    headerValue(r.transport) +
                    '] · ' +
                    headerValue(r.completion) +
                    ' · ' +
                    r.durationMs +
                    ' ms\nTarget: ' +
                    headerValue(r.target.endpoint) +
                    '\nLocal: ' +
                    headerValue(r.startedAt) +
                    ' → ' +
                    headerValue(r.completedAt) +
                    ' (' +
                    headerValue(r.localZone) +
                    ')\nDevice: ' +
                    (r.deviceTime
                        ? headerValue(r.deviceTime.value) + ' · ' + headerValue(r.deviceTime.source)
                        : 'unavailable') +
                    '\nExit: ' +
                    (r.exitCode ?? 'unavailable') +
                    '; truncated: ' +
                    r.truncated +
                    (r.termination
                        ? '\nSignal: ' +
                          headerValue(r.termination.signal) +
                          '; core dump: ' +
                          (r.termination.coreDumped ?? 'unavailable') +
                          '; message: ' +
                          headerValue(r.termination.message ?? 'unavailable') +
                          '; termination evidence truncated: ' +
                          r.termination.truncated
                        : '') +
                    '\n';
                return format === 'markdown'
                    ? '## ' +
                          safe(headerValue(r.name)) +
                          '\n\n' +
                          safe(header) +
                          '\n\n### Command\n\n' +
                          fence(r.command) +
                          '\n\n### Output\n\n' +
                          fence(r.stdout) +
                          '\n\n### Error output\n\n' +
                          fence(r.stderr)
                    : visible(header) +
                          'Command:\n' +
                          visible(r.command) +
                          '\nOutput:\n' +
                          visible(r.stdout) +
                          '\nError output:\n' +
                          visible(r.stderr);
            })
            .join('\n\n')
    );
}
export function downloadResults(text: string, format: ExportFormat) {
    if (new TextEncoder().encode(text).length > 32 * 1024 * 1024)
        throw Error('Export exceeds the 32 MiB download limit.');
    const types = {
            json: 'application/json',
            csv: 'text/csv',
            markdown: 'text/markdown',
            text: 'text/plain',
        },
        ext = { json: 'json', csv: 'csv', markdown: 'md', text: 'txt' };
    const url = URL.createObjectURL(new Blob([text], { type: types[format] + ';charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download =
        'automation-qa-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext[format];
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

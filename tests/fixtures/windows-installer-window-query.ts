import path from 'node:path';
import { matchesSetupSuccessor, type NativeSetupWindow, type SetupSuccessor } from '../../electron/setup-successor';

// Inert fixed query source only. No invoker, executable selector or arbitrary command API.
// Derived from setup-worker.ts identity(); PowerShell/Win32 syntax and effects are unrun.
export const WINDOWS_WINDOW_QUERY_SOURCE = String.raw`param(
    [Parameter(Mandatory=$true)]
    [ValidateRange(1,2147483647)]
    [int]$TargetProcessId
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$owned = $null
try {
    try { $owned = Get-Process -Id $TargetProcessId -ErrorAction Stop }
    catch {
        $state = 'inaccessible'
        if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { $state = 'missing' }
        [pscustomobject]@{schemaVersion=1;state=$state;requestedPID=$TargetProcessId} | ConvertTo-Json -Compress
        exit 0
    }
    try {
        # Retain the query's process handle while reading identity. Dispose releases only
        # this observer reference, never requests close/termination of the application.
        $null = $owned.Handle
        if (-not ('HubOfflineWindowQuery' -as [type])) {
            Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class HubOfflineWindowQuery{[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);}'
        }
        $executable = $owned.Path
        $createdAt = $owned.StartTime.ToUniversalTime().ToString('o')
        $handle = $owned.MainWindowHandle
        $title = $owned.MainWindowTitle
        $version = $owned.MainModule.FileVersionInfo.ProductVersion
        if ([string]::IsNullOrEmpty($executable) -or $executable.Length -gt 1024 -or
            $title.Length -gt 512 -or [string]::IsNullOrEmpty($version) -or $version.Length -gt 128) {
            throw 'Identity fields unavailable or over bound'
        }
        [pscustomobject]@{schemaVersion=1;state='observed';pid=$owned.Id;executable=$executable;
            createdAt=$createdAt;handle=$handle.ToInt64();visible=[HubOfflineWindowQuery]::IsWindowVisible($handle);
            minimized=[HubOfflineWindowQuery]::IsIconic($handle);title=$title;version=$version} | ConvertTo-Json -Compress
    } catch {
        [pscustomobject]@{schemaVersion=1;state='inaccessible';requestedPID=$TargetProcessId} | ConvertTo-Json -Compress
    }
} finally {
    if ($null -ne $owned) { $owned.Dispose() }
}
`;

export interface WindowQueryCapture {
    requestedPID: number;
    returned: boolean;
    exitCode: number | null;
    signal: string | null;
    stdoutEOF: boolean;
    stderrEOF: boolean;
    failure: 'none' | 'spawn-error' | 'query-error' | 'capture-error' | 'pending';
    stdout: Uint8Array;
    stderr: Uint8Array;
}
export type WindowQueryState = 'query-unconfirmed' | 'malformed' | 'missing' | 'inaccessible' | 'observed';
export interface DecodedWindowQuery {
    state: WindowQueryState;
    reason: string;
    // Retained unchanged, including failed/over-bound captures. No truncation or fake EOF.
    raw: WindowQueryCapture;
    native?: NativeSetupWindow;
}
const STDOUT_LIMIT = 8192, STDERR_LIMIT = 4096;
const integerPID = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
function keys(value: object, expected: readonly string[]) {
    return Object.keys(value).sort().join('|') === [...expected].sort().join('|');
}
function string(value: unknown, maximum: number, empty = false): value is string {
    return typeof value === 'string' && (empty || value.length > 0) && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}
function flatJSON(text: string): Record<string, unknown> {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.values(value).some(v => v !== null && typeof v === 'object')) throw Error('Non-flat query');
    // JSON.parse alone accepts duplicate keys. This wire format is a flat primitive
    // object; walk actual string tokens rather than matching key-like text in titles.
    const found = new Set<string>();
    let i = text.indexOf('{') + 1;
    const whitespace = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
    const quoted = () => {
        const start = i;
        if (text[i++] !== '"') throw Error('Expected key');
        while (i < text.length) {
            const c = text[i++];
            if (c === '\\') i++;
            else if (c === '"') return text.slice(start, i);
        }
        throw Error('Unclosed string');
    };
    whitespace();
    while (text[i] !== '}') {
        const key = JSON.parse(quoted()) as string;
        if (found.has(key)) throw Error('Duplicate key');
        found.add(key); whitespace();
        if (text[i++] !== ':') throw Error('Expected colon');
        whitespace();
        if (text[i] === '"') quoted();
        else while (i < text.length && text[i] !== ',' && text[i] !== '}') i++;
        whitespace();
        if (text[i] === ',') { i++; whitespace(); }
    }
    return value;
}
export function decodeWindowsWindowQuery(raw: WindowQueryCapture): DecodedWindowQuery {
    const result = (state: WindowQueryState, reason: string, native?: NativeSetupWindow): DecodedWindowQuery =>
        ({ state, reason, raw, ...(native ? { native } : {}) });
    if (!raw || !integerPID(raw.requestedPID) || !keys(raw, ['requestedPID', 'returned', 'exitCode', 'signal',
        'stdoutEOF', 'stderrEOF', 'failure', 'stdout', 'stderr']) || !(raw.stdout instanceof Uint8Array) ||
        !(raw.stderr instanceof Uint8Array) || raw.stdout.length > STDOUT_LIMIT || raw.stderr.length > STDERR_LIMIT)
        return result('malformed', 'QUERY_CAPTURE_SHAPE_OR_BOUND');
    if (raw.returned !== true || raw.exitCode !== 0 || raw.signal !== null || raw.stdoutEOF !== true ||
        raw.stderrEOF !== true || raw.failure !== 'none' || raw.stderr.length !== 0)
        return result('query-unconfirmed', 'QUERY_COMPLETION_UNCONFIRMED');
    try {
        const value = flatJSON(new TextDecoder('utf-8', { fatal: true }).decode(raw.stdout).trim());
        if (value.schemaVersion !== 1) return result('malformed', 'QUERY_SCHEMA');
        if (value.state === 'missing' || value.state === 'inaccessible') {
            if (!keys(value, ['schemaVersion', 'state', 'requestedPID']) || value.requestedPID !== raw.requestedPID)
                return result('malformed', 'QUERY_REQUEST_IDENTITY');
            return result(value.state, value.state === 'missing' ? 'PROCESS_NOT_OBSERVED' : 'PROCESS_INSPECTION_UNAVAILABLE');
        }
        if (value.state !== 'observed' || !keys(value, ['schemaVersion', 'state', 'pid', 'executable', 'createdAt',
            'handle', 'visible', 'minimized', 'title', 'version']) || !integerPID(value.pid) ||
            value.pid !== raw.requestedPID || !string(value.executable, 1024) ||
            !(path.isAbsolute(value.executable) || path.win32.isAbsolute(value.executable)) ||
            value.executable.split(/[\\/]/).includes('..') || !string(value.createdAt, 40) ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/.test(value.createdAt) ||
            !Number.isFinite(Date.parse(value.createdAt)) || !Number.isSafeInteger(value.handle) || Number(value.handle) < 0 ||
            typeof value.visible !== 'boolean' || typeof value.minimized !== 'boolean' ||
            !string(value.title, 512, true) || !string(value.version, 128))
            return result('malformed', 'QUERY_WINDOW_FIELDS');
        const normalizedDate = value.createdAt.replace(/\.(\d{3})\d*Z$/, '.$1Z');
        if (new Date(value.createdAt).toISOString() !== normalizedDate)
            return result('malformed', 'QUERY_CREATION_TIME');
        const native: NativeSetupWindow = { pid: value.pid, executable: value.executable, createdAt: value.createdAt,
            handle: Number(value.handle), visible: value.visible, minimized: value.minimized, title: value.title, version: value.version };
        return result('observed', 'NATIVE_FIELDS_OBSERVED', native);
    } catch { return result('malformed', 'QUERY_JSON_OR_ENCODING'); }
}
export function assessWindowsWindowQuery(root: string, expected: SetupSuccessor, version: string, raw: WindowQueryCapture) {
    const decoded = decodeWindowsWindowQuery(raw);
    const matched = decoded.state === 'observed' && raw.requestedPID === expected.pid &&
        matchesSetupSuccessor(root, expected, version, decoded.native!);
    return { ...decoded, matched, reason: decoded.state === 'observed' && !matched ? 'NATIVE_IDENTITY_MISMATCH' : decoded.reason };
}
export interface WindowQueryEvidence {
    state: WindowQueryState;
    reason: string;
    requestedPID?: number;
    returned?: boolean;
    exitCode?: number | null;
    signal?: string | null;
    stdoutEOF?: boolean;
    stderrEOF?: boolean;
    failure?: WindowQueryCapture['failure'];
    stdoutBase64?: string;
    stderrBase64?: string;
    rawCapture?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
}
export function windowQueryEvidence(decoded: DecodedWindowQuery): WindowQueryEvidence {
    const { raw } = decoded;
    if (!raw) return { state: decoded.state, reason: decoded.reason, rawCapture: 'invalid; retained in caller failure' };
    return { state: decoded.state, reason: decoded.reason, requestedPID: raw.requestedPID, returned: raw.returned,
        exitCode: raw.exitCode, signal: raw.signal, stdoutEOF: raw.stdoutEOF, stderrEOF: raw.stderrEOF, failure: raw.failure,
        ...(raw.stdout instanceof Uint8Array && raw.stderr instanceof Uint8Array &&
            raw.stdout.length <= STDOUT_LIMIT && raw.stderr.length <= STDERR_LIMIT
            ? { stdoutBase64: Buffer.from(raw.stdout).toString('base64'), stderrBase64: Buffer.from(raw.stderr).toString('base64') }
            : { rawCapture: 'over-bound-or-invalid; retained in caller failure', stdoutBytes: raw.stdout?.length, stderrBytes: raw.stderr?.length }) };
}

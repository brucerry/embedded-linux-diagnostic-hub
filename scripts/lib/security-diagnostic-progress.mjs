export const diagnosticProgressProfile = 'first-collector-query-v2';
export const diagnosticProgressLimits = Object.freeze({
    rows: 16,
    rowBytes: 256,
    bytes: 4096,
    streamBytes: 65536,
});
export const diagnosticStdoutPhases = Object.freeze([
    'stderr-write-returned',
    'stderr-flush-returned',
    'after-process-acquisition',
    'after-process-path',
]);
const mainPhases = Object.freeze([
    'entry',
    'before-interpreter',
    'after-interpreter',
    'before-plan-parse',
    'after-plan-parse',
    'before-get-item',
    'after-get-item',
    'before-get-acl',
    'after-get-acl',
]);
const terminalPhases = Object.freeze(['before-serialize', 'after-serialize']);
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = () => {
    throw Error('Diagnostic progress protocol refused.');
};

/** Standard JSON plus duplicate-key rejection, including equivalent escaped names.
 * No source evaluation; depth and input bytes are independently bounded. Errors never echo input. */
function strictJSON(text) {
    let i = 0;
    const whitespace = () => {
        while (/[\t\n\r ]/.test(text[i] ?? '') && i < text.length) i++;
    };
    const string = () => {
        const start = i++;
        while (i < text.length) {
            const c = text[i++];
            if (c === '\\') i++;
            else if (c === '"') return JSON.parse(text.slice(start, i));
            else if (c.charCodeAt(0) < 32) refuse();
        }
        refuse();
    };
    const value = (depth) => {
        if (depth > 64) refuse();
        whitespace();
        const c = text[i];
        if (c === '"') {
            string();
        } else if (c === '{' || c === '[') {
            const closing = c === '{' ? '}' : ']';
            const keys = new Set();
            i++;
            whitespace();
            if (text[i] === closing) {
                i++;
                return;
            }
            for (;;) {
                whitespace();
                if (c === '{') {
                    if (text[i] !== '"') refuse();
                    const key = string();
                    if (keys.has(key)) refuse();
                    keys.add(key);
                    whitespace();
                    if (text[i++] !== ':') refuse();
                }
                value(depth + 1);
                whitespace();
                if (text[i] === closing) {
                    i++;
                    break;
                }
                if (text[i++] !== ',') refuse();
            }
        } else {
            const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
                text.slice(i),
            );
            if (!token) refuse();
            i += token[0].length;
        }
    };
    value(0);
    whitespace();
    if (i !== text.length) refuse();
    return JSON.parse(text);
}

function lines(text) {
    if (
        typeof text !== 'string' ||
        Buffer.byteLength(text) > diagnosticProgressLimits.streamBytes ||
        !text.endsWith('\n')
    )
        refuse();
    return text
        .slice(0, -1)
        .split('\n')
        .map((line) => {
            const eol = line.endsWith('\r') ? '\r\n' : '\n';
            if (eol.length === 2) line = line.slice(0, -1);
            if (!line || line.includes('\r')) refuse();
            return { text: line, eol };
        });
}

/** Only the explicitly capability-bound diagnostic response is framed.
 * The returned report is the exact original terminal JSON text, not a reconstructed/sanitized report.
 * This is not metadata admission or physical child/pipe closure proof. */
export function decodeDiagnosticProgress(stdout, stderr, expectedPID) {
    try {
        if (!Number.isSafeInteger(expectedPID) || expectedPID <= 0) refuse();
        const out = lines(stdout),
            err = lines(stderr);
        if (out.length !== 5 || err.length < 6 || err.length > 12) refuse();
        const allLines = [...out, ...err];
        if (!allLines.every((line) => line.eol === out[0].eol)) refuse();
        const reportLine = out[4],
            report = strictJSON(reportLine.text);
        if (
            reportLine.text.trim() !== reportLine.text ||
            !object(report) ||
            !same(Object.keys(report).sort(), [
                'complete',
                'error',
                'interpreter',
                'principal',
                'rows',
                'schema',
                'trace',
            ]) ||
            report.schema !== 1 ||
            typeof report.complete !== 'boolean' ||
            typeof report.principal !== 'string' ||
            !object(report.interpreter) ||
            !object(report.trace) ||
            !Array.isArray(report.rows) ||
            (report.complete ? report.error !== null : !object(report.error))
        )
            refuse();
        let bytes = 0;
        let frequency;
        const phases = new Map();
        const phase = (line) => {
            const p = strictJSON(line.text);
            if (
                !object(p) ||
                !same(Object.keys(p), ['schema', 'kind', 'phase', 'pid', 'ticks', 'frequency']) ||
                p.schema !== 1 ||
                p.kind !== 'security-phase' ||
                p.pid !== expectedPID ||
                typeof p.phase !== 'string' ||
                !/^[a-z-]{1,32}$/.test(p.phase) ||
                typeof p.ticks !== 'string' ||
                !/^-?(?:0|[1-9]\d{0,18})$/.test(p.ticks) ||
                p.ticks === '-0' ||
                BigInt(p.ticks) < -(1n << 63n) ||
                BigInt(p.ticks) >= 1n << 63n ||
                typeof p.frequency !== 'string' ||
                !/^[1-9]\d{0,18}$/.test(p.frequency) ||
                BigInt(p.frequency) >= 1n << 63n ||
                JSON.stringify(p) !== line.text ||
                phases.has(p.phase)
            )
                refuse();
            const size = Buffer.byteLength(line.text + line.eol);
            bytes += size;
            if (
                size > diagnosticProgressLimits.rowBytes ||
                bytes > diagnosticProgressLimits.bytes ||
                phases.size >= diagnosticProgressLimits.rows
            )
                refuse();
            frequency ??= p.frequency;
            if (p.frequency !== frequency) refuse();
            phases.set(p.phase, BigInt(p.ticks));
            return p.phase;
        };
        if (!same(out.slice(0, 4).map(phase), diagnosticStdoutPhases)) refuse();
        const names = err.map(phase);
        let expected;
        if (report.complete) expected = [...mainPhases, ...terminalPhases];
        else {
            const prefix = names.slice(0, -3);
            if (prefix.length < 3 || !same(prefix, mainPhases.slice(0, prefix.length))) refuse();
            expected = [...prefix, 'refused', ...terminalPhases];
        }
        if (!same(names, expected)) refuse();
        const causalOrder = [
            ...mainPhases.slice(0, 2),
            ...diagnosticStdoutPhases,
            ...names.slice(2),
        ];
        for (let i = 1; i < causalOrder.length; i++)
            if (phases.get(causalOrder[i]) < phases.get(causalOrder[i - 1])) refuse();
        return reportLine.text + reportLine.eol;
    } catch {
        // Neither parser errors nor assertion diagnostics may leak arbitrary input/key/value text.
        refuse();
    }
}

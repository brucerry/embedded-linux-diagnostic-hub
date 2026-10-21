// Pure source/budget checks only: this file never evaluates PowerShell or launches a helper.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(
    path.join(import.meta.dirname, '../scripts/lib/hosted-pilot-security.ps1'),
    'utf8',
);
const original =
    '$interpreter = [ordered]@{ path = (Get-Process -Id $PID).Path; version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; x64 = [Environment]::Is64BitProcess; script = $PSCommandPath }';
const replacement = [
    '$interpreterProcess = Get-Process -Id $PID',
    "Write-HubSecurityPhase -Phase 'after-process-acquisition'",
    '$interpreterPath = $interpreterProcess.Path',
    "Write-HubSecurityPhase -Phase 'after-process-path'",
    '$interpreter = [ordered]@{ path = $interpreterPath; version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; x64 = [Environment]::Is64BitProcess; script = $PSCommandPath }',
].join('\n');
const phases = [...source.matchAll(/Write-HubSecurityPhase -Phase '([a-z-]+)'/g)].map(
    (match) => match[1],
);
const row = (phase, newline = '\r\n') =>
    JSON.stringify({
        schema: 1,
        kind: 'security-phase',
        phase,
        pid: 2147483647,
        ticks: '9223372036854775807',
        frequency: '9223372036854775807',
    }) + newline;

test('exact source delta preserves every byte outside the approved metadata split', () => {
    assert.equal(source.split(replacement).length, 2);
    const restored = source.replace(replacement, original);
    assert.equal(
        createHash('sha256').update(restored).digest('hex'),
        '0a31509c803185b0523f3e2de991ca7a3a77de7a06401cba69f1cd7a7cbf7142',
    );
});

test('acquisition, path access and remaining metadata retain order and single evaluation', () => {
    assert(source.includes(replacement));
    assert.equal(source.match(/Get-Process -Id \$PID/g)?.length, 1);
    assert.equal(source.match(/\$interpreterProcess\.Path/g)?.length, 1);
    assert.equal(source.match(/\$interpreterPath =/g)?.length, 1);
    assert.equal(source.match(/\$interpreter =/g)?.length, 1);
    assert.equal(source.match(/\$interpreterProcess/g)?.length, 2);
    assert.equal(source.match(/\$interpreterPath/g)?.length, 2);
});

test('the two fixed tags delimit completed assignments before remaining assembly', () => {
    assert(
        source.includes(
            "Write-HubSecurityPhase -Phase 'before-interpreter'\n" +
                replacement +
                "\nWrite-HubSecurityPhase -Phase 'after-interpreter'",
        ),
    );
    assert(source.indexOf(replacement) < source.indexOf('\ntry {'));
    assert(source.indexOf(replacement) < source.indexOf("-Phase 'before-plan-parse'"));
});

test('all declared tags stay unique, fixed, private-data-free and within the original row count', () => {
    assert.equal(phases.length, 16);
    assert.equal(new Set(phases).size, 16);
    assert(phases.every((phase) => /^[a-z-]{1,32}$/.test(phase)));
    assert.deepEqual(phases.slice(0, 5), [
        'entry',
        'before-interpreter',
        'after-process-acquisition',
        'after-process-path',
        'after-interpreter',
    ]);
    assert(source.includes('$script:hubSecurityDiagnosticRows -ge 16'));
    assert(source.includes('$bytes -gt 256'));
    assert(source.includes('$script:hubSecurityDiagnosticBytes + $bytes -gt 4096'));
});

for (const phase of phases)
    test(`fixed phase ${phase} fits the unchanged UTF-8 row reservation`, () => {
        for (const newline of ['\n', '\r\n']) {
            const text = row(phase, newline);
            assert(Buffer.byteLength(text, 'utf8') <= 256);
            assert.deepEqual(Object.keys(JSON.parse(text)), [
                'schema',
                'kind',
                'phase',
                'pid',
                'ticks',
                'frequency',
            ]);
        }
    });

test('even all sixteen declared rows fit the unchanged byte reservation', () => {
    const bytes = phases.reduce((sum, phase) => sum + Buffer.byteLength(row(phase)), 0);
    assert(bytes <= 4096);
    // A diagnostic one-directory success executes every site except catch/refused.
    assert.equal(phases.filter((phase) => phase !== 'refused').length, 15);
});

test('disabled diagnostic flag returns before clocks, accounting and stderr writes', () => {
    const writer = source.slice(
        source.indexOf('function Write-HubSecurityPhase {'),
        source.indexOf("Write-HubSecurityPhase -Phase 'entry'"),
    );
    const guard = writer.indexOf('if (-not $script:hubSecurityDiagnostic) { return }');
    for (const operation of [
        '[Diagnostics.Stopwatch]::GetTimestamp()',
        '$script:hubSecurityDiagnosticRows++',
        '[Console]::Error.WriteLine($line)',
        '[Console]::Error.Flush()',
    ])
        assert(guard >= 0 && guard < writer.indexOf(operation));
    assert(!writer.includes('$interpreterProcess'));
    assert(!writer.includes('$interpreterPath'));
    assert(!writer.includes('[Console]::Out'));
});

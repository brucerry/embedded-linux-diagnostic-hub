import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
const powershell = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
);
// Let Windows PowerShell initialize its own built-in module paths; a Node parent
// launched from pwsh otherwise forwards incompatible PowerShell 7 module paths.
const legacyEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
);
for (const hostOption of [
    null,
    '-NonInteractive',
    '-NonI',
    '/NonInteractive',
    '/NonI',
    '-nOnInT',
]) {
    const noninteractive = hostOption !== null;
    test(
        `Windows PowerShell 5.1 guided helper ${noninteractive ? `refuses ${hostOption} launch before network` : 'verifies setup and preserves portable contracts with fake HTTP/processes'}`,
        { skip: process.platform !== 'win32' },
        () => {
            const result = spawnSync(
                powershell,
                [
                    '-NoProfile',
                    ...(hostOption ? [hostOption] : []),
                    '-File',
                    path.resolve('tests/windows-downloader.ps1'),
                    ...(noninteractive ? ['-NoninteractiveProbe'] : []),
                ],
                { encoding: 'utf8', env: legacyEnvironment, windowsHide: true, timeout: 90_000 },
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.match(
                result.stdout,
                noninteractive
                    ? /Noninteractive full-helper refusal passed/
                    : /Windows full helper mocked qualification passed: 28 cases/,
            );
        },
    );
}

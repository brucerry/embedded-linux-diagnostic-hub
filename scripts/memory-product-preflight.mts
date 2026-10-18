// @ts-nocheck
/** One hosted metadata-only attempt. This module cannot enter the product collector. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceFingerprint } from '../tests/fixtures/memory-resource-identity';
import { prepareMemoryRuntime } from './memory-runtime.mjs';
import { nativeCoverageDraft } from '../tests/fixtures/memory-product-native-contract';
import {
    preflightLimits,
    ancestryIdentity,
    checkAncestry,
    refuseMarker,
    metadataIdentity,
    fileIdentity,
    dependencyFacts,
    metadataFileProbe,
    existingOwnershipPaths,
    ownershipSnapshotPlan,
    parseOwnershipSnapshot,
    parseTokenContractReport,
    requireTokenContractSuccess,
    ownershipSnapshotSummary,
    PreflightJournal,
    writeReport,
} from './lib/windows-preflight.mjs';

export const aclScript =
    '$ErrorActionPreference="Stop";$id=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$paths=ConvertFrom-Json $env:HUB_PREFLIGHT_PATHS;$rows=@(foreach($p in $paths){$a=Get-Acl -LiteralPath $p;[pscustomobject]@{path=$p;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;sddl=$a.Sddl}});[pscustomobject]@{principal=$id;rows=$rows}|ConvertTo-Json -Depth 4 -Compress';
export const ownershipContextScript =
    '$ErrorActionPreference="Stop";Set-StrictMode -Version Latest;$i=[Security.Principal.WindowsIdentity]::GetCurrent();try{$p=[Security.Principal.WindowsPrincipal]::new($i);$paths=ConvertFrom-Json $env:HUB_PREFLIGHT_PATHS;$rows=@(foreach($f in $paths){$a=Get-Acl -LiteralPath $f;$o=$a.GetOwner([Security.Principal.SecurityIdentifier]);$sd=[Security.AccessControl.RawSecurityDescriptor]::new($a.Sddl);if($sd.DiscretionaryAcl -and $sd.DiscretionaryAcl.Count -gt 128){throw "DACL ACE observation bound"};$aces=@(foreach($e in $sd.DiscretionaryAcl){$k=$e -is [Security.AccessControl.KnownAce];[pscustomobject]@{type=[int]$e.AceType;flags=[int]$e.AceFlags;known=$k;mask=$(if($k){[long]$e.AccessMask}else{$null});sid=$(if($k){$e.SecurityIdentifier.Value}else{$null})}});[pscustomobject]@{path=$f;owner=$o.Value;ownerRoleEnabled=$p.IsInRole($o);sddl=$a.Sddl;daclPresent=[bool]($sd.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent);daclNull=($null -eq $sd.DiscretionaryAcl);daclCanonical=$a.AreAccessRulesCanonical;aces=$aces}});[pscustomobject]@{principal=$i.User.Value;tokenOwner=$i.Owner.Value;accessCheckPerformed=$false;privatePathApproved=$false;rows=$rows}|ConvertTo-Json -Depth 6 -Compress}finally{$i.Dispose()}';
export const ownershipSnapshotScript =
    '$ErrorActionPreference="Stop";Set-StrictMode -Version Latest;Add-Type -Path $env:HUB_PREFLIGHT_OWNER_CS -ReferencedAssemblies @("System.dll","System.Core.dll");$p=ConvertFrom-Json $env:HUB_PREFLIGHT_OWNER_PLAN;$r=[HubOwnershipSnapshot.Observer]::Inspect([string[]]@($p.paths),[string[]]@($p.volumes),[string[]]@($p.files));$j=$r|ConvertTo-Json -Depth 12 -Compress;if([Text.Encoding]::UTF8.GetByteCount($j) -gt 32768){throw "Native snapshot result bound; no retry"};$j';
export const tokenContractScript =
    '$ErrorActionPreference="Stop";Set-StrictMode -Version Latest;& $env:HUB_PREFLIGHT_TOKEN_CONTRACT_PS1';
export const tokenContractInputs = Object.freeze({
    observer: Object.freeze({
        path: 'scripts/lib/windows-ownership-snapshot.cs',
        sha256: '481711fbf9ce1f9b02deeb0a13dbe22ffc222652feaf0c1a6de8d7dadcf48032',
    }),
    fixture: Object.freeze({
        path: 'tests/fixtures/windows-token-query-contract.cs',
        sha256: '5f7f575dc61eb64d7a9dba212b4bb7aa436caa56778404332e7100ae329f62e2',
    }),
    runner: Object.freeze({
        path: 'tests/windows-token-query-native-contract.ps1',
        sha256: '4000962456bac29eb4fd6f709e07141c52109c1b77c527f00dcfdf459337d3e5',
    }),
});
export function parseAclObservation(text, paths) {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    assert(/^S-1-5-/.test(value.principal));
    assert(Array.isArray(value.rows) && value.rows.length === paths.length);
    value.rows.forEach((r, i) => {
        assert.equal(r.path, paths[i]);
        assert(typeof r.owner === 'string' && typeof r.sddl === 'string' && r.sddl.length > 0);
    });
    return value;
}
/** Node is an intermediate process: WinPS must construct its own default module path. */
export function runPreflightCommand(
    exe,
    script,
    extra = {},
    {
        windowsPowerShell = false,
        environment = process.env,
        spawn = spawnSync,
        timeout = preflightLimits.commandMs,
    } = {},
) {
    const env = { ...environment, ...extra };
    if (windowsPowerShell)
        for (const key of Object.keys(env))
            if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    const result = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        timeout,
        maxBuffer: preflightLimits.commandBytes,
        env,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}
/** Required fixture gate. Rejections escape step() before any snapshot or later I/O. */
export async function runQualifiedOwnershipSnapshot({
    root,
    powershell,
    sourceSHA256,
    candidates,
    principal,
    command,
    step,
    admit,
}) {
    const compiled = await step('compiled-token-contracts', async () => {
        assert(
            typeof sourceSHA256 === 'string' && /^[a-f0-9]{64}$/.test(sourceSHA256),
            'Valid source identity required for compiled contracts.',
        );
        assert.equal(root, fs.realpathSync(root));
        assert.equal(root, path.resolve(root));
        assert.equal(
            await sourceFingerprint(root),
            sourceSHA256,
            'Source changed before compiled contracts.',
        );
        const sources = Object.fromEntries(
            Object.entries(tokenContractInputs).map(([key, input]) => {
                const identity = fileIdentity(path.join(root, input.path), { check: admit });
                assert.equal(
                    identity.sha256,
                    input.sha256,
                    'Reviewed contract input hash mismatch: ' + key,
                );
                return [key, identity];
            }),
        );
        const powershell51 = fileIdentity(powershell, { pe: true, check: admit });
        assert.equal(powershell51.pe.architecture, 'x64');
        const report = parseTokenContractReport(
            command(powershell, tokenContractScript, {
                HUB_PREFLIGHT_TOKEN_CONTRACT_PS1: path.join(root, tokenContractInputs.runner.path),
            }),
            {
                observerSHA256: tokenContractInputs.observer.sha256,
                fixtureSHA256: tokenContractInputs.fixture.sha256,
            },
        );
        return { sourceSHA256, sources, powershell51, report };
    });
    // step() catches failures and returns null. Both prerequisites MUST remain outside it.
    assert(compiled, 'Required compiled token contracts unavailable; no snapshot or I/O.');
    requireTokenContractSuccess(compiled.report);
    admit();
    assert.equal(
        await sourceFingerprint(root),
        sourceSHA256,
        'Source changed after compiled contracts.',
    );
    for (const [key, identity] of Object.entries(compiled.sources))
        assert.deepEqual(
            fileIdentity(path.join(root, tokenContractInputs[key].path), { check: admit }),
            identity,
            'Contract input rebound after execution.',
        );
    assert.deepEqual(
        fileIdentity(powershell, { pe: true, check: admit }),
        compiled.powershell51,
        'Windows PowerShell rebound after compiled contracts.',
    );
    admit();
    if (candidates?.paths.length)
        await step('ownership-snapshot', () => {
            const plan = ownershipSnapshotPlan(candidates.paths),
                snapshot = parseOwnershipSnapshot(
                    command(powershell, ownershipSnapshotScript, {
                        HUB_PREFLIGHT_OWNER_CS: path.join(
                            root,
                            'scripts/lib/windows-ownership-snapshot.cs',
                        ),
                        HUB_PREFLIGHT_OWNER_PLAN: JSON.stringify(plan),
                    }),
                    plan,
                    principal,
                );
            return { plan, snapshot, review: ownershipSnapshotSummary(snapshot, plan) };
        });
    return compiled;
}
export async function productPreflight(
    outputRoot,
    {
        events = process,
        clock = {
            now: () => Number(process.hrtime.bigint() / 1000000n),
            set: setTimeout,
            clear: clearTimeout,
        },
    } = {},
) {
    const started = clock.now(),
        deadline = started + preflightLimits.budgetMs;
    let cancelled = null,
        journal,
        reportRoot;
    const cancel = () => {
        cancelled ??= 'Preflight interrupted/disconnected; no further probe admission.';
    };
    for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) events.on(e, cancel);
    const timer = clock.set(cancel, preflightLimits.budgetMs - preflightLimits.reserveMs);
    const report = {
        schema: 1,
        kind: 'nonqualifying-windows-host-facts',
        reviewed: false,
        collectionApproval: false,
        productLaunches: 0,
        ptyRuns: 0,
        installerRuns: 0,
        sourceSHA256: null,
        hostBinding: 'Observed current job only. No later collection host is approved.',
        limits: preflightLimits,
        observations: [],
        failures: [],
    };
    const observe = (name, data) => {
        report.observations.push({ name, data });
        journal?.append(name, data);
        return data;
    };
    const admit = () => {
        assert.equal(cancelled, null, cancelled ?? '');
        assert(
            clock.now() < deadline - preflightLimits.reserveMs,
            'Preflight work deadline exhausted.',
        );
        if (reportRoot) {
            checkAncestry(report.ancestry);
            refuseMarker(report.canonicalTmp);
        }
    };
    const step = async (name, work) => {
        admit();
        try {
            return observe(name, await work());
        } catch (error) {
            observe(name, {
                status: 'blocked-or-unavailable',
                error: String(error).slice(0, 4096),
            });
            report.failures.push(name + ': ' + String(error).slice(0, 4096));
            return null;
        }
    };
    try {
        admit();
        assert.equal(process.platform, 'win32');
        assert.equal(process.arch, 'x64');
        assert.equal(process.version, 'v24.22.0');
        assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
        assert.equal(process.env.HUB_WINDOWS_PREFLIGHT_ONLY, '1');
        assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
        const require = createRequire(import.meta.url),
            root = fs.realpathSync(path.resolve(import.meta.dirname, '..')),
            tmp = fs.realpathSync(os.tmpdir());
        report.canonicalTmp = tmp;
        const candidate = fs.realpathSync(outputRoot);
        assert.equal(candidate, path.resolve(outputRoot));
        assert.deepEqual(fs.readdirSync(candidate), []);
        assert(!candidate.startsWith(root + path.sep));
        reportRoot = candidate;
        report.ancestry = ancestryIdentity(reportRoot);
        refuseMarker(tmp);
        journal = new PreflightJournal(reportRoot);
        const tsx = fs.realpathSync(require.resolve('tsx'));
        assert.deepEqual(process.execArgv, ['--import', pathToFileURL(tsx).href]);
        observe('host', {
            repository: process.env.GITHUB_REPOSITORY,
            commit: process.env.GITHUB_SHA,
            run: process.env.GITHUB_RUN_ID,
            attempt: process.env.GITHUB_RUN_ATTEMPT,
            imageOS: process.env.ImageOS ?? null,
            imageVersion: process.env.ImageVersion ?? null,
            runnerOS: process.env.RUNNER_OS ?? null,
            runnerArch: process.env.RUNNER_ARCH ?? null,
            osRelease: os.release(),
            osVersion: os.version(),
            sourceRoot: root,
            outputRoot: reportRoot,
            canonicalTmp: tmp,
            PATH: process.env.PATH,
            execArgv: process.execArgv,
            versions: process.versions,
        });
        report.sourceSHA256 = await step('source', () => sourceFingerprint(root));
        admit();
        const command = (exe, script, extra = {}) => {
            admit();
            const stdout = runPreflightCommand(exe, script, extra, {
                windowsPowerShell: exe === powershell,
                timeout: Math.min(
                    preflightLimits.commandMs,
                    deadline - preflightLimits.reserveMs - clock.now(),
                ),
            });
            assert.equal(cancelled, null);
            return stdout;
        };
        const powershell = fs.realpathSync(
            path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        );
        await step('runtime-files', () => ({
            node: fileIdentity(fs.realpathSync(process.execPath), { pe: true, check: admit }),
            tsx: fileIdentity(tsx, { check: admit }),
            electron: {
                version: require('electron/package.json').version,
                executable: fileIdentity(fs.realpathSync(require('electron')), {
                    pe: true,
                    check: admit,
                }),
            },
            powershell51: fileIdentity(powershell, { pe: true, check: admit }),
        }));
        assert.equal(require('electron/package.json').version, '44.5.1');
        await step('electron-version-resource', () => {
            const version = JSON.parse(
                command(
                    powershell,
                    '$ErrorActionPreference="Stop";$v=(Get-Item -LiteralPath $env:HUB_PREFLIGHT_ELECTRON).VersionInfo;[pscustomobject]@{ProductVersion=$v.ProductVersion;FileVersion=$v.FileVersion}|ConvertTo-Json -Compress',
                    { HUB_PREFLIGHT_ELECTRON: fs.realpathSync(require('electron')) },
                ),
            );
            assert(
                /^44\.5\.1(?:\.0)?(?:$|[ +])/.test(version.ProductVersion),
                'Actual Electron product-version resource differs from44.5.1.',
            );
            return version;
        });
        observe('powershell51-launch', {
            executable: powershell,
            flags: ['-NoProfile', '-NonInteractive', '-Command'],
            inheritedPSModulePath: Object.fromEntries(
                Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'PSMODULEPATH'),
            ),
            childPSModulePath: 'omitted; Windows PowerShell constructs its startup defaults',
            shell: false,
            executionPolicyChanged: false,
        });
        await step('powershell51-command-discovery', () =>
            JSON.parse(
                command(
                    powershell,
                    '$ErrorActionPreference="Stop";$c=Get-Command -Name Get-Acl -ErrorAction Stop;[pscustomobject]@{PSVersion=$PSVersionTable.PSVersion.ToString();PSEdition=$PSVersionTable.PSEdition;PSHome=$PSHOME;PSModulePath=$env:PSModulePath;command=$c.Name;modulePath=$c.Module.Path;moduleVersion=$c.Module.Version.ToString()}|ConvertTo-Json -Compress',
                ),
            ),
        );
        const single = await step('powershell51-acl-single', () =>
            parseAclObservation(
                command(powershell, aclScript, {
                    HUB_PREFLIGHT_PATHS: JSON.stringify([reportRoot]),
                }),
                [reportRoot],
            ),
        );
        const multi = await step('powershell51-acl-multiple', () =>
            parseAclObservation(
                command(powershell, aclScript, {
                    HUB_PREFLIGHT_PATHS: JSON.stringify([reportRoot, tmp]),
                }),
                [reportRoot, tmp],
            ),
        );
        const candidates = await step('existing-ownership-paths', () =>
            existingOwnershipPaths(reportRoot, tmp),
        );
        await runQualifiedOwnershipSnapshot({
            root,
            powershell,
            sourceSHA256: report.sourceSHA256,
            candidates,
            principal: single?.principal ?? multi?.principal,
            command,
            step,
            admit,
        });
        const ownerConfirmed = Boolean(
            single &&
            multi &&
            single.principal === multi.principal &&
            single.rows[0].owner === single.principal &&
            multi.rows.every((r) => r.owner === multi.principal),
        );
        observe('owner-observation', {
            ownerConfirmed,
            ACLChanged: false,
            ownerChanged: false,
            atomicHandleCapabilityClaim: false,
        });
        if (ownerConfirmed)
            for (const fault of [null, 'sync', 'close'])
                await step('metadata-io-' + (fault ?? 'nominal'), () => {
                    const proof = metadataFileProbe(reportRoot, { fault, check: admit });
                    assert(proof.controlPassed, JSON.stringify(proof));
                    return proof;
                });
        else
            report.failures.push(
                'Metadata I/O probes not admitted: current owner/principal unconfirmed.',
            );
        await step('capacity', () => {
            const stat = fs.statfsSync(tmp, { bigint: true });
            return {
                path: tmp,
                type: String(stat.type),
                blockBytes: String(stat.bsize),
                availableBytes: String(stat.bavail * stat.bsize),
                freeBytes: String(stat.bfree * stat.bsize),
                collectionCapacityApproved: false,
                profileOvershootBound: null,
            };
        });
        await step('windows-os', () =>
            JSON.parse(
                command(
                    powershell,
                    'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | ConvertTo-Json -Compress',
                ),
            ),
        );
        const where = path.join(process.env.SystemRoot, 'System32/where.exe');
        const find = (name) => {
            admit();
            const result = spawnSync(where, [name], {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 2000,
                maxBuffer: 8192,
            });
            if (result.status === 1) return [];
            assert.equal(result.error, undefined);
            assert.equal(result.status, 0, result.stderr);
            return result.stdout
                .trim()
                .split(/\r?\n/)
                .filter(Boolean)
                .map((p) => fs.realpathSync(p));
        };
        let tools;
        await step('installed-pty-tools', () => {
            const git = find('git.exe'),
                pwsh = find('pwsh.exe');
            let bin;
            for (const g of git) {
                for (const candidate of [
                    path.resolve(path.dirname(g), '../usr/bin'),
                    path.resolve(path.dirname(g), '../../usr/bin'),
                ])
                    if (
                        fs.existsSync(path.join(candidate, 'bash.exe')) &&
                        fs.existsSync(path.join(candidate, 'winpty.dll'))
                    ) {
                        bin = candidate;
                        break;
                    }
                if (bin) break;
            }
            const names = {
                git: git[0],
                pwsh: pwsh[0],
                bash: bin && path.join(bin, 'bash.exe'),
                cygpath: bin && path.join(bin, 'cygpath.exe'),
                dll: bin && path.join(bin, 'winpty.dll'),
                agent: bin && path.join(bin, 'winpty-agent.exe'),
            };
            tools = Object.fromEntries(
                Object.entries(names).map(([name, file]) => [
                    name,
                    file && fs.existsSync(file)
                        ? fileIdentity(fs.realpathSync(file), { pe: true, check: admit })
                        : { status: 'unavailable', installed: false },
                ]),
            );
            return {
                tools,
                ptyExecuted: false,
                missingToolsInstalled: false,
                architectureAssessed: false,
            };
        });
        if (tools?.pwsh?.path)
            await step('csharp-compile-only', () => {
                const script =
                    '$ErrorActionPreference="Stop";$types=@(Add-Type -Path $env:HUB_PREFLIGHT_CS -PassThru);$type=$types|Where-Object{$_.Name -eq "HubWinptyFixture"};if(-not $type){throw "Bridge type missing"};[pscustomobject]@{compiled=$true;runInvoked=$false;nativeLibraryLoaded=$false;runParameters=@($type.GetMethod("Run").GetParameters()|ForEach-Object{$_.Name})}|ConvertTo-Json -Compress';
                return JSON.parse(
                    command(tools.pwsh.path, script, {
                        HUB_PREFLIGHT_CS: path.join(root, 'tests/fixtures/winpty-bridge.cs'),
                    }),
                );
            });
        await step('dependencies', () =>
            dependencyFacts(fs.realpathSync(path.join(root, 'node_modules')), admit),
        );
        await step('derived-ssh-js-only', async () => {
            const derived = await prepareMemoryRuntime(root);
            admit();
            return {
                manifest: fileIdentity(derived.manifestPath, { check: admit }),
                preload: fileIdentity(derived.preloadPath, { check: admit }),
                artifactOnly: true,
                nativeOrProductExecuted: false,
            };
        });
        if (report.sourceSHA256)
            observe('native-case-draft', nativeCoverageDraft(report.sourceSHA256));
        admit();
        observe('canonical-marker-final', refuseMarker(tmp));
        report.status = report.failures.length
            ? 'UNREVIEWED_PARTIAL_HOST_FACTS'
            : 'UNREVIEWED_HOST_FACTS_ONLY';
    } catch (error) {
        report.status = 'BLOCKED_PREFLIGHT';
        report.failures.push(String(error).slice(0, 4096));
    } finally {
        const closure = journal?.close();
        report.journalClosure = closure ?? null;
        report.cancelled = cancelled;
        report.elapsedMs = clock.now() - started;
        if (closure && (!closure.synced || !closure.closed || closure.errors.length))
            report.failures.push('Preflight journal durability/closure failed.');
        try {
            if (reportRoot) {
                checkAncestry(report.ancestry);
                report.finalAncestry = ancestryIdentity(reportRoot);
                writeReport(reportRoot, report);
            } else
                console.error(
                    JSON.stringify({ status: report.status, failures: report.failures }).slice(
                        0,
                        8192,
                    ),
                );
        } finally {
            clock.clear(timer);
            for (const e of ['SIGTERM', 'SIGINT', 'disconnect']) events.off(e, cancel);
        }
    }
    if (report.failures.length) events.exitCode = 1;
    return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3, 'Only --out is supported; no collection option.');
    assert(process.argv[2].startsWith('--out='));
    void productPreflight(process.argv[2].slice(6))
        .then((report) => {
            console.log(
                JSON.stringify({
                    status: report.status,
                    reviewed: false,
                    collectionApproval: false,
                    productLaunches: 0,
                    failures: report.failures.length,
                }),
            );
        })
        .catch((error) => {
            console.error(String(error).slice(0, 8192));
            process.exitCode = 1;
        });
}

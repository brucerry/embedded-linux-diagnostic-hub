// @ts-nocheck
// Dormant historical token-analysis fixtures. Production directory facts do not import this module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceFingerprint } from './memory-resource-identity';
import {
    fileIdentity,
    ownershipSnapshotPlan,
    parseOwnershipSnapshot,
    parseTokenContractReport,
    requireTokenContractSuccess,
    ownershipSnapshotSummary,
} from '../../scripts/lib/windows-preflight.mjs';
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

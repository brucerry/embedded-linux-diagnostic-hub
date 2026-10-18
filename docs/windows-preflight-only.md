# First hosted Windows validation: metadata only

This candidate adds one manual `windows_preflight_only` boolean to the existing registered Windows
workflow. True skips the standing build and admits one independent 15-minute preparation job. There
is no collection option or build dependency. False/omitted preserves existing
main/PR/reusable/manual standing behavior. No workflow is dispatched by this patch.

The probe restores no dependencies itself: the job restores only the lockfile with pinned Node
24.22.0 x64. It inspects Electron44.5.1 files without launching them. It records actual
image/runtime, source, complete dependency/loader hashes, canonical temporary directory, marker
absence, current SID/owner/SDDL and single/multiple-path PowerShell5.1 serialization. Only fresh
nonce-named metadata files inside a verified fresh hosted-CI fixture exercise O_RDWR
read/fsync/close/reopen, including injected sync/close failures and cleanup. The current proposed
[fixture policy](hosted-ci-metadata-fixture-policy.md) replaces owner-SID equality as that narrowly
scoped I/O admission rule; it does not approve collection or user-machine privacy. It records free
capacity and installed Git/pwsh/bash/cygpath/winpty DLL/agent paths, hashes and PE architecture, or
explicit absence. C# compilation may inspect the bridge method without invoking it. The existing
derived JS-only SSH bundle is prepared and identified; no native application starts.

All new observations are unreviewed. Missing tools, owner observations, unavailable metrics and
failures remain explicit; no ACL, owner, policy, credential, driver or canonical-marker change makes
them pass. Any existing canonical marker blocks admission. Logs/reports are bounded before writes;
disposable file handles are independently synced/closed and partial facts are retained when
possible. Source aliases, expired admission and rebinding block further work. The probe has a
five-minute shared work budget including a 30-second cleanup reserve inside the 15-minute hosted
setup/upload envelope.

The facts apply only to the recorded job/host. They are not an approved collection manifest and
cannot be restamped onto a later windows-latest allocation. A same-host approval/custody mechanism
or explicit independently approved host-binding protocol remains unresolved. Native PTY, generation
reset, Save cancel/failure, actual descendant joins, profile overshoot/capacity acceptance, full
normal/forced soaks, calibrated policy, installers and shipping archives remain separate
prerequisites.

Known collector defects in the inert666 input are unreachable from this workflow/probe. Their
repairs are a separate packet. A successful preflight uploads its bounded metadata and stops for
independent review. It does not enqueue any native, product, PTY, installer, platform matrix or soak
follow-up.

The final disposable metadata reopen uses `O_RDWR | O_NOFOLLOW` (where available), as does the
middle read, so each descriptor passed to fsync has writable access. Local regression controls model
Windows writable-flush requirements on actual disposable files for nominal, injected sync and
injected close cases; a genuine writable flush failure still fails. These controls are not native
Windows observations and do not approve collection.

Hosted run `39094809530` on commit `9c5afbadab9fa4afefd69918b3b2901ebdfd9ae5` matched source
`3577982001db416ee08cf371ea9e53eedda108ebd7868603801d5c047ef575a4` but both Windows PowerShell 5.1
ACL observations failed to autoload `Microsoft.PowerShell.Security`. The workflow used `pwsh` to
launch Node, which passed its inherited environment to the absolute, hashed Windows PowerShell
executable.

Microsoft documents that a PowerShell 7 module path survives an intermediate process and can resolve
shared module names to incompatible versions. The preflight now omits all case variants of
`PSModulePath` from only the Windows PowerShell child environment, allowing its normal startup
defaults. It leaves the parent environment, PowerShell 7 child environment, profile flags, execution
policy, JSON path transport, owner checks, command limits and metadata admission unchanged. It does
not edit machine/user module paths, install/import a replacement module, or change ACLs or security
settings.

The original artifact did not capture `PSModulePath`, the selected Security module or its underlying
import exception. Environment inheritance is the evidence-backed mechanism addressed by this patch,
not a claim to have observed the exact shadowed module on that now-finished host. Added bounded
observations record inherited module paths and actual Windows PowerShell version/home/module
path/Get-Acl module identity for future review. Local deterministic command-port tests are not a
Windows rerun.

References:
[Microsoft about_PSModulePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.5#starting-windows-powershell-from-powershell-7)
and
[Windows PowerShell CLI flags](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).

The accepted historical directory-only run 39107781069 completed schema1/profile
`literal-directory-security-facts-v1` for all14planned paths. Its source, provider rows, raw
transport and independent review remain sealed. The old five-label ancestor scan and native/token
fixture material remain dormant test inputs; the production entry does not repeat that scan or any
broad token inventory.

The current proposed fixture path reads only its fixed canonical profile Temp parent and fresh
exclusive nonce child, using that same hash-pinned System32 WinPS5.1 script, exact decoder,
serializer and 25-case interpreter gate. The NoProfile/NonInteractive/shell:false boundary,
child-only PSModulePath isolation, execution policy, source/runtime rechecks and command/budget caps
remain. The provider returns only owner/group/DACL facts, preserving ordered ACE bytes without an
AccessCheck result. Its strict parser remains unchanged. The separate explicitly named
[hosted-CI fixture policy](hosted-ci-metadata-fixture-policy.md) recognizes only the exact inherited
three-principal standard-allow ACL shape for this parent/child pair; it is not a general permissions
or user-machine security classifier.

The controller records the physical parent and newly created child identities, checks all bound
ancestry and identities around descriptor acquisition and every payload step, and refuses drift,
reparse points, missing/unavailable/partial/malformed descriptors, source/runtime changes,
cancellation or exhausted work admission. These are path-based observations, not atomic handles or
ABA protection. Owner equality remains an observation rather than the I/O predicate. The previously
unexecuted metadata controls now require this separate CI-only fixture admission, never just
Administrators ownership of an arbitrary directory.

Provider limits remain at most24rows,128ACEs,16KiBper binary descriptor/text,32KiBaggregates and
32KiBserialized output; the production fixture batch has exactly2paths. The existing indexed raw
transport, journal and report caps remain unchanged. Any failed fixture/control or unconfirmed
handle/cleanup/journal closure blocks the parent attempt. Cleanup can remove only its exact
still-bound empty child after owned handles close. Collection approval stays false; a prior VM or a
successful synthetic fixture cannot authorize later workload custody or user-machine storage.

Local deterministic controls run the actual fixture controller, descriptor-command port, journal,
file probes and cleanup against disposable files, injecting only the Windows command. The existing
WinPS script passed25nativecases in the accepted prior run; new Windows child inheritance and
functional I/O under this policy have not executed. Exact policy/source review and separate
publication/run authorization remain required.

Run 39105545037 exposed a Windows PowerShell 5.1 input-array boundary: wrapping the
`ConvertFrom-Json` command in `@(...)` made the first row's path an array, serialized as a
`Count`/`value` object containing all 14 planned spellings. Strict Node parsing refused it. The
failed packet and run evidence are preserved; no full ancestor-descriptor report was obtained.

The decoder now assigns `ConvertFrom-Json -InputObject` directly, requires a root array of 1–24
actual strings, validates every element before adding it to a typed string list, and returns that
`string[]` as one pipeline object using unary comma. The caller assigns directly to `string[]`.
There is no cast of unvalidated objects, nested-array flattening, `Count`/`value` extraction, path
substitution or parser relaxation. Strict exact Node row comparison remains unchanged; the
production batch now has only the two fixed fixture paths. The input JSON byte cap remains 24 KiB.

Before any Get-Acl in that same child, 25 pure PowerShell contract cases invoke the exact production
decoder and serializer. They cover empty refusal, single/multiple/maximum inputs, the actual failed
14-path wrapper, malformed/nested/non-string/oversize inputs, zero/one/multiple report and ACE
arrays, null versus absent/unavailable ACL fields, literal escaping, order and scalar types. The
script returns an explicit contract result; failure prevents provider admission. JSON output uses
`ConvertTo-Json -InputObject`, and row/ACE arrays come directly from typed lists. Bound rollback
removes the whole current row from its list. This candidate has not executed these contracts in
Windows PowerShell; local injected replies do not qualify that behavior. No extra process or
workflow is added.

A separate `directory-provider-reply` record sequence captures stdout/stderr before exit, signal,
timeout, cancellation or JSON validation can discard them. It contains base64 of spawn-decoded
UTF-8, byte counts and full SHA-256 digests, with process status/error. Each stream retains up to
the existing 64 KiB command limit, including complete malformed provider JSON within its 32 KiB
bound. Output beyond retention is explicitly truncated with bounded head/tail bytes and original
byte offsets. Nothing in these records is interpreted as a descriptor or path.

The sequence contains small metadata, at most four 32 KiB decoded data chunks, and a final capture
completion record. Every record has an ordered index and expected record count; chunks also carry
stream/index/offset/byte count. Each record is at most 48 KiB before journal wrapping, below the
unchanged 64 KiB per-row cap. The original aggregate limit remains 128 KiB decoded bytes / 176 KiB
JSON. Existing 256 KiB aggregate journal, 128 journal rows, 512 KiB report and 32 KiB
assembled-facts limits remain unchanged. A write/sync failure stops capture before its completion
record and blocks continuation; in-memory/final-report copies do not prove a record was journaled.
Reconstruction must check the actual complete sequential journal records, offsets, lengths,
completion and full hashes for untruncated streams. Partial or malformed tails remain incomplete
evidence.

Independent candidate10 review found that quoted positive decoder paths were illegal on the target
.NETFramework, and that its single maximum transport record exceeded the journal row cap.
Candidate11 changes only the two positive path literals to legal paths (spaces/brackets/dollar
retained), leaving the production path validation and 25-case count unchanged. Quote escaping
remains in serializer-only SDDL text. Capture now uses the bounded sequence above. Local controls
reconstruct four stream-size cases from actual journal entries, and exercise actual write,
partial-write and sync-failure prefixes. No native contract execution, publication or CI is claimed
by those controls.

References:
[Windows PowerShell 5.1 ConvertFrom-Json](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertfrom-json?view=powershell-5.1),
[collection return and unary comma](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_return?view=powershell-5.1#return-values-and-the-pipeline),
and
[ConvertTo-Json InputObject](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertto-json?view=powershell-5.1).

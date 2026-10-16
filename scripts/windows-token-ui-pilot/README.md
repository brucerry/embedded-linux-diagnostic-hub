# Windows token and dummy UI pilot

This is a test-only feasibility probe for a disposable GitHub-hosted Windows x64 VM. It is prepared
for review. It does not run NSIS, the application, the setup worker, or the historical installed
fixture. Its result cannot qualify an installer or close a release gate.

The standalone `windows-token-ui-pilot.yml` workflow runs on pushes only to
`ci/windows-token-ui-pilot-20261016`, selecting HostedPilot immediately. Publication of an exact
reviewed commit therefore needs explicit approval of that hosted run before the push. Manual
`workflow_dispatch` remains available when registered: its `run_pilot` boolean defaults to
**false**, compiling and running synthetic tests only; explicit true selects the operational probe.
The job uses `windows-latest`. Environment checks prevent accidental ordinary local invocation; they
are not a security boundary, isolation proof or human authorization. Retain the actual GitHub job
URL, source SHA, hosted-runner provenance and image metadata with the artifact.

## Integration and preparation

Add this directory, `tests/windows-token-ui-pilot/` and the standalone workflow. No package.json,
production import, installer, release workflow or staged-evidence consumer changes are needed.
Existing Windows .NET Framework 4.x supplies `csc.exe`, WinForms, System.Drawing and UI Automation;
Node's built-in test runner checks source contracts. No package download, dependency installation or
new application dependency is used. `actions/checkout@v6` and `actions/upload-artifact@v4` follow
the existing workflow versions.

The source contract is self-contained. `tests/windows-token-ui-pilot/fixtures/setup-worker.ts.txt`
holds the complete byte-exact reviewed worker source as inert text, accompanied by
`guard-source-provenance.json`. Tests require its pinned SHA256/size, frozen snapshot identity,
exact pilot expression and the worker's rule refusing every result other than false. If application
worker source is also present, its guard/refusal rule must agree; errors other than absence fail
closed. The frozen source has no claimed Git commit and does not qualify an installer.
Missing/corrupt reference data is never skipped or replaced by a guessed expression.

The fixture exists because the original standalone pilot was committed over the v0.5.2 repository,
which does not contain the later installer worker. Earlier local checks had that source as external
review context. The `.txt` fixture is read only by Node's contract test. It is not TypeScript
application source, a runtime import, a C# compiler input or an executable payload; the dummy launch
path is unchanged.

Safe local preparation commands, with a **fresh**, writable output directory:

```powershell
node --test tests/windows-token-ui-pilot/source-contract.test.mjs
./scripts/windows-token-ui-pilot/prepare.ps1 -Mode Prepare -OutputDirectory '<fresh-path>'
./scripts/windows-token-ui-pilot/prepare.ps1 -Mode SelfTest -OutputDirectory '<another-fresh-path>'
```

`Prepare` only compiles. `SelfTest` also calls `--self-test`, whose first entry branch uses
synthetic facts, receipt validation and argument quoting. It asserts zero operational native calls.
Neither mode creates a restricted process or dummy window. Existing output directories are refused
and are never deleted.

The future hosted operational entry is `prepare.ps1 -Mode HostedPilot`. It additionally requires the
reviewed workflow's opt-in flag, genuine Windows/x64 and hosted environment/run/source fields. Its
default case is a UUID directory under the actual existing user home. There is no generic executable
or credential parameter. Do not invoke this mode on a personal laptop.

## Token, desktop and process boundary

The parent records real token user SID, authentication/token/modified LUIDs, session, type,
elevation/type, integrity, administrator SID attributes, group and privilege inventories,
filtered-token status and UIAccess. It observes the loaded user hive and real
home/AppData/LocalAppData/Desktop; it rejects missing/reparse/redirected paths and an inaccessible,
noninteractive or nonvisible input desktop. It neither loads a profile nor creates a desktop.

The only token-creation route is `SaferCreateLevel(USER, NORMALUSER, OPEN)` and
`SaferComputeTokenFromLevel(flags=0)` on the caller's primary token. A higher integrity level is
lowered to Medium on that new token only; a lower token is refused. There is no
linked-token/Explorer assumption. Microsoft documents this reduction API and its flags.
[Safer level](https://learn.microsoft.com/en-us/windows/win32/api/winsafer/nf-winsafer-safercreatelevel),
[Safer computation](https://learn.microsoft.com/en-us/windows/win32/api/winsafer/nf-winsafer-safercomputetokenfromlevel).

The candidate and actual driver/dummy/PowerShell descendants must retain the parent's user,
authentication and nonzero interactive session; have a filtered primary Medium token; report not
elevated, not Full, UIAccess false and no enabled administrator SID; and gain no enabled privileges
or ordinary enabled groups. Administrator SID absence is acceptable; if present it must be
deny-only. `IsTokenRestricted` is recorded separately because it tests restricting SIDs, whereas
`TokenHasRestrictions` records prior filtering.
[Token information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class),
[IsTokenRestricted](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-istokenrestricted).

The parent launches only the reviewed helper using `CreateProcessAsUserW`, an explicit
image/command/cwd, unchanged inherited environment, the already-permitted named desktop and no
inherited handles. The driver starts suspended, enters an owned kill-on-close job, and has its
actual image/hash/PID/creation/token checked before resume. No job breakaway is requested. The
same-user restricted-token exception avoids the assign-primary-token privilege requirement.
`LaunchQuotaState` distinguishes held-enabled, held-disabled, absent and removed quota privilege.
Either held state permits the API attempt; absent/removed rights are refused. The proposed hosted
execution scope includes the API's documented temporary activation of a necessary **already-held**
privilege. No manual activation or privilege-grant API is called. Actual OS refusal keeps its
numeric Win32 error.
[CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw).

The full parent before/after snapshot and ModifiedId check remain strict. Restored final rights do
not waive a changed ModifiedId: any actual change fails the pilot and requires review of that
observation. No assumption is made about which token Windows adjusts internally.
[Token statistics](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_statistics).

The existing shared desktop is used only when already accessible. It is not a security isolation
boundary. UIA driver and dummy use the same ordinary Medium level; there is no UIAccess
installation, certificate, service, account, password, UAC/policy/group/ACL change, privilege grant
or manual activation.
[Restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens),
[UIA security](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview).

## Operational effects and evidence

On the future disposable VM the code creates only a fresh owned case with compiler output, reviewed
source copies, a retained ownership marker, JSON receipts, logs and one PNG. It creates temporary
token/job/process/thread handles, one restricted driver, one same-token fixed System32 Windows
PowerShell child and one harmless WinForms dummy. It requests foreground focus for that owned
window. Apart from normal Windows/runtime housekeeping, the code makes no persistent
registry/integration or machine configuration writes. It reads the existing user profile/hive and
directories. The old installed target, pointer, receipts, Setup EXE, shortcuts and UUID profile are
never targeted.

PowerShell runs `-NoLogo -NoProfile -NonInteractive` with the exact unchanged installer's
`WindowsPrincipal.IsInRole(Administrator)` expression. Only exit 0, no stderr and stdout containing
only `false` after trimming passes. Its actual token/image/hash/PID/creation time are recorded. The
dummy has nonce-named Confirm and Close buttons. An MTA UIA driver starts from the exact attested
HWND, scopes controls by owned PID and nonce, invokes Confirm, observes ACK, captures the owned
client area, invokes Close and joins exit 0. It does not search arbitrary windows or send
desktop-wide input.

Capture uses only `PrintWindow(attested HWND, private bitmap DC, PW_CLIENTONLY)`. The bounded client
bitmap starts opaque white. No desktop/screen pixels, window borders/shadows or overlapping windows
are copied; there is no screen-copy fallback. PID/path/creation/hash, visibility/foreground/restored
state and stable geometry are checked before and after rendering. Failed rendering or re-attestation
saves no PNG. Successful output uses `FileMode.CreateNew` and records the method, exact HWND and
flags. Visibility/UIA observations are separate from the owned application's rendered client image.
PrintWindow is synchronous, so the existing 65-second driver and 90-second parent/job bounds remain
in force; blocked capture cannot waive cleanup or become success.
[PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow).

| Evidence                                                      | Required result                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preparation.json`, reviewed source, helper, compile log      | Source/helper hashes and source/run identity match the reviewed job; compilation succeeds.                                                                                                                                           |
| `pure-self-tests.json`                                        | Every synthetic check passes; operational native calls, restricted process launches and UI windows are zero. These are preparation evidence only.                                                                                    |
| `pilot-result.json`                                           | Schema `diagnostic-hub-token-ui-pilot-v1`, `PilotOnly:true`, `InstallerExecuted:false`, `Passed:true`, complete source/run/image/nonce/case fields, all actual token/profile/desktop checks pass.                                    |
| `driver-result.json`, `dummy-started.json`, `dummy-exit.json` | Actual driver/dummy process identities agree with parent observations; exact guard false; owned UIA ACK/capture/close observed; no timeout. Partial driver failures retain stage/error and available facts.                          |
| `dummy-native-window.png`                                     | Owned client-only PrintWindow image, method `PrintWindow(PW_CLIENTONLY)`, exact dummy HWND/flags=1, bounded dimensions and final rechecked SHA256 agree with the receipt. Inspect it alongside the separate UIA/visibility evidence. |
| Exit/cleanup fields                                           | Guard, dummy and driver exit normally with 0; owned job active count becomes 0; parent token and ModifiedId remain unchanged. Forced cleanup always fails the pilot.                                                                 |

Failure preserves available receipts/stage/error (including Win32 error text) and returns nonzero. A
timed-out or residual owned child is terminated only through its owned job. Job-assignment failure
terminates and joins the exact newly created suspended child using its retained handle; its PID and
cleanup outcome are recorded. No unrelated process is stopped. Handles, temporary SID/unmanaged
buffers, UI timer/form, streams and bitmap resources are disposed. The 40-second dummy watchdog,
65-second driver-thread join, 90-second parent wait and bounded cleanup prevent an indefinite run. A
failed termination/join remains a failed result requiring disposable-VM teardown; it cannot become a
pass.

The workflow retains `token-ui-pilot-v1-<run>-<attempt>` evidence for seven days even on probe
failure, only after its explicit case path exists. It never emits the installer qualification schema
or feeds release evidence. A passing pilot establishes only this token/dummy-UI lane on that
recorded VM. It leaves all final-hash native installer lifecycle and publication requirements
outstanding.

Neither a workflow input, environment flag nor existence of a branch is a human authorization.
Preparation is local only. Review and approve the exact final source commit and its immediate
hosted-run effects before branch publication or a separately requested dispatch; no laptop token/UI
run, installer execution or CI run is part of local verification.

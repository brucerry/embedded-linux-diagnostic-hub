# Owned PTY bridge compilation

Run 39375434374 expired the unchanged 7000 ms shell readiness wait before any stdout. The first
stdout was observed 608.3743 ms after the scheduled deadline. The helper's Add-Type call took
6028.8829 ms in its own clock. These facts support moving compilation; they do not prove that
relocation alone restores Windows readiness.

The hosted stage now compiles C# during `osPtyFixture` preparation. A separately tracked
`winpty-bridge-compile` tool invocation uses the discovered, byte-bound PowerShell, the same source
and `Add-Type -OutputAssembly -OutputType Library`. It exits before the closure contract, managed
Run, Bash, winpty-agent, SSH shell or prompt. One actual PTY helper/opening is preserved: the
compile-only tool is an owned build operation, like the existing SSH runtime build, and cannot open
a PTY or count as a passing readiness stage. Standalone fixture callers retain their original
compile path.

The fresh private HOME owns the assembly and compiler temporary directory. Compiler exit, pipe
closure, creation identity, descendant join and diagnostic drain precede artifact admission. Only
the expected output may appear; temporary files left behind refuse admission. Source hashes and
filesystem identities, compiler executable identity, arguments, PowerShell/CLR versions, owner
nonce/source/root binding and exact output identity/hash are retained. The output descriptor is
writable for fsync, then read and closed before publication. Failed close keeps a strong descriptor
reference; unknown custody stays held. Partial fixture failure retains the enclosing private root
through the existing owner rather than deleting potentially live files.

Shell-open still creates a fresh PowerShell process on the normal SSH path. It rechecks source/tools
and the assembly, verifies the exact bytes it loads, refuses a preloaded bridge type, checks the
public static Run/ClosureContract ABI and emits a bounded load receipt tied to its PID/creation
identity and the closed compiler. This is a managed assembly handoff, not an installed native x64
DLL claim. Their original creation values are retained; the supplemental Win32_Process/.NET
comparison accounts for CreationDate microseconds versus StartTime100ns and does not alter sampler
generation identities. Compiler and consumer must use the same bound executable/PowerShell/CLR;
actual CLR loading and type validation must succeed before Run. There is no assembly-name resolution
or failed-load recompilation fallback. The existing compile-observation count becomes a
compile-artifact plus one fresh durably acknowledged load receipt per opening; absent, duplicate or
foreign receipts retain custody.

PowerShell startup, input checks, assembly load/JIT, closure contract, winpty, Bash and prompt
remain inside the original readiness path. PersistentSshConsole and the assertions are unchanged:
arming precedes shell-open, 7000 ms, 100 ms quietness, UTF8/ANSI completion, journal drain,
cancellation and disarmed input after timeout. Compilation consumes the original 25000 ms
whole-stage cutoff. The 15000 ms managed Bash wait, 10000 ms cooperative close, core/reserve,
workflow/job/pair/disk/evidence bounds and ancestry/logging fixes are unchanged. No timer restarts,
warmed shell, cached prompt, retries or additional PTY opens. Compiler/artifact/raw evidence remains
under the existing private-root disk observer and evidence channels; output checks are not a hard
transient disk quota guarantee.

The API mechanism is documented by
[PowerShell Add-Type](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-7.6)
and
[.NET Assembly.Load(byte[])](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.assembly.load?view=net-10.0).
Local deterministic ports exercise handoff, loading protocol, lifecycle and refusal; they do not
execute Windows PowerShell or qualify real compile/load/readiness timing. Actual Windows validation
requires separately reviewed source/request bindings and human authorization. Historical
marker/private-root cleanup remains unproved, including this run's stage-closed outcome; no local
result releases historical custody.

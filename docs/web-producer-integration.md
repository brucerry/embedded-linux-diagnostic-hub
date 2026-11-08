# Held web producer integration candidate

This is source-only preparation. No compiler, package, real child, HTTP server, browser, workflow,
upload, native application or DUT was executed. The active workflows, release dependency graph and
unconditional release failures are unchanged.

## Command custody

The explicit web producer now dispatches its existing fixed Vite command through an asynchronous
direct-child owner. It uses ignored stdin, piped stdout/stderr and no shell. Success requires an
observed positive PID, spawn, code-zero unsignalled exit, matching child close, both pipe closures
and acknowledged listener removal. The build record requires the new `custody` field; an old summary
without this field fails validation. This is a tightening of the prepared v1 record, not a claim
that a previously executed producer was migrated. Runtime/GC/loader fields stay null and
`releaseAcceptance` stays false.

The Vite custody is not complete producer/descendant retirement. An opt-in async Git provider and
owned descriptor/publication wrappers are now prepared; the CLI requires a source-owned capability
before native work and has no default grant. Other source-provider callers retain the old sync
interface. Full default producer execution remains held pending actual executor/group/profile,
toolchain/filesystem and service admission. See [web native custody](web-native-custody.md).

The build record's `environment` is the fixed NODE_ENV/WEB_BASE_PATH overlay, not a complete
observed child environment. The new capability constructs a separately selected complete child
profile and binds its digest into custody without inheriting ambient variables. This proposed
profile still requires actual toolchain/configuration/filesystem admission. No Git setting or
permission changed.

The observation deadline is ten minutes, with a monotonic elapsed-time check before success to
refuse a late close even if the timer callback was delayed. Retained output is capped at 16 MiB
stdout and 1 MiB stderr, with at most 4,096 nonempty chunks per stream. Output hashes and byte
counts are bound into the build record; raw output is accessible only through the owner, not printed
or uploaded by this candidate. An oversize chunk is not copied. Subsequent output is drained without
buffering after overflow. These caps do not prevent a stream implementation from allocating its
incoming chunk. Runner memory admission remains separate.

Failure is permanent. Deadline, overflow, dispatch uncertainty, child/stream errors or invalid
lifecycle reject the build and prevent archive publication. The owner retains uncertain child and
listener custody; the CLI catches the propagated failure and sets a nonzero eventual exit status
without an uncaught module rejection or forced exit; later normal direct closure cannot turn that
failure into success. Within this Vite owner, no kill, signal, abort-timeout, stream destruction,
retry, deletion or process-exit cleanup is implemented. Direct closure remains distinct from
descendant retirement. A held operation may keep the caller alive indefinitely; the deadline bounds
observation, not process lifetime or job billing.

## Producer guards and future carrier contract

The public source excludes the historical disabled diagnostic workflow template and its historical
template assertions formerly spread across eight registrations, covering the private branch,
trigger, job and upload restrictions. The complete original template and those tests remain
preserved in the retained private candidate; they are not Actions configuration or an execution
route in this public source. The ordinary wiring test still checks the real producer CLI's
source-owned native capability and guarded main entry. This publication-scope split does not supply
a default capability or admit execution, uploads or independent service provenance.

The future independent carrier reader still expects exactly:

- `Diagnostic-Hub-Web-<version>.zip`
- `Diagnostic-Hub-Web-<version>.zip.sha256`
- `web-build.json`

Its stored/level-zero ZIP parser rejects missing, nested, extra, legacy and wrong-version members.
All seven existing carrier/readback and unsupported-service guard registrations remain in the
ordinary wiring test. Those synthetic parser controls do not imply an uploader is prepared or prove
actual Actions carrier behavior. Upload wiring needs its own separately reviewed implementation and
storage admission; this source does not provide or activate one. Archive bounds remain imported from
the shared dependency-free constants module, with unchanged values.

## Remaining real admission

Before enabling this source, admit the exact runner, installed Node/Vite/transitive toolchain,
environment and build scratch effects, source authority, memory/disk/time budgets and fresh output
scope. Any future CI installation, job timeout and log retention need an admitted execution scope.
An eventual artifact uploader also needs separate storage admission. In particular, GitHub
cancellation/timeout teardown and descendant retirement need their own approved owner/policy; the
no-signal command owner does not supply one.

Authenticate terminal producer run/job/attempt and exact uploaded carrier independently. Upload
action outputs alone do not establish this provenance. Attestation/trust-root admission and the
terminal reader's real custody remain separate. Gateway command execution/uploader wiring is not
invented here: the current engine has no admitted live executor. Its held stage and future carrier
must retain the analogous exact three-file contract.

Final-artifact web/Gateway runtime ownership, loader provenance, browser applicability,
independently reviewed normal/forced-GC calibration, full-product measurements and durable final
evidence remain missing. Existing package/storage/native/DUT/$0/publication holds and unconditional
release blocks are unchanged. Passing these source-only tests does not satisfy any of those gates.

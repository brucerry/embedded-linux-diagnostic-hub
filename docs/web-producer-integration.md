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

This custody applies to the Vite child only, not the complete default producer.
`localSourceProvider` still uses synchronous `execFileSync` Git commands with a 30-second timeout
and command-local Git configuration overrides. A timeout may request termination; a rejected command
is not proof of Git or descendant retirement. Existing executable/file readers and exclusive
`fs.writeFile` publication also have separate descriptor, failure and durability limitations. `wx`
prevents overwrite but is not a complete file-custody or publication acknowledgement. Partial files
can remain on failure. Full default producer execution remains held pending review/admission of
these Git and file adapters.

The build record's `environment` is the fixed NODE_ENV/WEB_BASE_PATH overlay, not a complete
observed or allowlisted child environment. The launcher still inherits other ambient variables.
Refusing NODE_OPTIONS, NODE_PATH and VITE_ does not authenticate every toolchain input; environment
admission is a separate prerequisite. This integration neither adopts a new environment policy nor
changes Git settings or filesystem permissions.

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

## Inert producer/upload candidate

`.github/workflow-candidates/web-archive-producer.yml.disabled` is outside the Actions workflow
directory, has a non-workflow suffix and an unconditional false job guard. Nothing references it. It
cannot run through ordinary workflow discovery. Do not remove these protections without separate
admission and review.

The prospective job calls the source-bound web producer with exact source/run/attempt/job pins and a
fresh output directory. Its upload step depends on normal producer success and names only:

- `Diagnostic-Hub-Web-<version>.zip`
- `Diagnostic-Hub-Web-<version>.zip.sha256`
- `web-build.json`

The common parent directory is stripped by the uploader. Compression level zero matches the existing
carrier parser's stored/level-zero DEFLATE profile. There are no wildcards, launcher files, site
trees, overwrite or failure-path upload. An actual Actions carrier still needs real readback
verification; synthetic ZIP controls do not establish the uploader's runtime behavior. Archive
bounds are now imported from one dependency-free constants module; values are unchanged.

## Remaining real admission

Before enabling this source, admit the exact runner, installed Node/Vite/transitive toolchain,
environment and build scratch effects, source authority, memory/disk/time budgets and fresh output
scope. The candidate's npm install, Actions storage and job timeout are prospective effects, not
granted permissions. In particular, GitHub cancellation/timeout teardown and descendant retirement
need their own approved owner/policy; the no-signal command owner does not supply one.

Authenticate terminal producer run/job/attempt and exact uploaded carrier independently. Upload
action outputs alone do not establish this provenance. Attestation/trust-root admission and the
terminal reader's real custody remain separate. Gateway command execution/uploader wiring is not
invented here: the current engine has no admitted live executor. Its held stage and future carrier
must retain the analogous exact three-file contract.

Final-artifact web/Gateway runtime ownership, loader provenance, browser applicability,
independently reviewed normal/forced-GC calibration, full-product measurements and durable final
evidence remain missing. Existing package/storage/native/DUT/$0/publication holds and unconditional
release blocks are unchanged. Passing these source-only tests does not satisfy any of those gates.

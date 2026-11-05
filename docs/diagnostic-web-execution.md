# Approved diagnostic-only web execution

Bruce approved developing the capability for one bounded artifact-free public Ubuntu build even if
timeout/cancellation relies on GitHub runner teardown. That teardown does not prove graceful
retirement of every descendant. The $0 spending block and release gate remain unchanged.

The new branch-only workflow is separate from the retained inactive 283 template. Its source-coded
entry validates the exact repository/public visibility, branch, push event, first attempt and
GitHub-hosted Linux/x64 environment before native file acquisition. These are preconditions, not
cryptographic service identity. The controller independently checks the exact pushed commit and
original terminal run/job, then reads the single bounded receipt from its log.

The capability narrows actual launch to the reviewed fixed read-only Git command family or the
existing exact Node/Vite shipping-web build. Root, executables, argv, child environment, stdio and
fresh validation/web-source output are checked. Git bytes are descriptor-read/hash-bound before and
after each operation. The unnecessary core.hooksPath override is removed rather than executed;
there is no hook bypass, HOME redirect, persistent Git/security setting change, credential or custom
endpoint. The read-only fsmonitor/untracked-cache selections and lazy-fetch/network protections remain.

Native filesystem ports reuse descriptor/directory custody and exclusive writes. Native timers are
synchronous Node timer ports; launch is Node spawn with shell:false and fixed argv. Bootstrap Git
identity uses the same bounded owned reader. The original producer CLI still has no default grant;
only the explicit diagnostic entry supplies this capability. No shipping product source changed.

The one standard ubuntu-24.04 job has a 20-minute ceiling and no retries, cache or artifact upload.
The existing Vite acceptance deadline is 10 minutes, stdout 16 MiB/stderr 1 MiB and 4096 chunks each.
Archive 128 MiB/expanded 256 MiB/member 64 MiB/4096 entries and build-record 16 MiB limits are unchanged.
These are admission/output/read bounds, not installed-dependency disk quotas or heap limits.
Checkout/setup/npm and total job logs are not bounded by the <=16KiB receipt limit; log download size
is checked after retrieval. Only source-derived hashes/counts and diagnostic status enter the receipt.
Official dependencies/Node downloads and newly created disposable CI files are within the approved
scope. No desktop package, browser, server, DUT or product-runtime workload is launched.

On a failed/unknown direct child or file close, no completed record/receipt is emitted; source owners
retain unresolved custody, preserve failure and do not signal, delete, retry or force exit. A job
timeout/cancellation may instead cause service teardown. A normal Node/Git/Vite close is only a direct
closure observation. Whole-group normal retirement remains null; releaseAcceptance stays false.
No runtime, installed-code mapping, attestation, GC, performance or full release verdict is supplied.
The separate package/storage hold and post-publication real-device acceptance ordering remain intact.

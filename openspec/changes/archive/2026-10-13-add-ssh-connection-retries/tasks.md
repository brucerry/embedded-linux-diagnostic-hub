# Tasks

## 1. Settle review decisions before implementation

- [x] 1.1 Obtain Bruce's decision on repeated permanent authentication/trust/gateway-policy
      failures; verify the chosen semantics are recorded and proposal/spec/design agree, with no
      silent exception to retry-until-Cancel.
- [x] 1.2 Confirm SSH-ready versus first-snapshot success and initial collection failure handling;
      verify the documented success boundary and tests preserve the existing terminal/clock
      lifecycle.
- [x] 1.3 Select desktop ownership and gateway cancellation/older-client compatibility contracts;
      verify a reviewed API sketch covers abort before and after session creation, idempotency,
      authorization and bounded cleanup.

## 2. Implement cancellable transport and retry ownership after review

- [x] 2.1 Add one-attempt cancellation in SshSession/DeviceMonitor; verify mock-SSH tests cancel
      before ready and reject late ready/error callbacks without affecting another connection.
- [x] 2.2 Add a trusted desktop cancellation operation and bridge typing; verify untrusted frame,
      stale operation and unrelated-owner requests are denied, and host approval is cleared on
      Cancel.
- [x] 2.3 Add reviewed gateway/client cancellation and response-loss cleanup; verify integration
      tests cancel pending and newly-created sessions, preserve slot limits and fail safely with
      unsupported older gateways.
- [x] 2.4 Add one shared connection-operation owner with a single 3000-ms post-failure timer; verify
      deterministic tests prohibit overlap, duplicate Connect and suspension catch-up bursts.
- [x] 2.5 Bound safe retry status and active-operation secret lifetime; verify tests and source
      inspection exclude credentials/key content from URLs, logs, reports, browser storage and
      retained error history.

## 3. Integrate the connection UI and session lifecycle

- [x] 3.1 Keep Cancel available during attempts, host-key approval and retry waiting, and show
      accessible retry status; verify browser tests exercise keyboard/pointer cancellation at all
      three phases.
- [x] 3.2 Integrate operation generation with success, target replacement, reset/import/update and
      app/page exit; verify stale attempt/approval/collection responses cannot mutate the
      replacement device or reopen its modal.

## 4. Verify the complete behavior

- [x] 4.1 Cover failed attempts at 2999 ms versus 3000 ms, slow handshake, cleanup delays and
      repeated failures; verify deterministic timing tests pass without real-device operations or
      increased timeouts.
- [x] 4.2 Cover authentication and host-key cases selected in task 1.1 on the desktop fixture;
      verify no repeated attempt accepts an unapproved key and Cancel closes the owned pending
      handshake.
- [x] 4.3 Cover gateway token/origin/allowlist/pinning denials and Cancel racing a lost successful
      response; verify negative integration tests produce no orphaned or overlapping SSH session.
- [x] 4.4 Run existing browser, desktop SSH/PTY/clock/reset/update/security and package checks plus
      the retained OS matrix for the implemented candidate; verify session continuity, no
      reauthentication on probe/PTY errors and unchanged original user edits.
- [x] 4.5 Update connection help and compatibility documentation to the reviewed semantics; verify
      typecheck and focused formatting/tests pass, and document remaining physical-platform
      limitations before any separately authorized release.

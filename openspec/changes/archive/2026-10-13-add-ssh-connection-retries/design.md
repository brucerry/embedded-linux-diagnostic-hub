# Design

## Context

See proposal.md for motivation. Bruce approved implementation: temporary failures retry every three
seconds; permanent authentication/trust/policy failures pause; SSH ready stops retries; collection
failures preserve healthy SSH.

Observed source:

- useDeviceSession.connect currently awaits one transport.connect and then an initial collect;
  collect failure disconnects the new SSH connection.
- ConnectModal disables Cancel while busy. App.tsx ignores close while connecting.
- Desktop hub:disconnect rejects while connecting. SshSession holds one current Client and rejects
  stale ready events, with a 60-second handshake deadline.
- HostVerification is handshake-scoped with opaque IDs and a 45-second approval deadline. Gateway
  requires an allowlisted target and configured fingerprint.
- GatewayClient session POST has a 180-second request deadline and no connect-specific
  AbortController. The server already disconnects pending SSH on response close and cleans failed
  attempts, but an acknowledged session with a lost browser response remains a lifecycle race.
- Existing terminal and clock specs forbid credential persistence, stale session input and automatic
  reconnect on reload; PTY-only failure has its own bounded recovery and must not start this loop.

## Goals / Non-Goals

**Goals:** One owner for a user-started operation, nonoverlapping attempts, reliable active
cancellation, bounded UI/error state, and unchanged trust/authorization boundaries.

**Non-Goals:** Automatic login on app reload, unexpected loss of a previously successful connection,
PTY-only failure, device commands to repair connectivity, stored credentials, macOS implementation,
release publication or applying the restore-notification candidate.

## Decisions

### 1. Shared operation owner and timer

Use one connection-operation owner in the shared session lifecycle, with states idle, attempting,
awaiting-host-approval, retry-waiting, cancelling and connected. Each run has an operation
generation, one transport attempt and at most one timeout. Do not implement independent native and
gateway retry loops: stacked loops would multiply attempts.

After a failed attempt finishes and resources are cleaned, wait 3000 ms before starting the next.
Measure from failure/cleanup completion, not the beginning of a potentially 60-second handshake.
Timer scheduling can be late during suspension; resume performs one due attempt without a catch-up
burst. Repeated Connect submissions do not create another owner.

### 2. Cancel before awaiting cleanup

Cancel immediately invalidates the operation generation and clears the retry timer, then requests
native/gateway cancellation and awaits cleanup. Native cancellation requires the existing
trusted-frame check and targets only the owned pending attempt; ordinary disconnect guards are not
weakened globally. Clear pending host-key approval. Every success/error callback, host-key reply and
collection completion checks ownership before changing state. A late authenticated client/session is
explicitly closed.

Gateway AbortController is necessary but not sufficient for cancellation after the server creates a
session and the response is lost. Prefer an authenticated, bounded operation token with idempotent
cancellation/response cleanup, scoped to the existing bearer/origin authority. Preserve current
pending/session limits. Never put credentials or cancellation authority in URLs. During an ambiguous
gateway result, release or conclusively expire the previous attempt before starting another; account
for cleanup delay in the three-second schedule. Confirm compatibility with older gateways before
selecting the wire contract.

### 3. Trust and secret lifetime

Each attempt performs the existing host-key check. No trust-on-error, fingerprint fallback,
automatic approval of a replacement key, or reuse of stale approval IDs. A host-key prompt is an
active pending attempt, not a failure eligible for another timer. The existing host-key and
handshake deadlines remain finite. Keep credentials only in the active operation's RAM; release
references and zero mutable key buffers at success/Cancel/exit. Never put secrets or arbitrary
remote error details in logs, URLs, reports, storage or retry counters.

Return typed attempt outcomes for network, authentication, host-key and policy errors where
feasible. Do not infer permanent/transient categories solely from user-facing error strings.

### 4. Approved success and failure semantics

Bruce approved SSH authentication as the success boundary. Retry stops before diagnostic collection
or PTY startup. Initial diagnostic failure retains healthy SSH, pauses collection and displays an
actionable error without credential retries. Established-session loss remains an explicit reconnect
action; reload and PTY-only recovery do not start this loop.

Temporary network/SSH failures retry every three seconds after cleanup. Authentication, rejected
host trust and permanent gateway-policy failures pause for user correction and explicit Connect. No
retry cap or backoff is added for temporary failures. Cancellation invalidates ownership before
awaiting cleanup.

### 5. Cancellation compatibility contract

Gateway health advertises connectionCancellation. New clients pause before a handshake on older
gateways. An opaque 32-hex attempt ID travels in authenticated POST bodies; cancellation closes
pending or created SSH resources, waits for attempt cleanup and retains bounded tombstones for late
requests. Native IPC cancellation targets the current owned attempt and preserves trusted-frame
checks. Unconfirmed cleanup pauses rather than allowing overlap.

## Risks / Trade-offs

- Repeating wrong credentials can lock out an account -> surface the failure, keep Cancel available,
  resolve permanent-failure policy before implementation.
- A browser abort can race session creation -> operation ownership and authenticated idempotent
  cleanup, with server/client race tests.
- Cancellation and ready/approval completion can cross -> invalidate before awaiting; reject late
  callbacks and close late resources.
- UI suspension can delay three-second timers -> one due attempt, no overlap or catch-up burst.
- In-memory credentials live longer during indefinite retries -> no persistence; bounded error
  history and explicit cleanup.
- A retry loop could collide with active-terminal recovery -> limit to the explicit connection
  operation; keep PTY recovery separate.

## Migration Plan

Introduce and test typed one-attempt cancellation first, then the operation owner and modal. Feature
behavior is not enabled until review decisions and cancellation compatibility are settled. Test
old/missing transport cancellation capabilities explicitly; do not pretend a dismissed modal aborts
SSH. Retain existing package/security/session checks. No main specs are synced and no
archive/commit/push/release occurs during this planning turn. Rollback removes the retry owner and
restores one-shot initiation without touching saved diagnostic evidence or user credentials.

## Approval record

Bruce approved the parent plan with "yes. nice plan." on 2026-10-12: temporary-only retries, active
Cancel, permanent-failure pause, SSH-ready success and separate collection failures. He also
approved standard free Intel/ARM64 macOS build/test/logs only, with no new release or application of
the separate restore candidate.

# Proposal

## Why

A user-started SSH connection currently makes one attempt, while Cancel is disabled during
connection. Bruce requested nonoverlapping retries three seconds after each failed attempt until SSH
connects or he clicks Cancel.

## What Changes

- Add a cancellable connection operation shared by desktop and browser/gateway flows, with a
  three-second delay after failure and cleanup.
- Keep Cancel usable during handshake, host-key approval and retry waiting; clear the active
  attempt, timer and stale completions.
- Retain existing host-key verification, pinned gateway targets, IPC/origin/token authorization and
  in-memory-only credentials.
- Show attempt count, latest failure and retry state without logging authentication secrets.
- Retry temporary network/SSH failures. Pause wrong credentials, rejected host keys and permanent
  gateway-policy failures for user correction, as Bruce approved.
- Limit this proposal to an explicit connection operation. App reload and loss of an already
  established SSH session do not start a new credential retry loop.

## Capabilities

### New Capabilities

- `ssh-connection-lifecycle`: User-started retry cadence, active cancellation, operation ownership
  and trust-preserving handshake behavior.

### Modified Capabilities

None. Existing terminal/session generation and device-clock contracts remain authoritative; this
proposal adds connection initiation behavior without relaxing them.

## Impact

Planning targets: `src/hooks/useDeviceSession.ts`, `src/features/connection/ConnectModal.tsx`,
`src/services/GatewayClient.ts`, `shared/types.ts`, `electron/main.ts`, `electron/preload.ts`,
`backend/ssh/session.ts`, `backend/ssh/monitor.ts`, and `gateway/server.ts`, plus focused
lifecycle/security/UI tests.

Desktop needs a trusted cancellation operation because current disconnect rejects while connecting.
Gateway already tears down handshakes on response abort, but client cancellation and response-loss
cleanup must cover the race after session creation. No new dependency is proposed.

Bruce approved implementation of these semantics after review. No source code, published v0.2.0
tag/assets or unrelated user edits are changed. macOS feasibility and the unapplied
restore-notification candidate are separate scopes.

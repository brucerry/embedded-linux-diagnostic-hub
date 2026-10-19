# Spec Delta

## Purpose

Provide a user-controlled SSH connection operation with predictable retry timing, active
cancellation and trust-preserving ownership across desktop and gateway editions.

## ADDED Requirements

### Requirement: User-started nonoverlapping retry sequence

For an explicitly started connection operation with valid settings, the application SHALL make one
SSH attempt at a time and SHALL schedule the next attempt three seconds after the previous temporary
failed attempt and its cleanup finish. Temporary failures SHALL continue until SSH authentication
succeeds or Cancel. Authentication, rejected host identity and permanent access-policy failures
SHALL pause for user correction and explicit Connect. There SHALL be at most one retry timer and no
overlapping or suspension catch-up attempts.

#### Scenario: Network failure then recovery

- **WHEN** a connection attempt fails, is cleaned up, and the user has not cancelled
- **THEN** no new attempt begins before three seconds have elapsed, and one new attempt begins when
  the timer can run

#### Scenario: Slow handshake or host approval

- **WHEN** an attempt is still connecting or awaiting a host-key decision
- **THEN** no retry timer initiates a second SSH handshake

#### Scenario: Successful authentication

- **WHEN** the active operation authenticates SSH
- **THEN** further credential retries stop and existing terminal/diagnostic lifecycle rules handle
  that connection

#### Scenario: Permanent failure and correction

- **WHEN** credentials, host trust or permanent gateway policy prevent authentication
- **THEN** timed retries pause, a safe failure is shown and correcting inputs followed by Connect
  starts a new owned operation

### Requirement: Active cancellation and stale completion isolation

Cancel SHALL remain available while connecting, awaiting trust approval or waiting to retry. Cancel
SHALL invalidate the operation, clear the timer, cancel its pending trust request, terminate the
owned active transport attempt and discard retained operation credentials. Late success, failure,
approval or session-creation responses SHALL NOT reconnect the application, restart retries or
mutate a replacement operation. Any late authenticated resource SHALL be released.

#### Scenario: Cancel during retry delay

- **WHEN** the user clicks Cancel before the three-second timer fires
- **THEN** the timer is removed and no next connection attempt occurs

#### Scenario: Cancel races authentication

- **WHEN** Cancel occurs while SSH readiness or a gateway session response is arriving
- **THEN** the cancelled operation never becomes connected and its late client/session is closed

#### Scenario: Stale approval or replacement operation

- **WHEN** an old host-key approval or attempt completes after cancellation or a new connection
  operation begins
- **THEN** it cannot approve, fail or connect the new operation

### Requirement: Preserve trust and authenticated transport

Every attempted SSH handshake SHALL retain existing host-key verification and gateway pinning.
Unknown/replacement host keys SHALL require the existing explicit approval or configured gateway
pin, and rejection SHALL never be converted to approval by retrying. Cancellation and retry APIs
SHALL retain trusted-frame or bearer-token/Origin/allowlist authorization and bounded gateway
session limits. Credentials SHALL remain only in active-operation memory and SHALL NOT enter
storage, URLs, logs, reports or counters.

#### Scenario: Rejected or changed host key

- **WHEN** the key is rejected or does not match the gateway pin
- **THEN** no authenticated SSH connection is accepted using that key and retrying does not weaken
  trust

#### Scenario: Unauthorized cancellation request

- **WHEN** an untrusted frame or unauthorized token/origin requests cancellation or changes a
  connection operation
- **THEN** the request is rejected without affecting an authorized user's attempt or session

### Requirement: Honest and bounded retry status

The UI SHALL expose that the operation is attempting, awaiting host approval, waiting to retry or
cancelling, with an attempt count and the latest safe failure summary. It SHALL keep Cancel usable
and SHALL retain bounded status/error state without credential or private-key details.

#### Scenario: Repeated failures

- **WHEN** multiple valid attempts fail before Cancel
- **THEN** the current attempt count and latest failure are visible without an unbounded error
  history or secrets

### Requirement: Connection initiation scope

The retry sequence SHALL apply only to the explicit user-started connection operation. App/page
reload, updater restart, diagnostic/clock failure, PTY-only failure or loss of a previously
successful SSH connection SHALL NOT start automatic credential retries. Existing session-generation
isolation, single-PTY ownership and last-evidence retention SHALL remain in force.

#### Scenario: Failure after successful connection

- **WHEN** a diagnostic probe, clock read or PTY fails after SSH is authenticated
- **THEN** it does not start another SSH authentication loop

#### Scenario: Reload or established-session disconnect

- **WHEN** the app/page reloads or an established SSH connection closes unexpectedly
- **THEN** the existing explicit connection lifecycle remains and no new automatic login occurs

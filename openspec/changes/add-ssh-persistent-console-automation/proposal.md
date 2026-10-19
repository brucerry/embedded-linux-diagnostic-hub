# Proposal

## Why

SSH Automation currently creates a new exec channel for each step. The user's v0.5.2 flow shows
`cd /` exiting successfully but the next `pwd` still reporting `/root`; `ll` exits 127 although it
works in the device's interactive console. Enter cannot address the previous command in this mode.
The origin of the device's `ll` definition is unverified. Operators need an explicit persistent
console mode with honest completion evidence while independent scripts keep their current behavior.

## What Changes

- Add an explicit SSH mode choice: independent scripts (the compatible default) or one persistent,
  exclusively owned interactive PTY for a whole flow. Keep the existing Terminal channel separate.
- Add explicit Script and Send Enter intents in console mode. Enter writes exactly CR on the owned
  shell; accidental empty scripts and Enter in independent-script mode remain invalid.
- Retain cwd, environment, aliases and functions supplied by the target's normal interactive shell
  initialization. Do not rewrite `ll`, inject arbitrary profile sourcing or pretend blank execs are
  Enter actions.
- Require explicit bounded literal completion criteria, with per-step overrides/alternatives for
  changing prompts and intermediate interactive input. Observe fresh complete prompts; never
  auto-confirm a program, silently broaden a criterion or invent an exit code.
- Preserve storage-backed full observed-output capture with bounded memory, truthful first/last
  receive provenance, immutable mode/intent/match evidence, cancellation, generation fencing and
  explicit rearming. Expose unsupported older bridge/gateway capabilities without silently falling
  back to another execution mode.

## Capabilities

### New Capabilities

None; extend the existing Automation contracts.

### Modified Capabilities

- `command-automation`: distinguish owned exec scripts from a flow-owned persistent console, add
  explicit Enter intent and safely configurable prompt completion.
- `automation-exports`: preserve execution mode, intent, combined PTY output, unavailable exit
  status, matched criterion and truthful bounded receive provenance.

## Impact

Shared plan/request/capture validation, the SSH session's channel ownership/activity gates, desktop
IPC/preload and gateway contracts/capability negotiation, Automation runner/editor/result exports,
and fixture/browser tests. Existing ssh2 PTY primitives are available; no new dependency is
proposed. Local-only v0.6.0 planning follows the separately reviewed Serial/UI corrections. No DUT
access, device configuration, real SSH connection or release publication is authorized by these
drafts.

Storage/streaming requirements are coordinated with add-durable-automation-capture. Console
startup/idle/shutdown bytes require typed context segments, not fabricated command outcomes. The
latest plan is documented before any console implementation.

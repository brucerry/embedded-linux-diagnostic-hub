# Proposal

## Why

Small total-output and retention caps interrupt otherwise healthy Automation commands and prevent
complete review. The user approved full observed-output storage with bounded memory, explicit
retention and truthful failure evidence for the combined v0.6.0 release.

## What Changes

- Persist observed Automation bytes and receive provenance through native profile files or browser
  IndexedDB, with bounded queues/previews/pages and no small application-imposed total capture cap
  or automatic row eviction.
- Require durable capture seal and immutable outcome commit before the next command/repetition; stop
  safely on storage, integrity, ownership or uncertain continuation failures.
- Provide full-output search, paging, selection, explicit deletion and streaming
  JSON/CSV/Markdown/text exports across native and web clients.
- Rebuild a disposable native metadata index from canonical files, preserve legacy stores during
  migration/recovery, and expose unsupported/denied/quota/incomplete states without resetting data.
- Add negotiated independent SSH streaming after the reviewed Serial integration; persistent SSH
  console semantics remain owned by add-ssh-persistent-console-automation.
- Clarify that manual Serial transcripts remain ephemeral; only deliberately armed Automation
  captures persist locally.

## Capabilities

### New Capabilities

- `automation-capture-storage`: durable raw observations, bounded processing, recovery/migration,
  ownership, retention and streaming transport/storage acknowledgement.

### Modified Capabilities

- `automation-exports`: stored full-output evidence and streaming scoped exports supersede small
  total retention/whole-Blob limits while preserving truthful receive aggregation and future console
  provenance.
- `command-automation`: successful capture/outcome persistence is an advancement prerequisite
  independently of prompt/exit observation.
- `local-serial-terminal`: keep manual transcript privacy while allowing explicit Automation-owned
  local persistence.

## Impact

shared/automation-stream.ts and shared/capture-_.ts; electron/capture-_.ts and trusted IPC/preload;
IndexedDB/download-worker adapters; AutomationPage/StoredSerialResults; SerialSession; SSH
session/exec/gateway streaming; fixture, browser and native Electron tests. The isolated candidate
uses pinned Node 24/Electron built-in SQLite for a disposable catalog and adds no dependency or
service. Current package remains 0.5.2; target v0.6.0 is gated.

This formal delta repairs an artifact gap: earlier user-authorized storage implementation was
tracked under the skip-specs native planning queue and storage-design.md, while
plan-windows-permanent-delivery already required Serial full-output storage/exports. Detailed
durability, indexing, migration, job ownership and cross-transport contracts were missing or
inconsistent. It does not establish retroactive workflow compliance or mark the isolated candidate
adopted. See design.md for exact accepted checkpoints and remaining gates. No physical port,
external SSH, host policy change, installation or publication is part of this planning pass.

## Context

Actual Electron44.5.1 request details captured under forced denial: origin/securityOrigin
app://bundle/, requestingUrl app://bundle/index.html, isMainFrame true. Existing policy returns
false. No physical port was opened or selected. The original native smoke supplied synthetic origins
without the trailing slash and therefore missed this defect. Idle COM11 is user-reported office
evidence; that machine is outside authorized access.

## Goals / Non-goals

Fix the demonstrated origin mismatch and chooser truncation; accept every runtime-offered valid
identity without optional metadata. Implement the two requested Serial visual changes and preserve
all ownership/grant/cleanup safeguards. No physical access, office access, OS configuration change,
control-line setter, new dependency, native transport replacement or v0.5.0 asset mutation.

## Decisions

Match only the expected origin string or that string with one trailing root slash. Do not strip
arbitrary paths, credentials, queries or fragments. Keep exact requesting document, trusted owner,
main-frame and session URL checks, offered-token validation and explicit selection/connect. Remove
the 128-entry truncation, preserving duplicate-ID rejection and per-field bounds. Apply an OS name
only to the chosen port, not unrelated authorized handles. The authorized dropdown is not an OS
inventory; Choose port requests runtime discovery and choosing sends no open request.

Keep the solar disc/texture stationary. Add small stepped pixel flames around its edge; existing
hidden/blocked/reduced-motion rules stop them. Remove the Serial-only curl path, leaving shared
pig/duck grids and SSH art unchanged.

## Compatibility and unresolved desired scope

Web Serial exposes what Chromium's platform enumerator reports. Optional USB IDs/friendly names are
not an acceptance condition. Synthetic built-in UART, USB serial, virtual-driver identities,
COM11/high COM numbers and Unix driver names are supported when runtime-offered. This does not
establish physical-driver support. Chromium Linux filters tty drivers to serial type, excluding
arbitrary pseudoterminals; macOS uses IOSerialBSD services. Windows enumerates OS serial device
records and handles multi-digit COM device paths. Pin/runtime-source details belong in evidence.

For OS ports outside that catalog, propose a separate native transport: OS-attested catalog IDs,
trusted main-process permission/selection, platform-native serial configuration/open only after
explicit Connect, exclusive ownership, bounded byte queues, cancellation and no automatic signal
setters. Native dependency/build/ABI coverage and physical acceptance require a separate decision;
manual arbitrary file paths or broad renderer filesystem access are not a safe fallback.

## Verification

Before/after actual permission-detail proof with forced denial, synthetic enumeration/chooser
COM11/built-in/USB/virtual/missing-metadata/>128/hotplug/cancel/foreign-origin cases; focused Serial
session/UI/native tests; stationary disc/flame motion/reduced motion/pointer safety/visual captures;
format/types/unit, full browser, native desktop, production builds and portability before push.

## Risks

The fix unblocks trusted runtime discovery but cannot prove office COM11 driver enumeration or
hardware I/O. Physical acceptance remains pending. No blind parameter tuning, dependency addition or
published-release mutation is part of this batch.

# Opt-in launch timing (diagnostic proposal)

Set `HUB_LAUNCH_TIMING=1` only for an explicitly authorized diagnostic launch.
Unset it for normal use. The setup-worker path is excluded. This is not telemetry:
there is no network request, file log, IPC timing channel, timer or paint observer.
The only preload addition is a boolean opt-in flag; no privileged API is added.

In an authorized harness, read `globalThis.__hubLaunchTiming?.()` in Electron's
**main-process** context and `window.__hubLaunchTiming?.()` in the initial
**renderer-document** context. Each returns a detached, schema-1 snapshot with a
clock-domain label and at most 32 named millisecond offsets. No automatic export or
console output occurs. Read before closing the process; the evidence is ephemeral.
Do not expose either snapshot as a general-purpose remote diagnostic endpoint.

## What the milestones mean

The main origin is the first instrumentation initialization in `electron/main.ts`'s
body, **after all static imports have evaluated**. It cannot see native executable
loading, Electron initialization, the portable launcher, or static-import cost.

- `main-startup-selection-start/returned`: existing synchronous installation selection.
- `main-profile-lock-returned`: canonical profile selection, path setup and the
  existing single-instance lock have returned; this is not proof the lock was granted.
- `main-ready-handler-registration` / `main-ready-callback`: registration and entry
  into the existing readiness callback; not the exact OS/Electron ready event.
- `main-window-construction-start/returned`: BrowserWindow construction including
  the existing Linux window-identity wrapper.
- `main-window-visible-observed`: main-process visibility observation (or first show
  event). The default initial show can occur inside construction. It is **not** an
  actual compositor-on-screen confirmation.
- `main-ready-to-show`: Electron's observed event; not an instruction to wait or show.
- `main-load-url-start/resolved`: call and completion of the existing loadURL promise.

The renderer origin is this document's navigation performance origin (zero).
`renderer-entry-body` is after static renderer imports, not their start.
`renderer-app-layout-effect` is the first existing App layout effect, before its
page-transition work. It is **not** FCP, a usable-workspace guarantee or device readiness.
StrictMode replay and page changes do not replace the first observation.
`renderer-first-contentful-paint` is the browser's buffered paint entry `startTime`,
harvested only when a snapshot is requested. If absent, it stays absent; it is never
synthesized as zero. Buffered entries can appear later in the array than newer events;
the array is insertion-ordered, not a timeline sorted by timestamp.

**Never subtract main and renderer offsets.** They have unrelated monotonic origins.
Only differences inside one snapshot's clock domain are meaningful. In particular,
App layout effect, FCP, ready-to-show, visibility and loadURL completion are different
endpoints, not interchangeable launch scores. Do not combine a post-reload renderer
snapshot with the initial main launch snapshot. This proposal does not impose an SLA.

## Limits and next qualification

Default-off startup preserves existing service order, synchronous installation/profile
safety, window options, loadURL await, lazy pages and connection behavior. The extra
module definitions, flag branch, optional mark calls and no-op layout-effect call
still have small unmeasured overhead; this is not a zero-overhead claim. Opt-in probes
also perturb timings. Collect comparable cold/warm runs only after actual-checkout,
type, format, desktop and browser qualification.

A separate externally owned monotonic launcher clock is needed to quantify pre-main
time; do not estimate it by subtracting unrelated process/browser clocks. Leave the
Linux portable `ldd | awk | sort` safety check intact. Its cost is not measured here.
Do not reorder or defer installation/profile safety or any service based on these
source-only observations.

The isolated fake-clock helper suite covers bounded retention, first-wins behavior,
copies, missing/invalid samples and separate domains. It does not run Electron,
React, preload, a browser, the launcher, device operations or the application import
graph. Integration and real timing observations remain pending.

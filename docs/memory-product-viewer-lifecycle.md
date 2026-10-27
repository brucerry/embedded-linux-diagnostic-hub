# Actual viewer lifecycle qualification helper

This packet adds only new test fixtures, pure controls and this document. Existing App, FlowViewer,
Page, runner, storage, API, worker, raster, private Vite instrumentation and memory policy files are
unchanged. Actual UI/browser/native/ACK/owner coverage remains pending primary integration. Pure
gate tests do not count as actual browser Workers, exports, captures or product qualification.

## Verified source behavior

`FlowViewer` opens lazily from `FlowViewerEntry`. While a run is busy its model selects the frozen
active plan. Showing, closing and moving the view calls no transport or runner method. There is no
separate Cancel export control. Escape, Close dialog and parent view unmount invoke the real
component cleanup: end pointer gesture, abort a foreground raster job, detach its Worker handlers,
terminate its Worker, clear the existing export deadline and revoke its Blob URLs. The same normal
worker cleanup runs after success/error/fallback. The existing deadline remains30seconds.

`export.worker.ts` receives the actual scene/format/downscale request. An engine without worker
OffscreenCanvas requests the existing foreground fallback. Its normal try/catch runs real
`exportRaster` and reports the actual result or thrown error. `raster.ts` checks the foreground
AbortSignal around real yielding work and resets each created canvas to1×1 in finally. That is a
logical backing-store release request, not physical GPU/allocator/GC acknowledgement.

## Live-run isolation interface

Install `new ProductViewerWorkers(page, exactCompiledExportWorkerUrlPredicate)` before exports. The
predicate must bind the actual built worker URL/file to the qualified source, not guess an unrelated
worker. Every observed Worker receives a unique ID and a close promise from its real Playwright
`close` event. Baseline tokens preserve exact identities, including closed history; removed baseline
workers cannot hide newly created workers. Observer state is explicitly test-only. It uses no timer,
terminates nothing, and supplies no product-owner zeros.

Comparison tokens are explicitly released in helper finally blocks. Successful export helpers retire
only the exact witnesses whose actual close events the caller joined, after releasing all comparison
tokens. Retirement is refused while any token is active; a released token cannot be queried again.
This prevents closed wrapper history from growing across same-page cycles while preserving monotonic
observed/retired counts and unique IDs. Store the returned close receipts in the caller's evidence
sink, not in an unbounded in-memory list. Run helper comparisons exclusively; do not retain an outer
observer token around a helper that must retire its closed witnesses. Failed/unjoined records remain
tracked for caller teardown and cannot be retired as closed.

```ts
await exerciseViewerWhileLive(page, {
    transport: 'serial', // or 'ssh'
    expectedViewerIdentity: actualFrozenActivePlanId,
    repeatCount: explicitProfileCount,
    readCheckpoint: readActualHeldProductCheckpoint,
    workers,
});
```

The caller first starts a genuine actual automation run and withholds its actual Serial prompt or
SSH fixture gate. It owns release/termination. `ViewerLiveCheckpoint` requires actual active
plan/run identity, arm generation, capture ID/state, busy/cleanup state, dispatch count,
transport-written bytes, received bytes and committed bytes, plus the still-held target identity.
The helper opens/closes the actual active viewer repeatedly using both normal Close and Escape,
checks every actual checkpoint against the first one, and refuses any unexpected export Worker. It
sends no command, releases no real target, and changes no ACK.

When actual ACK evidence exists, provide its count, ordered trace SHA256 and exact pending IDs.
Equal counts or an equal-sized replacement cannot pass. Unknown ACK fields must be explicit
`{status:'unsupported',reason}`; they never become0 or an exact-preservation verdict. Actual probes
and trace provenance are caller-owned and must be reviewed; this type cannot turn modeled inputs
into actual evidence. Missing required live fields prevent live coverage instead of being guessed.

## Export cancellation, unmount and failure

`exerciseViewerExportLifecycle(page, options)` accepts `action:'close-held-request'`,
`'unmount-held-request'` or `'codec-failure'`, PNG/PDF format, the installed worker observer and
caller-owned `joinWorkers(witnesses)`. Join each supplied `witness.closed` under the caller's
existing workload watchdog. The helper independently requires that the exact actual close event was
observed afterward; a caller callback returning early cannot create a pass. No helper deadline,
timer budget or product watchdog is added/changed.

Close uses actual Escape. Unmount requires `unmountViewer()` to perform real UI navigation or real
parent unmount; do not remove DOM or invoke worker cleanup manually. Supplying a live checkpoint
also requires that this action preserve the actual held run. An intentionally run-cancelling App
unmount belongs in a separate caller-owned lifecycle case and must not be described as live viewer
isolation. Without a live checkpoint the helper reports runner/ACK preservation unassessed.

The failure case first waits at the real encode boundary, then releases that gate to throw
`Private synthetic viewer codec boundary failure.` The existing product catch path must show that
error, restore the actual export buttons and emit no download. This is a synthetic boundary fault;
the underlying native codec is not invoked and no native codec defect is claimed. The worker
Offscreen path and actual foreground fallback are both supported by separate real realm probes. The
helper never fabricates a success/error message or normal worker termination.

The caller must join all observed workers, including fallback workers, and close the actual page
before `workers.dispose()`. Disposal then unregisters only observer-owned EventEmitter listeners. On
assertion failure the helper removes its download observer only; caller teardown uses the actual
product/page disposers and joins. It does not force-release a held request, terminate a worker,
clear a product timer, reset resource counters or hide failed cleanup.

## Minimum private integration, exact guards

The new browser-only module is `tests/fixtures/memory-product-viewer-faults.ts`. It creates no
automatic global hook on import. `installViewerFaultRealm('page'|'worker')` exposes the actual
realm-local `globalThis.__memoryProductViewerFaults`. Its methods are `arm`, `requestTicket`,
`enterRequest`, `beforeCodec`, `status`, `release`, `clear`. Counters are monotonic; clear refuses a
pending gate and only clears settled injection configuration. Gate AbortSignal listeners are
actually removed on natural settlement. No native resource counts are supplied.

Apply these changes only through the primary's reviewed private build transform. Public product
sources remain unchanged. First compare the full integration preimage SHA256 values in the packet
manifest, then require exactly one occurrence of every exported `VIEWER_PRIVATE_NEEDLES` string
(`assertViewerPrivateSourceNeedles` is read-only). Abort on changed hash/needle/count; do not
broaden or silently skip a failed guard.

1. In the private FlowViewer transform add an import of `installViewerFaultRealm` from the new
   fixture and a module-local `const privateViewerFaults = installViewerFaultRealm('page')`. Replace
   the exact existing `task.postMessage({ scene: graph, format, downscale });` with:

    ```ts
    task.postMessage({
        scene: graph,
        format,
        downscale,
        __memoryProductViewerFault: privateViewerFaults.requestTicket(format),
    });
    ```

2. In the private export.worker transform import/install the same module with explicit worker realm.
   Immediately after its exact `const { scene, format, downscale } = event.data;` insert:

    ```ts
    await privateViewerFaults.enterRequest(
        (event.data as typeof event.data & { __memoryProductViewerFault?: unknown })
            .__memoryProductViewerFault,
        format,
    );
    ```

    This gates the genuine request before the existing OffscreenCanvas fallback check. A cancelled
    held request is destroyed only by the real component's normal Worker termination. No product
    response message or canvas-support result is replaced.

3. In the private raster transform import/install the same module, inferring page versus worker from
   `typeof document`. Its exact encode needle is `await yieldControl();` followed by `const blob =`.
   Insert between those lines:

    ```ts
    await privateViewerFaults.beforeCodec({ format, mime: type, signal: options.signal });
    ```

    The original native codec expression, error handling and canvas finally remain unchanged. The
    hook waits once and throws before that expression only for the matching explicit fault ticket.
    On the real foreground AbortSignal it rejects normally and removes its own abort observer.

`productViewerFaultControl(page)` reads these real page/Worker globals through Playwright. Missing
hooks return unsupported; no export fault is counted. Request tickets transfer only through the
private extra field of the actual existing postMessage. Two-phase held codec failure ensures the
actual boundary/realm is observed before the existing catch terminates its Worker. There is one
added await per instrumented boundary even when unarmed; private source/runtime identity must bind
these test transforms before any future calibration. SVG has no codec fault coverage.

Browser API ledger integration, actual foreground canvas dimensions/collection, object URL
revocation/deadline cleanup, renderer/native worker/process destruction, serial/SSH ACK capture
probes, platform qualification and full memory policy/calibration remain parent-owned and unrun.

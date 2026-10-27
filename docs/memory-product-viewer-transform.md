# Private viewer transform integration

This new test-only module adds reviewed source transforms without modifying product files, the
existing primary instrumentation plugin/config, Page identity probes or the existing viewer
lifecycle helper. It guards complete input bytes before injecting three literal boundaries. Its
receipt is source-build evidence only; actual UI/export/Worker closure, ACK isolation, native
execution and memory qualification remain unassessed.

## Wiring for the private Vite production build

```ts
import { createPrivateViewerQualification } from './tests/fixtures/memory-product-viewer-transform';

const viewerQualification = createPrivateViewerQualification({
    sourceRoot: absoluteCandidateRoot,
    purpose: 'private-product-qualification',
});

// Preserve all existing plugins and worker options. Create new worker plugin
// instances per invocation; Vite 8.3.2 uses a separate worker build graph.
plugins: [viewerQualification.renderer, ...existingPlugins],
worker: {
    ...existingWorkerOptions,
    plugins: () => [
        ...viewerQualification.workerPlugins(),
        ...existingWorkerPluginFactory(),
    ],
},

// After actual successful build, retain this receipt with final compiled assets.
viewerQualification.assertComplete();
const sourceTransformReceipt = viewerQualification.snapshot();
```

The factory and plugin require an absolute canonical source root, explicit private purpose, build
command and matching renderer/worker role. Do not add this plugin to a public/shipping build. The
caller must retain its private build config, actual compiled worker asset hashes/URLs, final
composed source identity and runtime launch identity. No runtime workload or native codec is
exercised by this plugin itself. It adds an awaited private gate at each encode boundary, including
the unarmed fast path; private-build identity and any later timing results must disclose that
instrumentation.

Full preimages (SHA-256):

| Input                                            | Required SHA-256                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `src/features/automation/flow/FlowViewer.tsx`    | `d3c6cfd35911e6a865a6c59e3b2d1896dd5cd3b836afefd320008872e350532d` |
| `src/features/automation/flow/export.worker.ts`  | `4ed04a744b3beda250d5f5faf9511074b1ccc333d819f31907f7e358a53b0ff3` |
| `src/features/automation/flow/raster.ts`         | `274cb6fcddcc1a616fff2209ff3e33222c4e842519c26982e8f79dfd8c7499bd` |
| `tests/fixtures/memory-product-viewer-faults.ts` | `46cd391f8419d6d5dbc74db2b3ff5bf5eb8e52a83a36703d9dfda27c1facfa95` |

The factory checks these actual on-disk bytes at construction, resolved config and final assertion;
each executable module transform independently checks the full source hash and unique literal
needle. It rejects upstream transformations, changed source and repeated application. Fresh
exact-source calls are deterministic and counted. Renderer coverage needs viewer/raster/faults; a
completed actual worker graph needs worker/raster/faults. An unrelated worker, generated worker
wrapper, `?raw` or `?url` import supplies no executable coverage. `?worker_file&type=module` is the
actual worker source. Missing `worker.plugins`, incomplete graph, wrong root/role, build failure or
missing module blocks completion. Snapshot copies cannot mutate the gate. Its `runtimeCoverage` is
always `unassessed`.

## Actual boundaries retained

FlowViewer keeps its static
`new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })` constructor. The
only request change adds the private fault ticket to the existing `task.postMessage` object. No new
product message is sent. The page realm is installed once through the accepted module's global
singleton.

The dedicated worker installs the worker realm and awaits `enterRequest` immediately after
destructuring the existing real event payload, before the existing OffscreenCanvas fallback. Its
success/progress/error message and catch logic remain unchanged. The triple-slash WebWorker type
reference remains first.

Raster installs the inferred page/worker realm. It awaits
`beforeCodec({format,mime:type,signal:options.signal})` after the existing yield and before the
unchanged native codec expression. The normal AbortSignal checks, existing deadline, canvas
`finally` reset, actual URL revocation and normal Worker disposer are preserved. The accepted
private module holds a genuine request or holds then throws a synthetic exception at this boundary.
The synthetic codec exception does not call the native codec and must not be reported as a native
codec failure.

## Primary integration and pending evidence

The primary owns config wiring (including worker.plugins), actual live Page arm/identity hooks,
native Worker-close joins, caller target release and actual running captures. A frozen viewer
identity and runner-generated capture run ID are distinct: do not conflate them. This new module
does not touch the existing lifecycle helper or its primary-owned identity correction.

After composing, run actual live Serial/SSH viewer close/navigation with genuine stalled target
release; actual worker-request cancellation through normal Close/Escape/unmount; actual held codec
synthetic failure and foreground AbortSignal settlement; exact Worker close events; real
runner/capture/viewer generation identities, output and ACK ordering before/after. Keep App unmount
that intentionally cancels a run separate from viewer-only close. Missing ACK/owner probes stay
unsupported. No forced cleanup, fake postMessage outcomes, reset counters or deadline changes are
introduced. Source-only controls cannot close those actual UI, runtime, owner, memory/calibration,
platform or release gates.

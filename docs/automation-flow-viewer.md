# Automation flow inspection

Choose **Show flow** in Automation to inspect the authored command order. The popup uses the
existing command list; arrows always connect command 1 to 2, 2 to 3, and so on. Disabled commands
remain visible. Dragging a card changes only its position in this popup. Closing the popup discards
the layout and restores focus to Show flow.

The header identifies the next-run draft or the frozen active plan, including its snapshot identity,
schedule, repetition and timeout. Editing the draft after arming does not change the active graph.
After a run, the View selector can inspect the latest frozen plan separately from the next draft.
Running state comes from the existing runner. Recorded completion labels identify their actual
recorded run; a pending, paused or unknown state never implies successful execution. Serial prompt
observation is not proof of command success. The viewer retains bounded completion metadata and does
not subscribe to terminal output or capture raw output.

Hover or focus a card to inspect its full command. Click, Enter or Space pins its details. The
details remain selectable and scroll for long commands. Tab visits controls and cards in command
order. Arrow keys nudge a focused card, with Shift for larger steps; on the canvas they pan. Plus
and minus zoom, F fits the graph, R resets the layout, and Escape closes. Ctrl + wheel zooms at the
pointer. Reduced-motion preferences disable optional visual transitions.

## Local exports

SVG, PNG and PDF capture every command, edge, layout position and available status at the moment of
the export, independently of the visible viewport. Each includes snapshot identity/time and a full
command appendix. These files are inspection snapshots, not execution proof or QA capture exports.
Commands may contain secrets; the popup discloses that before export. No upload occurs.

SVG uses escaped plain text and controlled shapes. It contains no scripts, links, foreignObject,
external fonts or image resources. Bidi and non-printing controls are shown as explicit Unicode
escapes. PNG is limited to 8 megapixels and 16384 pixels per side. Oversized scenes require the
explicit Allow PNG downscale option, SVG, or PDF; they are never silently cropped. This conservative
32 MiB RGBA budget is below the design's proposed 16-megapixel ceiling to bound codec/memory stalls.

PDF uses A4 landscape pages: an overview, overlapping numbered graph tiles at approximately
10.9-point card text, and measured 11-point full-command details. Overlap ensures each card is whole
on at least one tile. Tile row/column references identify arrow continuation; detail page headers
retain command references when a long command continues. The export is limited to 128 pages and 32
MiB, and explains failures instead of returning a partial document.

## Implementation and qualification

The small entry module is eager. Dialog, styles, layout and export code load only on explicit use.
There is no graph or PDF package, dependency installation, network service, new IPC, native Save
permission or print dialog. A local module worker normally draws and encodes the export. Engines
without worker canvas use the same renderer in short asynchronous batches with native asynchronous
canvas encoding. Closing aborts this work; workers, callbacks, listeners, timers, object URLs and
canvas allocations belong only to the viewer and are released on completion/error/close.

PDF is a deliberately restricted image-only PDF 1.4 serializer: a page tree and JPEG image XObjects.
The raster pages preserve the system font's Unicode appearance without bundling or downloading
fonts. Missing system glyphs remain a platform font limitation. PDF text is rasterized and is not
searchable, selectable, tagged or PDF/UA. SVG retains text. JPEG encoder MIME/signature checks
reject an engine's unsupported-format fallback instead of embedding an invalid page.

This shared browser/Electron route replaces the proposal's separate native printToPDF mechanism in
the isolated candidate. It respects this task's prohibition on shared API edits. The primary
approved this explicit design revision during implementation; PDF acceptance and reconciliation of
OpenSpec task 3.4 still depend on qualification. This patch does not claim that native printToPDF
was implemented.

The serializer follows the image XObject, DCTDecode stream, page-tree and cross-reference structure
in [ISO 32000-1](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf).
Canvas encoding and its unsupported-format behavior are documented by
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob). No
third-party PDF code or font licensing is introduced; source retains the repository MIT license.

Focused qualification is in `tests/automation-flow.test.ts`, `tests/ui/automation-flow.spec.ts`, and
`tests/automation-flow-desktop-smoke.ts`. The separate `playwright.flow.config.ts` runs Chromium,
Firefox and WebKit on port 5181. The desktop fixture exercises production renderer assets and a
secure local scheme with sandbox/contextIsolation, without privileged preload or export IPC. Its
transport is synthetic. Durable capture ACKs, integration into the primary's latest runner/storage
work, aggregate platform/package checks and independent review remain integration gates.

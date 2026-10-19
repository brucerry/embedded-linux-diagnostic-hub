## Implementation

- [x] 1.1 Typed measured progress with separate indeterminate stages.
- [x] 1.2 Bounded native receipt and observed version/location confirmation, clean mode included.
- [x] 1.3 Validated native folder access, destination UI and cancellation icon.

## Qualification

- [x] 2.1 Success/cancel/failure/unknown-total/platform/receipt/path-boundary tests.
- [x] 2.2 Full applicable local gates and review before publication.

## Expanded platform qualification

- [x] 3.1 Supplementary Windows downloader/cold-launch/host checks (qualified pre-platform fixture).
- [x] 3.2 Linux distinct future-version AppImage fixture, progress/destination/checksum/new-process
      confirmation and existing CI wiring.
- [x] 3.3 Mac x64/arm64 unsupported-auto/manual guidance/bundle tests, normal helper launch
      observation and existing native CI wiring.
- [x] 3.4 Expanded local gates/review; native Linux/Mac evidence pending authorized execution there.

## Exact-source qualification evidence

Reviewed source dd71117299982c869dbcd187079e7951b60ac878 passed Windows run 38519414918, Linux run 38519414947 (distinct future AppImage handoff and all seven GNOME cases), Mac run 38519414945 (x64 and arm64 manual guidance/path/helper and normal launch), and website run 38519414888. Parent independently verified these runs at 06:24 UTC on 2026-10-14; local API checks also confirm each workflow succeeded at that source.

The updater alias correction has 29 passing focused tests and full verification with 224 passing tests, 11 platform skips and zero failures. Trusted ancestor aliases are normalized while redirected roots/descendants and changed checksums are rejected. Validation assumes a stable filesystem during checks/use; no descriptor-based race prevention or historical ancestor pinning is claimed. The original hosted runner alias identity was not recorded and is not claimed proven.

Stable release publication is a separate pipeline action, running in guarded workflow 38523035861 after the approved v0.5.1 tag push. Qualification tasks are complete; physical Mac/quarantine and office UART evidence are not claimed.


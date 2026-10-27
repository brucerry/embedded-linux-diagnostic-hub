# Final platform and artifact gates

The release workflow consumes the staged packages before publication. Passing a development bundle,
a portable launch, a model test, a different source revision or a previous package is not installer
or product qualification. All gates below are required; an absent, unsupported, skipped, failed or
unrun result blocks publication. This document describes gate infrastructure, not a claim that the
current v0.6.0 candidate has passed it.

## Catalog and ordering

The canonical catalog retains every existing portable, Mac, web, gateway and helper asset. Versions
before0.6.0 keep their original24-file inventory. Starting with0.6.0 prereleases, it additionally
requires the existing packager outputs:

- `Diagnostic-Hub-Windows-x64-Setup.exe`
- Its `.sha256` checksum
- Its `.info.json` descriptor, binding version, source commit, exact bytes/SHA256 and internal
  payload-manifest SHA256

There are27 public files. The descriptor is metadata and does not acquire a separate checksum asset
or publisher-authentication claim. `scripts/lib/windows-setup-release.mjs` remains its schema
authority. The Windows build invokes the existing packager and uploads those exact outputs.

Four native staged-consumer jobs follow the existing website, Windows, Linux and two-architecture
Mac qualification workflows. They download the existing Actions assets; Mac ZIPs are read directly
from the unpublished draft. Only receipts/logs are uploaded from Mac: no new Mac binary Actions
artifact/cache is introduced. The final publisher re-downloads assets, rehashes them against all
receipts, and repeats that guard inside the publication command immediately before its final write.
The pinned historical recovery command retains its separate immutable recovery contract.

After actual publication, `published-assets` anonymously downloads every exact-tag public asset and
validates inventory, source, checksums and descriptors. Native published Mac command tests then
consume that same explicit tag. Post-publication URLs cannot substitute for prepublication native
gates, and prepublication draft URLs do not claim public availability.

## Native consumers

Run only on the named native OS/architecture:

```sh
node scripts/staged-artifact-gate.mjs consume win32-x64
xvfb-run -a node scripts/staged-artifact-gate.mjs consume linux-x64
node scripts/staged-artifact-gate.mjs consume darwin-x64
node scripts/staged-artifact-gate.mjs consume darwin-arm64
node scripts/staged-artifact-gate.mjs verify-producers
node scripts/staged-artifact-gate.mjs verify
```

The checkout must be clean and match `GITHUB_SHA`, `GITHUB_REF_NAME=v<package-version>`,
`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. Receipts also bind the Git tree, observer executable hash,
Node/OS/architecture, exact package/helper/metadata hashes and case logs. Required source helpers
and checksum sidecars are verified before executing an asset. Native identity records actual
packaged version, running executable/ASAR hashes, Electron/Node/Chromium versions, separated
renderer contexts, absence of page Node globals and the actual renderer sandbox (native process
metrics on Windows/Mac; Linux `/proc`NoNewPrivs/Seccomp). Missing observations fail closed.

Windows consumes the actual portable EXE. Linux consumes both AppImage and extracted complete tar
archive. Mac consumes the actual installer-helper result. Existing desktop/native-window tests run
against the selected staged executable; no source-build/development fallback is allowed. These tests
perform authenticated loopback SSH only. They do not open local UART ports or qualify DUTs.

Outputs live under `validation/platform/` (override with `HUB_PLATFORM_EVIDENCE`). Every command
must exit normally with code0 and no signal; command evidence is bounded to16MiB per log. Failed
commands write a blocked receipt. Evidence is rehashed before publication. Runtime profiles, memory
ceilings and calibration are owned by the product qualification workflow, not chosen by this gate.

## Required installer receipt input

For each native lane, a real installer qualification producer must supply
`validation/installers/<lane>.json` (or `HUB_INSTALLER_QUALIFICATION`), with evidence paths relative
to that input directory. In Actions upload the input and its evidence as
`installer-qualification-<lane>`. The producer is not supplied by this patch; missing input blocks
publication. Existing portable/native/model tests cannot produce an installer success receipt.

Use `schemaVersion:1`, `kind:"native-installer-lifecycle"`, `status:"passed"`, the final `version`,
`sourceCommit`, `sourceTree`, `lane`, actual `runtime` and exact `artifacts` returned by
`laneFiles(version,lane)` plus `hashFile`. The schema is exported from
`scripts/lib/staged-artifact-gate.mjs`. Runtime includes `platform`, `arch`, `osRelease`, Node24
version, absolute observer `executable` and `executableSHA256`. An independently reviewed receipt
also includes `review:{reviewer,reviewedAt}`. That metadata records external review; schema
validation itself does not perform independent review or infer that a command was meaningful.

Every required case contains
`{id,status:"passed",command:[...],exitCode:0,signal:null,evidence:[...]}`. Evidence entries are
`{path,bytes,sha256}`; files must exist, remain inside the receipt root and match their recorded
bytes/hash. Case IDs are the following names prefixed with `windows-nsis:`, `macos-bundle:` or
**both** `linux-folder:` and `linux-appimage:`:

- `install`
- `offline-launch`
- `busy-refusal`
- `repair`
- `update-distinct-version` (manual native bundle replacement on Mac, not automatic Mac updating)
- `interrupted-recovery`
- `profile-report-preservation`
- `owned-integrations`
- `remove`

There are nine required Windows cases, nine per native Mac architecture and eighteen Linux cases.
These are actual final-package lifecycle requirements. Earlier snapshot acceptance, mock adapters,
native startup alone and portable helper Save/Open do not close them. The separate approved native
execution/installation authorization still governs running those producers.

## Required full-product artifact inputs

Primary-owned real product drivers must supply `validation/products/<lane>.json` (override
`HUB_PRODUCT_QUALIFICATION`) uploaded as `artifact-qualification-<lane>`. Scope is `desktop-<lane>`.
The consumer copies verified input evidence into its own receipt bundle.

Web and gateway producers supply `validation/platform/web.json` and `gateway.json`, with evidence
relative to `validation/platform/`, uploaded as `artifact-qualification-web` and
`artifact-qualification-gateway`. Both exact final archives and checksum sidecars are mandatory.
There is no checksum-only promotion or receipt fabrication in the workflow. Producer jobs remain
primary-owned integration work; until they emit actual evidence the new release jobs remain blocked.

Common producer fields are `schemaVersion:1`, `kind:"staged-artifact-producer"`, `status:"passed"`,
`scope`, final source/version/tree/run/attempt, actual observer `runtime`, exact `artifacts`, and
`qualificationScope:"full-product"`. Include `reviewedPolicySHA256`, `runtimeProfileSHA256`, and
separate `normalGC`/`forcedGC` results, each with passed status, actual `elapsedMs`>=1800000,
`completedCycles`>=100 and the underlying `receiptSHA256`. These minimum duration/cycle gates come
from approved durable-capture task4.8; this script does not select memory/slope thresholds. Native
addon absence and exact loader provenance remain required for gateway/desktop runtime profiles.

Case IDs:

| Scope            | Required case IDs                                                                                                  | Additional fields                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `desktop-<lane>` | `desktop-production-runtime-profile`, `desktop-product-resource-qualification`                                     | `electronVersion:"44.5.1"`, `optionalNativeAddon:"absent"`, `loaderProvenanceSHA256`; native OS/architecture must match lane |
| `web`            | `web-archive-source-integrity`, `web-chromium`, `web-firefox`, `web-webkit`, `web-product-resource-qualification`  | Actual nonempty `browserVersions.chromium/firefox/webkit`                                                                    |
| `gateway`        | `gateway-archive-source-integrity`, `gateway-production-runtime-profile`, `gateway-product-resource-qualification` | `optionalNativeAddon:"absent"`, `loaderProvenanceSHA256`                                                                     |

The same command/evidence schema applies. `producerFiles` and `producerCases` export exact scopes.
Component passes do not qualify full product. The producer must bind underlying policy/runtime/soak
receipts into the retained case evidence; their review remains required. This patch has run only
synthetic gate/catalog regressions and static checks locally: no current-source platform installer,
packaged consumer, native resource lane, calibration, public CI or published-URL check is claimed.

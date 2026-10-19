# Freshly approved Windows native install attempt: actual outcome

Direct user confirmation was received for one disposable install and launch under Task/setup-qa with
only its own per-user shortcut/uninstall registration and separate UUID profile. It does not
authorize uninstall, permanent deletion, device access, or changes to existing
applications/profiles. No renewed action-approval denial occurred.

The current private artifact was independently reviewed for wizard presentation: source
d0cbd47f7f0676b01c82accdc643c81d1cf91c2d, actual version 0.5.2, setup SHA256
6d1c96c660c732eca52e2556658429b0b62526a1899ffd1196710b2421557526, 236707631 bytes, ASAR SHA256
c50a37585b937e18d91eb6b05a4e5bbb103a560d01edb47bd325a275d482fd17. The compiler/source snapshot,
native wizard review and artifact hashes agree. The old harness guard was reconciled to that exact
reviewed artifact, tightened with SHA/size/snapshot checks; target/integration/profile effects
remained unchanged. The original harness/receipts and reconciliation patch are retained.

Two guarded harness runs occurred, with only one actual Apply:

- native-install-install-d2da4f8f: reached Review, stopped before Apply because the old harness
  expected the complete path in UI Automation Name rather than the reviewed readonly Edit value.
  Target absent, no app launched, no remaining setup; existing profile-directory inventory
  unchanged. The harness was corrected to read two owned native path controls while retaining
  current page/Next count/target-absence/binary-hash assertions.
- native-install-install-74888990: native Review paths/options were attested, then actual
  Install/Apply ran with Start menu Yes, Desktop No and Launch No. The worker refused
  `Payload paths must be regular, unlinked files.` before target activation/installation-ID
  creation. No target app, matching registration/shortcut or Diagnostic Hub test profile was
  created. Launch was not attempted because no valid installed app existed. Existing profile
  inventory stayed at three directories with identical name hash; existing profile contents were not
  read, so contents preservation is not independently qualified.

The error modal prevented the old harness's normal cancellation path; after its bounds expired, it
terminated only its attested setup PID/path/creation identity. No unrelated process was controlled.
The 256843 ms Apply wait includes the completion timeout and cancellation handling; it is not
installation latency or a launch measurement. All task evidence and temporary source/recovery
material remain retained; no uninstall or permanent cleanup occurred.

Root cause is now verified with an actual read-only Electron 44.5.1 application-mode probe, without
a Diagnostic Hub window, Node-mode override, security flags or installer retry. Against the exact
43,418,777-byte ASAR from the failed worker:

| API view                           | isFile | isDirectory | nlink | bytes      |
| ---------------------------------- | ------ | ----------- | ----- | ---------- |
| Electron node:fs and fs.promises   | false  | true        | 1     | 0          |
| Built-in original-fs physical file | true   | false       | 1     | 43,418,777 |

The physical checksum exactly matches the reviewed compiler ASAR. Separately, ordinary Node
inspected all 101 extracted declared payload files and found every one regular/single-link, with no
bad paths; the generated uninstaller was also regular/single-link. The worker uses the patched
filesystem view, so its correct physical-file guard rejects the virtual directory.

The next fix must use a localized physical-filesystem adapter for setup/installed payload
verification, copying, inventory, guarded mutation and cleanup; merely skipping app.asar or
weakening regular/single-link/hash checks is unacceptable. Preserve normal application ASAR loading
instead of globally disabling archive semantics. Plain-Node model tests are insufficient: add an
Electron application-mode disk-file regression, independently review the source, then build/seal and
qualify the changed private payload before another install attempt. Fresh user approval remains
available for the unchanged disposable effect scope; no repeated permission request is needed solely
for a properly reviewed build refresh.

Exact receipts: native-install-approved-current-outcome.json; native-electron-asar-fs-proof.json;
native-install-runtime-failure/filesystem-inspection.json plus retained request/response/payload
descriptor; native-install-approved-current-plan.json; native-install-current-harness.patch;
native-install-path-guard-fix.json. The Linux successor 17-file source checkpoint remains separate
and unadopted.

Primary API contract:
https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file
. Pinned implementation:
https://raw.githubusercontent.com/electron/electron/v44.5.1/lib/node/asar-fs-wrapper.ts and
https://raw.githubusercontent.com/electron/electron/v44.5.1/shell/common/asar/archive.cc .

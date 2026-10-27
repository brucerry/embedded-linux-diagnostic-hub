# Linux read-only entry packaging (new reconstruction)

`build:desktop` retains its existing main/preload command and then bundles
`scripts/linux-setup-review.cts` into `dist-electron/linux-setup-review.cjs`.
Linux x64 `linux-after-pack.cjs` publishes that bundle and a closed, <=4096-byte
`resources/linux-setup-review.json` capability before the unchanged portable
AppRun handling. Both new outputs are exclusive, synced and read back; partial
files remain on failure. Other platforms return before this packaging path.
The physical entry is also included in app.asar through dist-electron. The existing
package verifier compares both copies and the capability against build output.
No build or native verifier has been executed for this source slice.

The capability binds version, fixed entry, byte length and SHA256. It explicitly
states `mutation:false`, `nativeBinding:false`, and `provenance:unverified`.
It is package consistency data, not authentication, a commit/build attestation,
a trusted acquisition receipt, or a claim that Electron Node mode is available.
A future build must still bind its actual source tree, dependencies and outputs.

A flat portable AppImage/tar package is NOT an AppDir setup envelope. The local
read-only entry additionally requires the existing explicit `ROOT/app` layout,
`ROOT/diagnostic-hub-setup-payload.json`, and an exact regular-file manifest member
`app/resources/linux-setup-review.cjs`. Existing review guards and full payload
hashing must complete before any promptable review is returned. Capability checks
run inside that controller review, within its original logical window.

The existing entry uses that packaged Electron's Node mode (no end-user Node).
Only `--operation review` is admitted; install/repair/update/launch/rollback refuse
before opening a prompt. Helper decisions are data-only; they never spawn, fetch,
load the native binding, publish a menu, mutate an installation or claim a native
successor. The public downloader's permanent gate and portable/version/cache/
download-only behavior are unchanged. No new release asset/catalogue/workflow is
introduced. Production transaction dispatch remains disabled.

Still open: assembling/qualifying the explicit complete-folder envelope and its
actual payload descriptor, independently verified acquisition and helper launch,
Linux build/runtime/fuse/kernel/filesystem/menu/native lifecycle qualification,
compiled no-replace binding and real successor observation. This source is not
the missing historical 33-file aggregate; that lineage remains unavailable.

Regression definitions use one exact Node24 native-TypeScript command, with only
memory buffers and injected package IO. They do not import the top-level native
package verifier, build hook entry, CLI entry, backend, downloader or compiler.
Real disk publication semantics, symlink/race resistance, crash durability and
built artifacts remain untested. The package writer retains partial outputs on
failure; future invocation may need a distinct fresh output rather than retrying
an existing exclusive destination. Original launcher copy/chmod effects are not
qualified by the new fake tests.

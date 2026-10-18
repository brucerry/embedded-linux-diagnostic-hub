# Windows guided helper contract (v0.6.0 development)

The setup front door is implemented in local source and under review. No setup release or native
installation qualification is claimed. Published historical releases retain their original helper
and portable contracts.

With a qualified same-release setup asset available, the existing `download-run.ps1` entry point
selects a compatible published Windows x64 release, verifies its exact tag/source, setup descriptor,
SHA256 and byte count, then requests the ordinary current-user wizard. The wizard still requires its
own Review confirmation. The helper never submits installation consent or claims a ready app from
the setup exit code. Closing/cancelling setup leaves the verified download available.

| Option                   | Meaning                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `-Version vX.Y.Z`        | Pin the release; default discovery retains the existing published preview selection.        |
| `-Directory PATH`        | Download/cache folder, preserving its original meaning.                                     |
| `-DownloadOnly`          | Download the original portable `Diagnostic-Hub.exe`; never execute it.                      |
| `-Portable`              | Explicitly choose the original portable EXE instead of setup.                               |
| `-SetupDownloadOnly`     | Download setup, checksum and descriptor without running any program.                        |
| `-NoLaunch`              | Setup still opens for review, with application launch disabled; in portable mode save only. |
| `-InstallDirectory PATH` | Prefill the wizard's application folder; this does not create it or grant consent.          |

`-InstallDirectory` applies only to setup. `-SetupDownloadOnly` cannot be combined with portable
options. Unknown/silent/all-users arguments are rejected. No GUI or PowerShell `-NonInteractive`
means no automatic program launch; download-only remains available. Missing setup assets for an
older selected version produce an explicit same-version portable/download-only route. The helper
does not silently select another release or silently switch delivery.

The descriptor is `<setup basename>.info.json`, produced by the existing setup packager. It binds
product/platform/architecture, version/source commit, setup bytes/SHA256 and the validated input
payload-manifest hash. API/descriptor/checksum identity must agree. This is release integrity and
producer-declared provenance, not independent publisher signing. Ordinary Windows trust and
permission policy still applies.

Downloads use bounded HTTPS streaming, bounded strict JSON, and no credential/cookie forwarding.
Cache creation and activation check plain ancestors and native file/directory identities; existing
different content, aliases and hardlinks are retained and refused. New files use exclusive writes
and same-volume non-overwriting moves. Verified files stay read-locked through final reporting and
launch request. Private scratch cleanup removes only declared unchanged files and empty original
stages; identity failure preserves artifacts. These checks do not claim an OS sandbox or immunity to
every concurrent same-user filesystem race.

The helper does not create installed profiles, registry entries or shortcuts; those remain the
reviewed wizard backend's responsibility after user confirmation. It does not change execution
policy, elevate, install prerequisites, alter host permissions or interact with devices. Native
installer launch, held-file compatibility, actual installed paths/profiles, shortcuts, cancellation,
rollback and version/recovery behavior remain separate qualification gates. Tests intercept HTTP and
`Start-Process`; mocked success is not native acceptance.

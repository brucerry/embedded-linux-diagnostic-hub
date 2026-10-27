# Retired Linux Genie integration

Current source uses standard Linux window behavior. Genie delivery, setup prompts and
activation/removal commands have been removed. No existing system extension is disabled or
uninstalled. A new app window class prevents the old app-specific extension from matching while
preserving desktop ID, data and updater identity; see [window design](design.md).

Past release notes and source at their tagged revisions retain historical setup and qualification
evidence. Those published assets are unchanged. The current downloader rejects obsolete --no-genie
and --remove-genie flags and never manages extensions.

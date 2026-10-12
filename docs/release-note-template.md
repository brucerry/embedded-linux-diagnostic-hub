# Release page format

The release name equals its tag exactly. The body contains only the following four sections, in
order. Keep signing, qualification and other factual caveats inside Description or Changes. Every
Changes and Commits entry is a bullet; every Links entry uses name - URL.

```text
Description:
A few lines describing improvements, features and purpose.

Changes:
- Changes since the previous published release.

Commits:
- Each commit since the previous published release, including merged commits.

Links:
Full comparison - https://github.com/owner/repository/compare/previous...current
Downloads and setup - https://github.com/owner/repository/blob/current/docs/downloads.md
```

The generator fetches all published GitHub releases, including prereleases, and excludes drafts and
the current release. Unpublished tags never set the comparison baseline. The tagged checkout
validates ancestry and includes the complete commit range, so skipped RC tags create no gaps. Do not
edit a published page merely to reformat it.

Store literal future drafts in `docs/releases/<tag>.txt`; the generator prefers this format so
Markdown formatting cannot join labels or wrap Links lines. Existing `.md` notes remain supported
unchanged.

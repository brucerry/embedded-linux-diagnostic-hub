# Spec Delta

## Purpose

Define consistent future Diagnostic Hub release pages that accurately explain changes and include every commit since the prior published release, without changing existing public pages.

## ADDED Requirements

### Requirement: Exact release page format

The release name SHALL equal its tag exactly. The body SHALL contain only Description, Changes, Commits and Links sections in that order, each labeled with a trailing colon. Description SHALL describe improvements, features and purpose in a few lines; Changes and Commits SHALL contain bullet points. Each Links line SHALL use name - URL. Factual qualification and signing caveats SHALL remain within the four sections.

#### Scenario: Prepare a future release page

- **WHEN** release notes are generated for a release tag
- **THEN** the title equals that tag and the body uses exactly the required four sections with no extra top-level section

### Requirement: Published release comparison

The comparison baseline SHALL be the prior published release, including published prereleases and excluding drafts, the current release and unpublished tags. The commit list SHALL include all commits in the validated ancestry range, including merged commits. Previously published pages SHALL remain unchanged unless separately authorized.

#### Scenario: Intermediate RC tags were never published

- **WHEN** a new release follows one or more unpublished RC tags
- **THEN** its change comparison and commit list cover the entire range since the previous published release without omitting the skipped RC work

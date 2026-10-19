# Spec Delta

## MODIFIED Requirements

### Requirement: Exact release page format

The release name SHALL equal its tag exactly. The body SHALL contain only Description, Changes, Commits and Links sections in that order, each labeled with a trailing colon. Description SHALL describe improvements, features and purpose in a few lines; Changes and Commits SHALL contain bullet points. Each Links line SHALL use a meaningful Markdown label with its exact destination. Legacy name - URL source links SHALL remain supported. Factual qualification and signing caveats SHALL remain within the four sections. Explicitly authorized presentation-only formatting of a current page SHALL preserve factual text, all destinations and executable command URLs, with assets, tags and prior pages unchanged.

#### Scenario: Prepare a future release page

- **WHEN** release notes are generated for a release tag
- **THEN** the title equals that tag and the body uses exactly the required four sections with no extra top-level section

#### Scenario: Authorized current-page link formatting

- **WHEN** the user explicitly authorizes meaningful link labels on a current release page
- **THEN** only the reviewed link presentation changes, all destinations and facts remain identical and no asset, tag or prior release changes

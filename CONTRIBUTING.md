# Contributing

Contributions to diagnostics, parsers, accessibility, platform compatibility and documentation are
welcome. For substantial changes, open an issue first with the problem, proposed behavior and
client/target environments affected.

## Set up

Fork the repository, clone your fork and create a branch for one focused change. Install Node.js 24
and npm, then run:

```sh
npm ci
npm run desktop:dev
```

Use `npm run dev` for browser development. See the [development guide](docs/development.md) for
module boundaries and the [delivery guide](docs/delivery.md) for packaging and hosting changes.

## Make a focused change

- Keep desktop and website UI behavior shared and follow the existing module boundaries.
- Use four-space indentation and run `npm run format`.
- Keep automatic diagnostics capability-based, read-only and bounded, with explicit unavailable
  results. Add meaningful parser/SSH fixtures for missing tools, malformed data and partial
  failures.
- Keep sample data under `tests/fixtures/` and out of normal application startup.
- Update affected documentation. Keep the README brief and put detailed instructions in `docs/`.
- Never commit credentials, private keys, tokens, exported device reports, builds or caches. Redact
  sensitive information from submitted logs.

## Verify

Run `npm run verify` and the checks relevant to your change:

| Change                  | Additional checks                                                         |
| ----------------------- | ------------------------------------------------------------------------- |
| UI behavior             | `npm run test:e2e`                                                        |
| Desktop behavior        | `npm run test:desktop`                                                    |
| Website portability     | `npm run test:portability`                                                |
| Packaging or deployment | Applicable build/package checks in the [delivery guide](docs/delivery.md) |

Install the matching Playwright browsers before browser tests. Native desktop tests require a
graphical desktop or Xvfb. The [development guide](docs/development.md#verification) has the full
commands and platform notes.

Report the client OS, target distribution, commands tested and results. Distinguish automated
fixtures from actual-device validation.

## Open a pull request

Describe the problem, resulting behavior, validation and remaining limits. Link related issues and
keep dependency or formatting changes focused on your contribution. Required CI checks must pass
before merging.

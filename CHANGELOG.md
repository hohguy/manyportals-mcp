# Changelog

Notable changes to ManyPortals MCP. Each release's notes on GitHub are a selection from this file.

Versions follow [semantic versioning](https://semver.org). Dates are ISO 8601.

## Unreleased

Nothing yet.

## 0.1.9 - 2026-10-04

### Fixed

- The server now shuts down cleanly on `SIGTERM` and `SIGINT` instead of being killed where it stood. It already exited correctly when its client closed the connection, and that is unchanged. A shutdown that cannot finish still exits rather than leaving a process running with your tokens in memory.
- Two dependencies with published advisories were updated: `fast-uri` to 3.1.8 and `ip-address` to 10.7.3. Both reach the bundle through the Model Context Protocol SDK rather than being chosen here. The bundle you download no longer contains either advisory.
- The extension manifest asked for a setting that has not existed since the setup was simplified to one folder and one passphrase. It was harmless, because the server already refused to treat an unfilled setting as a file path, and it is now gone.

### Added

- **Releases are signed, and you can check that yourself.** Commits and tags carry an SSH signature, and the keys this project accepts are listed in [`.github/allowed_signers`](.github/allowed_signers), so you can verify a release without relying on the badge GitHub shows. [SECURITY](SECURITY.md) has the commands.
- This changelog.
- A [code of conduct](CODE_OF_CONDUCT.md).

### Changed

- **If you install from source, check out the release tag.** `main` now carries the latest release plus any documentation fixes made since it, rather than being identical to the last release. The README said the older thing and would have become wrong.

## 0.1.8 - 2026-10-02

The first public release.

### Added

- **Several HubSpot portals in one assistant.** Each portal has its own credentials, and every write states which portal it is for. A selected or default portal does not stand in for one.
- **Reading:** fetch a record, search with filters, list recently changed records, and summarise a deal or ticket pipeline.
- **Writing, through a lifecycle rather than a single call.** Every change goes `draft`, `validate`, `approve`, `execute`, with a step in between that reads the target record in the portal you named so you can confirm it before the write happens. Named drafts cover notes, tasks, calls, meetings and deal stages.
- **Per-portal permissions.** A write is refused unless its object type and operation are on that portal's allow lists. Owner and team fields, and the reserved pipeline and stage fields on object types other than deals and tickets, are refused whatever your lists say.
- **A check that catches swapped credentials at startup.** The server confirms that each token reports the hub ID you configured, and will not start if one does not match.
- **A check against reusing one portal's record IDs in another.** The server remembers which IDs it has seen in which portal. Read the limits in [SAFETY](docs/SAFETY.md) before relying on it.
- **An encrypted credential store,** so tokens need not sit in a plain file. One passphrase at runtime.
- **An append-only log** of each step, kept on your own machine.
- **`doctor` and `check-portals`,** a local setup report and a live read-only check you run yourself against your own portals before enabling writes.
- Targets HubSpot's 2026-03 API. Needs Node.js 22 or newer to run from source, or Claude Desktop for the extension.

### Notes

- Releases ship with writes in `propose` mode. Nothing is written without a person approving it.
- The go-live check has passed here against disposable test portals. Yours are not covered until you run it. See [GO-LIVE](docs/GO-LIVE.md).

## Earlier versions

There are none to list, and the reason is worth stating rather than leaving a reader to wonder why the history starts at 0.1.8.

Versions 0.1.4 through 0.1.7 were development builds. Three of them were briefly tagged here during setup and withdrawn the same day, before anyone had installed them, because each claimed to be the first public release and only one version can be. Their tags no longer exist, so nothing in this project's history refers to a version you cannot download.

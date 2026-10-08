# Changelog

Notable changes to ManyPortals MCP. Each release's notes on GitHub are a selection from this file.

Versions follow [semantic versioning](https://semver.org). Dates are ISO 8601.

## 0.1.10 - 2026-10-08

### Added

- **The safety page's "What it protects" section is now tied to tests that can fail.** [SAFETY](docs/SAFETY.md)'s "What it protects" section was prose that nothing checked, and a review found eight of its nine statements claimed more, or less, than the code does. Each sentence there is now one of three things: bound to a named test, marked as asserting nothing, or recorded as an observation of software this project does not control, with the client and version it was seen on, the date, and how to check it again. Editing a sentence without updating its test now fails `npm run verify`, and the check ships in this repository, so you can run it yourself. It covers that one section. The page's other sections are not bound to tests, and a segment marked as asserting nothing, or recorded as an observation, is not bound to an assertion test either.
- **`get_audit_log` accepts a `limit`.** It returns the most recent events rather than the whole history, which grows long on a system that has been running a while and had become too large for an assistant to read. Each event still reports its position in the whole log, and the result still reports the log's total, so a bounded read is easy to tell from a complete one. Nothing is deleted and nothing is hidden.

### Fixed

- **A claim about HubSpot's sensitive fields is withdrawn. Check the scopes on your key.** Earlier versions of [SAFETY](docs/SAFETY.md) and [USAGE](docs/USAGE.md) said that because ManyPortals never sends HubSpot's sensitive-data flag, HubSpot would not return the values of properties it has marked sensitive, whatever your configuration. That reasoning was wrong. The flag selects sensitive properties when you ask HubSpot to list property definitions, and it is not required to read a record's value: naming the property is enough, and HubSpot gates that on your token's sensitive-data scopes. ManyPortals does not read HubSpot's sensitivity marking and gives a marked field no special treatment, so a key holding one of those scopes can read those values through the ordinary read tools. If you granted a `sensitive` or `highly sensitive` scope because those pages said it was safe, treat that key as able to read the values and replace it with one that does not hold the scope. The pages now say that the scopes on your key, together with `blockedProperties`, are what set this boundary. Found by an independent review of the assembled release.
- **A recorded `fail` in the audit log does not prove the write did not happen.** The page said an `attempt` with no outcome after it was the one case where the log cannot answer the question. If HubSpot accepts a write and the reply is then lost, the log holds an `attempt` and a `fail`, which reads as conclusive and is not. [SAFETY](docs/SAFETY.md) now says to confirm in HubSpot before sending a failed write again, and names the cases that produce the ambiguity.
- **A field value that is another portal's record ID is now noticed.** The cross-portal check looked at the record a write targets and the records it links to, and not at the values being written into fields. So an ID belonging to one portal could be written into a field in another. In `apply` mode such a write is now refused; in `propose` mode the plan reports it before you approve. A value the server has also recorded against the portal you named is not flagged, which was already true of the existing check. The check compares against the IDs it has seen in each portal, not against what exists in HubSpot.
- A write that HubSpot accepted is no longer recorded as failed when the server cannot add its ID to the local index. The two are separate facts, and the log now says which one went wrong.
- In `propose` mode, a write is now refused if the server learns **after** you approved it that a field value belongs to another portal. An approval covers what you were shown, and that finding was not on the plan when you approved it. A finding that WAS shown and approved still goes through.
- **Two dependency advisories are cleared, one critical and one high:** `proxy-addr` to 2.0.8 and the Model Context Protocol SDK to 1.31.0. Neither is reachable from this server's code. `proxy-addr` arrives through an HTTP transport this server never loads, and the SDK advisory concerns its OAuth client while this server speaks over standard input and output. They are fixed regardless, because a package that ships with a critical advisory is one change away from being reachable.
- Values shaped like credentials are now removed from every message the server sends, not only from tool results. A call that did not match a tool's input schema was answered by the protocol layer before the server's own cleaning ran, and that answer repeated the argument names it had been sent.
- The server now shuts down cleanly on the signals Windows actually delivers, as well as on `SIGTERM` and `SIGINT`.
- Two gaps in each portal's default-deny policy are closed. An association's target object type is now checked against that portal's allowed objects, and a reserved pipeline or stage field belonging to a different object type is refused rather than treated as an ordinary property.
- `summarize_pipeline`'s description said it returns labels and counts only, while it also returns a stage ID. That ID is the one value `update_deal_stage` needs, and two other tools point at this one to supply it. An assistant told it cannot get a stage ID here would ask you to look one up in HubSpot for data it already had.

### Changed

- **The safety page now says what your client does, not what it ought to do.** Several sentences described the client asking you before a destructive step as though it always asks. Whether it asks depends on how you have set it, so the page says that and tells you to set it. [README](README.md) names the setting in the Claude Desktop extension and which tools it covers.
- **A pull request can be merged.** [CONTRIBUTING](CONTRIBUTING.md) said it could not, because the next release would overwrite the history it landed in. That stopped being true at 0.1.9, when releases began committing on top of the published history instead of replacing it. The development repository is still the source of truth, so a change that lands only here is taken back by the next release unless someone copies it across, and the assembler now stops and names the files rather than doing that quietly.
- The vault passphrase field is declared sensitive, and the safety page no longer suggests that masking it in one client settles where the value travels. It reaches the server as an environment variable, which any process owned by the same user can read.
- **Several published statements are corrected after three independent reviews of this release.** The security policy no longer asks you to report an approved write outside a portal's `applyAllowedObjects` as a vulnerability, since manual approval permits it, and it states the conditions on target inspection and on your client's prompts. Three pages said your own portal check was the first call to live HubSpot. Starting the server checks token identity before that, for each portal that has a hub ID configured, and those pages now say so. A portal left without a hub ID is skipped, so that check does not cover every configured token, and the go-live page no longer claims to be the first read either: the read tools work from the moment the server starts. The audit-log section no longer claims that a sequence number reveals the edit it tells you how to make. `doctor` is described as reading your local credential sources, which it does. The passphrase observation carries its client and version. The guide to portal keys gives the rule the software actually enforces, and the advice on replacing a leaked credential uses the credential type a new setup creates, since HubSpot is ending the creation of private apps. The notice about telemetry says what its check tests for, and the signing-key link resolves from inside a published package.

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

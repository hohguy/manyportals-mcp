# Contributing

Patches, bug reports and questions are welcome. Please read the note on how this repository is published first, because it changes what happens to a pull request.

## How this repository is published

This repository is assembled from a private development repository and published as a single commit per release. The private repository holds decision history and internal notes that are not published.

**A pull request here cannot be merged in the usual way.** The next release would overwrite the history it landed in. So the flow is:

1. Open an issue, or a pull request with the change you have in mind.
2. The change is reviewed here, in the open.
3. If it is accepted, it is applied in the development repository and ships in the next release.
4. Your pull request is closed with a link to the release, and you are credited in the release notes.

That is unusual, and it means you do not get a merge commit with your name on it in this repository. If that matters to you, say so in the issue before you write code, and we will discuss it.

## Before you open a pull request

- **Run the checks.** `npm ci && npm run verify` must pass. That covers linting, formatting, types, tests, a credential scan, and a plain-language check over the published documents.
- **Add a test for behaviour.** A change to routing, credentials, the write lifecycle, the audit log or the safety checks needs a test that fails without your change. Break your own guard on purpose and watch the test fail, then restore it.
- **No new dependencies** without agreeing it first. This server handles credentials for several businesses, and every dependency is a supply-chain risk.
- **Keep changes small and separate.** One concern per pull request. A refactor bundled with a fix is hard to review and hard to revert.
- **Match the surrounding code.** Strictly typed TypeScript, small functions, and comments that explain why rather than what.

## Areas that get extra scrutiny

Changes to portal routing, token handling, the write lifecycle, the cross-portal check, the audit log, or anything that touches HubSpot request shapes are reviewed against the safety model. Expect questions about what happens when the change fails, not only when it works.

If you are adding a HubSpot API call, say how you verified it. A claim about HubSpot's behaviour needs a source, a live check, or a note that it is unverified.

## Never include real data

Do not put tokens, record contents, real portal keys or hub IDs in an issue, a pull request, a test fixture or a commit message. Use the placeholders the repository already uses: `PORTAL_A`, `example.com`, `123456789`, `pat-...`.

Security problems do not belong in a public issue. See [SECURITY](SECURITY.md).

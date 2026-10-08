# Contributing

Patches, bug reports and questions are welcome. Please read the note on how this repository is published first, because it changes what happens to a pull request.

## How this repository is published

This repository is assembled from a private development repository. Each release is a commit on top of the one before it, so the history here is continuous and a commit you cite keeps resolving. The private repository holds decision history and internal notes that are not published.

**The development repository is the source of truth.** Every file the assembler owns is written from it at each release. A change that lands only here is taken back by the next release unless someone copies it across, and the assembler refuses to do that quietly: it stops and names the files it is about to overwrite. So a merged change cannot vanish without someone being told.

A pull request here can be merged. The change still has to reach the development repository to survive, so the flow is:

1. Open an issue, or a pull request with the change you have in mind.
2. The change is reviewed here, in the open.
3. If it is accepted, it is applied in the development repository and ships in a later release.
4. The pull request is closed with a reference to the release that carries the change, and the release notes say where it came from.

For most changes that means you do not get a merge commit with your name on it in this repository. If that matters to you, say so in the issue before you write code.

## Before you open a pull request

- **Run the checks.** `npm ci && npm run verify` must pass. That covers linting, formatting, types, tests, a credential scan, a plain-language check over the published documents, a check that every registered guard can still fail, and a check that binds the sentences in [SAFETY](docs/SAFETY.md)'s "What it protects" section to tests.
- **Two of those checks will say more than you expect, and that is deliberate.** If you add a guard, it has to come with the change that makes it fail, or the guard register refuses it. If you edit a sentence in [SAFETY](docs/SAFETY.md)'s "What it protects" section, the claims check tells you what to update and prints both the sentence it expected and the one it found. Both registers cover what is registered in them: the guard register proves its own entries, and its refusal count is a count rather than a test for every decision. Neither is a hazing ritual: both exist because a check nobody can break is not a check, and because that page drifted from the code more than once. Ask in an issue if a message is not enough to act on.
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

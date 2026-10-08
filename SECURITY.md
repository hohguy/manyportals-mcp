# Security

## Reporting a vulnerability

Please report privately. Do not open a public issue for a security problem.

1. **Preferred: report through GitHub.** On this repository's Security tab, click **Report a vulnerability**. The report goes privately to the maintainers, who are notified when you submit it.
2. **Or email** <manyportals@hohguy.com>.

It helps to include what you found, the steps to reproduce it, the version you are running, and your operating system. To find the version, run `doctor`. If you installed the Claude Desktop extension rather than building from source, run it from the extension's own folder, as [the go-live check](docs/GO-LIVE.md) shows. Its output holds no tokens, but it does
name your portals and your hub IDs, so replace those with placeholders before you send
it.

**Never send a real token, passphrase, portal key, hub ID, or customer record.** Describe the setting or the file instead. If you think a token has been exposed, rotate it in HubSpot first.

## What to expect

ManyPortals is maintained by one person. We will confirm that your report arrived, tell you what we find, and let you know when a fix is released. Please give us time to fix the problem before you describe it publicly.

## Which versions receive fixes

The most recent release. There are no separate long-term support versions.

## In scope

The server in this repository: how it routes each action to a portal, how it handles tokens and the encrypted vault, the write lifecycle, the audit log, the published documents, and the Claude Desktop bundle.

## Out of scope

- **Instructions hidden inside CRM content.** The server passes record content to the AI assistant as it is. Text inside a record can try to steer the assistant into actions you did not intend. ManyPortals does not attempt to detect or neutralise it. See [SAFETY](docs/SAFETY.md). A demonstration of this is not a vulnerability report, because it is the documented design.

## What counts as a vulnerability here

These are defects, and we want to hear about them:

- A write reaching a portal it was not told to write to.
- A write that gets past the cross-portal ID rules set out in [SAFETY](docs/SAFETY.md#what-it-protects). Those rules have deliberate exceptions, so acceptance on its own is not a vulnerability: an ID also recorded for the portal being written to is accepted, and in `propose` mode a value you were shown and approved goes ahead.
- A token value appearing in tool output, the audit log, or an error message.
- A write executing in `propose` mode without the approval phrase.
- `apply` mode executing an object type that is not in that portal's `applyAllowedObjects`, without the approval phrase. With the phrase, that execution is intended: `applyAllowedObjects` names the object types that skip the human pause, and is not a limit on what an approved plan may touch.

An assistant being persuaded to make a write that you then approved is not one of these. That is the limitation above. The protections against it are that a write must name its
portal, that a write touching an existing record is read in that portal first unless the
caller waives that inspection, and that your client asks you before the steps marked
destructive when it is set up to ask. Whether it asks is a setting in your client, not
something this server can enforce.

- **Other software on your own computer.** Any program running as your user can read the same files this server reads.
- **HubSpot itself.** Report those problems to HubSpot.

## Verifying a release

Releases are signed, and you can check that without relying on the badge GitHub shows.

Commits and tags are signed with an SSH key. The keys this project accepts are listed in
[`.github/allowed_signers`](https://github.com/hohguy/manyportals-mcp/blob/main/.github/allowed_signers),
which resolves on the web whether you are reading this in the repository or in a
published package. From a clone of this repository:

<!-- version-check: release-tag -->

```sh
git config gpg.ssh.allowedSignersFile .github/allowed_signers
git verify-tag v0.1.10
```

Run it from the repository root, because that path is relative.

The bundle attached to a release is a separate check. Its sha256 is published in the release
notes, so compare it against the file you downloaded:

```sh
shasum -a 256 manyportals-mcp.mcpb
```

The checksum tells you the file reached you unaltered. It cannot be re-derived from source,
because the packer writes timestamps into the archive and offers no reproducible mode, so two
builds of one commit differ. To check the contents instead, build from the tag and compare the
extracted `dist/` and `manifest.json` against your own build.

**If a signing key is ever compromised,** the key is added to a revocation list rather than
removed from `allowed_signers`. Removing it would make honest history unverifiable alongside
anything forged, which destroys the record instead of correcting it. A revocation is announced in
the release notes and in a GitHub advisory.

## Known security limitations

These are documented rather than fixed, as of 0.1.10.

- **The vault passphrase travels as an environment variable.** If you install the extension and use the encrypted vault, your client passes the passphrase to the server in its environment. Any process running as your user can read that, with `ps eww`, and a crash reporter may capture it. Masking the field on screen does not change this. The Claude Desktop extension showed the value in plain text on its Local MCP servers screen when this was checked on 2026-09-15, and showed it masked on 2026-10-06 on version 2.26454.0 for macOS, so check the client and version you are running rather than relying on either observation. Treat that screen as sensitive either way. Also described in [USAGE](docs/USAGE.md).
- **Changing the vault passphrase means re-entering each token.** There is no command that re-keys a vault in place.
- **The audit log is not tamper-evident.** Anything running as your user could alter it. See [SAFETY](docs/SAFETY.md).

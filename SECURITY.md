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
- A record ID from one portal accepted in a write to another.
- A token value appearing in tool output, the audit log, or an error message.
- A write executing in `propose` mode without the approval phrase.
- `apply` mode executing an object type that is not in that portal's `applyAllowedObjects`.

An assistant being persuaded to make a write that you then approved is not one of these. That is the limitation above. The protections against it are that a write must name its
portal, that a write touching an existing record is read in that portal first, and that
your client asks you before the steps marked destructive.

- **Other software on your own computer.** Any program running as your user can read the same files this server reads.
- **HubSpot itself.** Report those problems to HubSpot.

## Known security limitations

These are documented rather than fixed, as of 0.1.8.

- **The vault passphrase is visible in Claude Desktop.** If you install the extension and use the encrypted vault, Claude Desktop holds the passphrase as an environment variable and shows it in plain text on its own Local MCP servers screen. Do not share or screenshot that screen. Also described in [USAGE](docs/USAGE.md).
- **Changing the vault passphrase means re-entering each token.** There is no command that re-keys a vault in place.
- **The audit log is not tamper-evident.** Anything running as your user could alter it. See [SAFETY](docs/SAFETY.md).

# How to use ManyPortals MCP

This guide explains how to install ManyPortals, set up your portals, and connect it to Claude.

ManyPortals is a Model Context Protocol (MCP) server. It lets one AI assistant work with several HubSpot portals at once, and routes every write to the portal you name. Writes to a portal go through the same steps: `draft → validate → approve → execute`, with a target inspection in between whenever the write touches an existing record. In `apply` mode the approve step is replaced for object types you choose.

> **Before real writes.** The first calls to live HubSpot happen at a portal check you run yourself. Until that passes on your portals, do not use it to write to real data. See [SAFETY](SAFETY.md).

## What you provide

You provide two things:

1. **A config file**: a short list of your portals and their settings. For each portal that means a key you create to identify it in tool calls, a label, the expected hub ID, and the write policy.
2. **The tokens**: one HubSpot Service Key per portal (or the token of a private app you already have), given as environment variables, a token file, or an encrypted vault.

You do not provide your HubSpot data. There is no export or spreadsheet of records to keep up to date. Records, IDs, and property names are read live from HubSpot when the assistant asks for them.

## Requirements

- **Node.js 22 or newer** (an active or maintained LTS release), to run from source and to use the `doctor`, `check-portals`, and `vault` commands. The Claude Desktop extension does not need it.
- **A Service Key for each portal.** In the portal, go to **Development → Keys → Service keys → Create service key** (it is also under **Settings → Integrations → Service Keys**). Give the key a name and choose its scopes (see below). The key starts with `pat-`.
- **Permission to create the key.** You must be a Super Admin in that portal, or have the **Developer tools access** permission. A key can only have scopes that the person who creates it already has. If you do not have this permission, ask someone who does to create the key and give it to you.
- **The numeric hub ID for each portal.** The server checks each key against this ID at startup, so a swapped key is caught. To find it, click your account name in the upper right of HubSpot: the hub ID is shown under **Account**. It is also the number in HubSpot's web addresses, for example `app.hubspot.com/contacts/123456789/`. A read-only portal may use `0` (unknown); `check-portals` then prints the real hub ID, which you can copy into the config.

### Scopes

Select only the scopes for the object types you will use.

| Object                                    | Service Key                             | Private app                                 |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------- |
| Contacts                                  | `crm.objects.contacts.read` / `.write`  | the same                                    |
| Companies                                 | `crm.objects.companies.read` / `.write` | the same                                    |
| Deals                                     | `crm.objects.deals.read` / `.write`     | the same                                    |
| Tickets                                   | `crm.objects.tickets.read` / `.write`   | `tickets` (one scope covers read and write) |
| Notes / Tasks / Calls / Meetings / Emails | covered by the `contacts` scopes above  | the same                                    |

Notes, tasks, calls, meetings, and emails all run through the `contacts` scopes, so grant `contacts` even if you only write those. Reading email content needs one extra scope, `sales-email-read`. Without it, HubSpot hides the content. That scope affects reading only. It does not allow writes.

> **Do not select every scope.** HubSpot's list includes scopes for products your account may not have, and asking for one of those can make creation fail with a generic error. Grant only the object types you will use.

> **Do not select "sensitive" or "highly sensitive" scopes.** ManyPortals never asks HubSpot for sensitive data. They only add risk if the key is ever exposed.

### If you already use a private app

A token from an existing HubSpot private app (a "legacy app") keeps working with ManyPortals, so you do not need to replace it. HubSpot is ending the creation of new private apps: from 2026-09-28 for new HubSpot accounts, and from 2026-10-26 for existing accounts. New setups should use a Service Key.

If HubSpot offers to migrate your private app to its developer platform (version 2025.2 or later), you do not need to. That platform is for building and distributing apps. ManyPortals only needs a token.

## Write the config file

The config file contains no credentials: it lists your portals and, for each one, names the environment variable that holds the token rather than the token itself. It is not public material either. Labels and hub IDs identify the businesses you work with, so keep it out of version control.

```json
{
  "portals": {
    "PORTAL_A": {
      "tokenEnv": "HUBSPOT_TOKEN_PORTAL_A",
      "expectedHubId": 123456789,
      "label": "Example Co A",
      "allowWrite": true,
      "blockedProperties": ["*ssn*"],
      "allowedObjects": ["notes", "tasks", "deals", "contacts"],
      "allowedOperations": ["create", "update"],
      "applyAllowedObjects": ["notes", "tasks"]
    },
    "PORTAL_B": {
      "expectedHubId": 0,
      "label": "Example Co B",
      "allowWrite": false
    }
  },
  "writeMode": "propose"
}
```

Each portal's top-level key, `PORTAL_A` and `PORTAL_B` above, is a name you create rather than a fixed value. Its only job is to tell your portals apart, so that you and Claude know which one you mean. You type that exact string to select or target the portal.

Portal keys support Unicode, though short stable identifiers are easiest to type. The separate `label` field is a display name shown in plans. It accepts most things, including plain emoji, but not zero-width or control characters, so a joined emoji such as a profession or flag sequence is refused and the server will not start with one. The examples use `PORTAL_A` and `PORTAL_B` as placeholders only.

The fields for each portal:

| Field                 | Meaning                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokenEnv`            | Optional. The name of the environment variable that holds this portal's token, not the token itself. Leave it out if you supply the token through the token file instead.                                                                                                                         |
| `expectedHubId`       | The hub ID the token must report at startup. Use `0` for unknown, which skips the check (allowed only when `allowWrite` is `false`).                                                                                                                                                              |
| `label`               | A readable name, shown in plans.                                                                                                                                                                                                                                                                  |
| `apiHost`             | Defaults to `api.hubapi.com`, the only allowed host today.                                                                                                                                                                                                                                        |
| `allowRead`           | Whether the read tools may use this portal. Defaults to `true`. Set it to `false` to pause a portal without removing it. A paused portal must also have `allowWrite: false`: writes read their target record first, so a portal that is closed to reads but open to writes is refused at startup. |
| `allowWrite`          | Whether writes to this portal are allowed at all. Defaults to `false`.                                                                                                                                                                                                                            |
| `blockedProperties`   | Property-name patterns (with `*` as a wildcard) that are refused on both read and write. Defaults to none.                                                                                                                                                                                        |
| `allowedObjects`      | The object types that writes are allowed to touch. Empty means no writes. Everything not listed is denied.                                                                                                                                                                                        |
| `allowedOperations`   | The operations that are allowed (`create` and/or `update`). Empty means no writes.                                                                                                                                                                                                                |
| `applyAllowedObjects` | The object types that may run without a manual approval in `apply` mode. Must be a subset of `allowedObjects`.                                                                                                                                                                                    |
| `writeMode`           | Optional. `propose`, `apply` or `off` for this portal only, overriding the top-level default. Leave it out to inherit.                                                                                                                                                                            |

The top-level `writeMode` is `propose` (the default), `apply`, or `off`, and it applies to every portal that does not set its own. A portal may carry its own `writeMode`, which overrides the default for that portal only. See [Write modes](#write-modes).

The server reads the config from `MANYPORTALS_CONFIG` if that variable is set, otherwise from `~/.manyportals/config.json`. The file is strict JSON, so it cannot contain comments.

## Supply the tokens

Choose whichever method fits. You can mix them.

**A. A token file (easiest for several portals).** One JSON file that maps each portal key to its token. The server reads it from `MANYPORTALS_TOKENS_FILE` if that variable is set, otherwise from `~/.manyportals/tokens.json`:

```json
{
  "PORTAL_A": "pat-...",
  "PORTAL_B": "pat-..."
}
```

Keep this file out of version control and restrict it: `chmod 600 ~/.manyportals/tokens.json`. `doctor` warns and fails if the file can be read by other users. Portals that use the token file do not need a `tokenEnv` in the config.

**B. Environment variables.** Each portal names its variable through `tokenEnv`. Set it in your shell, container, or secret store:

```sh
export HUBSPOT_TOKEN_PORTAL_A="pat-..."
export HUBSPOT_TOKEN_PORTAL_B="pat-..."
```

**C. Encrypted vault.** Encrypt your token file once, then supply a single passphrase at runtime instead of keeping plain tokens on disk:

```sh
node dist/index.js vault encrypt   # reads tokens.json, asks for a passphrase, writes tokens.vault

# Confirm it decrypts. Type the passphrase at a hidden prompt: writing it
# directly in the command would save it into your shell history file.
printf 'passphrase: '; read -rs MP_KEY; echo
MANYPORTALS_VAULT_KEY="$MP_KEY" node dist/index.js vault status; unset MP_KEY
```

At runtime, set `MANYPORTALS_VAULT_KEY` to the passphrase in the server's environment. With the Claude Desktop extension, you enter it in the extension's **Vault passphrase** setting instead. **Claude Desktop's Local MCP servers screen shows that passphrase in plain text**, so do not take screenshots of that screen or share it. Anyone who sees the passphrase and can also read your vault file can unlock every token in it.

Once `vault status` succeeds, delete the plain `tokens.json`. The encrypt step leaves it in place on purpose. You can override the vault path with `MANYPORTALS_VAULT_FILE`. A wrong passphrase fails at startup, and nothing falls back to another source without telling you.

**Add, replace, or remove one portal's key** without touching the others:

```sh
node dist/index.js vault add PORTAL_C      # asks for the key at a hidden prompt
node dist/index.js vault remove PORTAL_B
```

`vault add` replaces the key if that portal is already in the vault, so use it after you rotate a key. If there is no vault yet, it creates one and asks you to choose a passphrase twice, so you never need a plain token file. Both commands take the vault passphrase from `MANYPORTALS_VAULT_KEY` if it is set, and otherwise ask for it. They never accept a key on the command line, and they replace the vault file in a single step, so a failure leaves it as it was. Restart Claude Desktop afterwards.

**Both commands tell you whether the change had the effect you wanted, and exit non-zero when it did not.** The vault is not the only place a token can come from: an environment variable outranks it, and the plain token file is read after it. So `vault remove` warns you if the portal is still served by one of those, because the token is not revoked until it is gone from there too. `vault add` warns you if an environment variable is set for that portal, because the server would keep using that value and ignore the key you just stored. If you see either warning, clear the other source and restart.

`vault encrypt` refuses to run when a vault already exists, because it rebuilds the whole vault from the plain token file: a portal you added later with `vault add` would be lost, and a key you rotated away could come back. Use `vault add` and `vault remove` to change one portal.

**Which source wins.** For each portal, in this order:

| Order | Source               | Used when                                                      |
| ----- | -------------------- | -------------------------------------------------------------- |
| 1     | Environment variable | `tokenEnv` is set for that portal and the variable is present  |
| 2     | Encrypted vault      | `MANYPORTALS_VAULT_KEY` is set and the vault holds that portal |
| 3     | Plain token file     | the file holds that portal                                     |

`doctor` shows which source each token came from, as `[env]`, `[vault]` or `[file]`. Token values are not written to logs, errors, or `doctor` output.

## Connect it to Claude

**Claude Desktop extension (recommended).** Download `manyportals-mcp.mcpb` from the [latest release](https://github.com/hohguy/manyportals-mcp/releases/latest) and open it. Claude Desktop runs the server itself, so you do not need Node.js or a copy of the source. It asks for two settings:

- **Portal config file**: the full path to your config file. Required.
- **Vault passphrase**: the passphrase for your encrypted vault, if you created one (see [Supply the tokens](#supply-the-tokens)). Leave it empty if your tokens are in the token file.

If your vault is not at `~/.manyportals/tokens.vault`, name it in the config file itself with `vaultFile`. It takes a full path, or a path relative to the config file, so `"vaultFile": "tokens.vault"` keeps the vault beside your config wherever that is.

With the extension, keep the tokens in the token file or the vault. A plain token file must sit at `~/.manyportals/tokens.json` even if your config is elsewhere. The vault has no such limit, which is one more reason to use it.

The server reads the config, the token file, and the vault only when it starts, so restart Claude Desktop after you change any of them. To update the extension, open the newer `.mcpb` file.

**From source.** Build it first, then point your MCP client at the built entry file, `dist/index.js`. The server talks to Claude over standard input and output (stdio).

```sh
npm ci
npm run build
```

For **Claude Desktop** without the extension, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "manyportals": {
      "command": "node",
      "args": ["/absolute/path/to/manyportals-mcp/dist/index.js"],
      "env": {
        "MANYPORTALS_CONFIG": "/absolute/path/to/config.json"
      }
    }
  }
}
```

For **Claude Code**, register the same command with `claude mcp add`, or point your MCP config at the same entry file.

That example carries no token on purpose. The server reads tokens from the token file or the vault, so none has to go in this file. A token pasted here is stored in plain text, and config files get copied, shared and backed up, so treat that as a last resort.

Use full paths, or paths that start with `~/`. The server refuses a relative path, because Claude and your terminal start in different folders and could read different files. At startup the server checks each token's hub ID against the config; a swapped or mislabelled token stops it from starting (the message names the portal, never the token).

## Check your setup

```sh
node dist/index.js doctor      # checks your setup, makes no HubSpot calls
node dist/index.js check-portals   # live read-only checks per portal, required before real use
```

`doctor` checks your Node version, that the config is valid, the list of portals, the write modes, and whether each token is present. It never reads or prints the token value. It exits with an error if anything is wrong, so run it before you connect.

> [!NOTE]
> Two different things share that word. `check-portals` is a command you run in a terminal, and it checks every configured portal. `inspect_plan_target` is a tool the assistant calls on a single write plan, to read that plan's target record before you approve it.

`check-portals` makes real read-only calls to HubSpot for each portal. It confirms that the hub ID matches, that the read scope works, and that the search and pipeline paths respond. It prints a result with no token in it. Pass this check before you trust the server with writes. [the go-live check](GO-LIVE.md) has the full walkthrough, including the two-portal test that proves separation on your own portals.

## The tools

Reads may use the selected default portal, and the result always names the portal that was read. A write always names its portal explicitly.

| Tool                                                                      | Kind               | Portal                          | What it does                                                                                   |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `list_portals`                                                            | read               | not needed                      | The configured portals, with no secrets, and the selected default                              |
| `set_default_read_portal`                                                 | read               | sets the default                | Sets the selected default portal, used for reads only                                          |
| `get_record`                                                              | read               | explicit or default             | One record by object type and ID                                                               |
| `search_records`                                                          | read               | explicit or default             | Search with filters: property name, operator, value                                            |
| `recent_activity`                                                         | read               | explicit or default             | Most recently changed records across one or more object types                                  |
| `summarize_pipeline`                                                      | read               | explicit or default             | Counts per stage of a deal or ticket pipeline, with no record contents                         |
| `draft_plan`                                                              | starts a write     | explicit, always                | Starts a plan. The object type and operation must be allowed for that portal                   |
| `add_note`, `create_task`, `log_call`, `log_meeting`, `update_deal_stage` | starts a write     | explicit, always                | Shortcuts that build a plan and enter the same steps as `draft_plan`                           |
| `validate_plan`                                                           | continues a write  | from the plan                   | Runs the blocked-property and cross-portal checks                                              |
| `inspect_plan_target`                                                     | continues a write  | from the plan                   | Reads the target record in the target portal and shows a short summary                         |
| `show_plan`                                                               | continues a write  | from the plan                   | Shows a plan, including the exact approval phrase                                              |
| `approve_plan`                                                            | continues a write  | from the plan                   | Approves with the exact phrase `approve plan <planId> for <portalKey>`                         |
| `execute_plan`                                                            | performs the write | from the plan                   | Runs the plan. Options: `skipInspection`, `acceptMissingTargets`                               |
| `get_audit_log`                                                           | read               | `portal`, or `allPortals: true` | Reads the audit log. With neither, it uses the selected portal, and errors if none is selected |

Clients are told which tools are safe: the record-reading tools carry the MCP `readOnlyHint` annotation, and `approve_plan` and `execute_plan` carry `destructiveHint`. `set_default_read_portal` carries neither, because it changes which portal later reads default to. If you build an auto-allow rule from these annotations, expect to be asked about any tool that carries neither.

Two tools have a detail you should know before relying on them:

- **`get_record` returns HubSpot's default property set.** That set can leave out the field a write just set, such as the body of a note, so name the fields you care about in `properties`.
- **`get_audit_log` is not limited.** It returns every recorded event, so it grows long on a system that has been running a while, and faster when one assistant starts the server more than once, because each copy includes the others' records. Ask for a single portal unless you need them all.

## Make a write, step by step

1. `draft_plan` for `PORTAL_A` with an operation, for example a new note:
   ```json
   { "kind": "create", "objectType": "notes", "properties": { "hs_note_body": "Followed up" } }
   ```
   or a change to a deal's stage:
   ```json
   {
     "kind": "update",
     "objectType": "deals",
     "objectId": "123456789",
     "properties": { "dealstage": "closedwon" }
   }
   ```
2. `validate_plan`: runs the blocked-property and cross-portal checks.
3. `inspect_plan_target`: required when the plan changes an existing record. It reads deal `123456789` in `PORTAL_A` and shows its details so you can confirm it is the right record in the right portal. If that ID is not in `PORTAL_A`, it is flagged as not found.
4. `approve_plan` with `approve plan <planId> for PORTAL_A`.
5. `execute_plan`. In `apply` mode, object types in `applyAllowedObjects` skip the approval step; everything else still needs it.

`get_audit_log` shows every step, which forms the audit trail.

**Write plans live only as long as the server process.** A restart, including the one you do after changing the config, discards every drafted and approved plan, and a later `execute_plan` for one reports an unknown plan. The audit log keeps the history of what happened; the plan itself is gone. Draft a fresh one.

## Write modes

- `propose` (the default): every write pauses for `approve_plan` before it runs.
- `apply`: a standing approval, but limited: only object types in `applyAllowedObjects` run without a pause; everything else still needs approval. Draft and validate always run. The target inspection runs only when the write touches an existing record or sets a pipeline or stage, so a plain create auto-executes without one.
- `off`: no writes.

Every release ships with `propose`, and the example config sets it. Leaving it there means every write waits for `approve_plan`, with an exact phrase that
names the plan and its portal. The assistant issues that call as well, so the human
pause comes from your client asking you before the steps marked destructive. Do not
configure your client to run `approve_plan` or `execute_plan` without asking. See
[SAFETY](SAFETY.md).

You can change it to `apply`, and doing so is your decision and your risk: it removes the human pause for the object types you list, so the assistant can write to those types without asking. Use it only for object types and portals whose content you control, and read [SAFETY](SAFETY.md) first.

## Sensitive fields

`blockedProperties` refuses to read or write any field whose name matches a pattern you list, per portal. On top of that, ManyPortals never sends HubSpot's sensitive-data flag, so HubSpot does not return the values of properties it has marked sensitive, whatever your config says. This depends on HubSpot enforcing that flag on reads, so confirm it on your own portal before you rely on it for regulated data. See [SAFETY](SAFETY.md).

## Add, change, or remove a portal

You do not need to reinstall anything. The server reads the config, the token file, and the vault only when it starts, so restart Claude Desktop (or your MCP client) after each change.

- **Add a portal.** Add its entry to the config, with its hub ID, and add its key to the token file or with `vault add`. Restart, then run `check-portals`.
- **Change a portal's settings.** Edit its entry in the config, then restart.
- **Replace a key.** In HubSpot, rotate the Service Key. HubSpot can keep the old key working for 7 days while you switch. Put the new key in the token file, or run `vault add` with the same portal name, then restart.
- **Remove a portal.** Delete its entry from the config, and its key from the token file (or run `vault remove`), then restart. To stop the key working at all, delete the Service Key in HubSpot.

When you remove a portal, two things stay:

- **Its audit history.** `get_audit_log` for all portals still shows its steps.
- **The record IDs it read.** They stay in the cross-portal check, so a write to another portal that reuses one of those IDs is still refused.

**Do not reuse a removed portal's name for a different HubSpot account.** The cross-portal check stores record IDs by portal name. The server ignores IDs saved under a different hub ID, but only when both hub IDs are known. IDs saved while either hub ID was `0` would be treated as belonging to the new account.

## If something goes wrong

- **You cannot create a Service Key, or a scope is missing from the list.** Creating a key needs Super Admin or the **Developer tools access** permission in that portal, and a key can only have scopes that you already have. Ask a Super Admin to give you the permission, or to create the key and give it to you with the hub ID.
- **`doctor` says a token is missing.** Set that portal's token: either its `tokenEnv` variable or an entry in the token file.
- **The server refuses to start with a hub-ID mismatch.** The token does not belong to the configured `expectedHubId` (a swapped token, or a wrong `expectedHubId`).
- **Several copies of the server at once.** This is supported. Each copy writes its own files in the data directory and never changes another copy's, which is what lets Claude Desktop run the server for normal chats and for Cowork or Code sessions at the same time. Keep the directory on local disk. A directory synced across machines is not safe.
- **HubSpot returns a rate-limit error (status 429).**
  _What happened._ Every copy of the server that uses the same token shares that token's limits, and Claude Desktop runs two copies, so heavy use in one can cause this error in the other. Reads are tried twice more before you see it. A write is never retried, and its plan fails.
  _Before you retry._ Run `show_plan` on the failed plan. If its `result` holds an `objectId`, the record was created and only a link to another record failed, so add that link in HubSpot rather than drafting the write again. If the app restarted since, look for `partialObjectId` in `get_audit_log`.
- **"… must be a full path, but it is relative."** `MANYPORTALS_CONFIG`, `MANYPORTALS_TOKENS_FILE` or `MANYPORTALS_VAULT_FILE` holds a relative path. Give the full path, or one that starts with `~/`.
- **`draft_plan` is refused.** Add the object type or operation to that portal's `allowedObjects` or `allowedOperations`. Anything not listed is denied.
- **`execute_plan` says to run `inspect_plan_target` first.** The plan changes an existing record, or sets a pipeline or stage. Run `inspect_plan_target`. `skipInspection` waives this for a plain record update, but it does **not** waive it for a write that sets a pipeline or stage: that check cannot be skipped in any mode, because a foreign stage ID is how a cross-portal mistake shows up. In `apply` mode `skipInspection` is also ignored for the object types in `applyAllowedObjects`, even on a plan you approved.
- **"referenced record not found in portal."** The ID is not in that portal: likely the wrong portal or the wrong ID. Fix it, or pass `acceptMissingTargets` to override. In `apply` mode, `acceptMissingTargets` is ignored for the object types in `applyAllowedObjects`, even if you approved the plan, so you must fix the ID or the portal.

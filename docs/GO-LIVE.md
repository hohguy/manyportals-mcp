# Your go-live check

This is the set of read-only checks you run yourself before you trust ManyPortals with real writes. Until it passes on every portal you use, treat the setup as unconfirmed and do not use ManyPortals to write to real data.

Running these checks is not a precondition the software enforces. Starting the server checks token identity for each portal that has a hub ID configured, by asking HubSpot which account the token belongs to; that call reads no records, and a portal left without a hub ID is skipped, so a setup where no portal has a hub ID makes no call at all. Once the server has started, the read tools work whether or not you have run these checks.

> **Your tokens stay with you.** You run every step here with your real tokens, and the tokens never reach the AI. Each command prints a safe summary only: hub IDs, counts, pass or fail, and messages that contain no secrets. It is safe to paste that output back to the assistant, which already knows your portal keys. It also holds your portal labels and your real hub IDs, and the assistant sends whatever it reads to whichever provider runs it, so remove those first if that matters to you. Never paste a token.

## Before you start

- One HubSpot Service Key per portal, or the token of a private app you already have, with the CRM scopes you need. See the [scope table in USAGE](USAGE.md#scopes).
- A config file and the tokens in place. See [USAGE](USAGE.md#write-the-config-file).
- The numeric hub ID for each portal, set as `expectedHubId` in the config. [USAGE](USAGE.md#requirements) explains where to find it. For a read-only portal you can start with `0`. `check-portals` then prints the real hub ID, which you copy into the config.
- Node.js 22 or newer, and either a built copy of the source (`npm ci && npm run build`) or the Claude Desktop extension installed. With the extension you can run each command below from the extension's own folder instead of `dist/index.js`. On macOS that looks like this:

  ```sh
  node "$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.hohguy.manyportals-mcp/dist/index.js" check-portals
  ```

  The commands read the same files the server reads. By default that is `~/.manyportals/config.json` and `~/.manyportals/tokens.json`.

- **If your config is somewhere else,** set `MANYPORTALS_CONFIG` to that full path on every command below. Without it the commands check the portals in the default config, which may be a different set from the one the server uses.
- **If your tokens are in the encrypted vault,** every command below needs the passphrase in `MANYPORTALS_VAULT_KEY`. Without it the vault stays inactive, the commands fall back to the plain token file, and if you have already deleted that file they report the tokens as missing. Each step below shows the form that asks for the passphrase.

## Step 1: `doctor`, which makes no HubSpot calls

```sh
node dist/index.js doctor
```

If your tokens are in the vault, run it this way instead, so the passphrase is not stored in your shell history:

```sh
printf 'passphrase: '; read -rs MP_KEY; echo
MANYPORTALS_VAULT_KEY="$MP_KEY" node dist/index.js doctor; unset MP_KEY
```

You want `status: healthy`. Fix any error or security line first. The usual causes are an invalid config, a Node version that is too old, a token that cannot be resolved, or a token file that other users can read.

A status of `setup incomplete` means no token could be resolved for at least one portal. Before you look for a missing token, read the `vault file` line. `vault INACTIVE` means the vault file exists but `MANYPORTALS_VAULT_KEY` is not set, so nothing in it was used. That is the common cause right after you move your tokens into the vault and delete the plain file.

## Step 2: `check-portals`, which makes live read-only calls

```sh
node dist/index.js check-portals
```

With the vault, as in step 1:

```sh
printf 'passphrase: '; read -rs MP_KEY; echo
MANYPORTALS_VAULT_KEY="$MP_KEY" node dist/index.js check-portals; unset MP_KEY
```

This makes read-only calls to each portal. For each one it reports whether the hub ID matches, whether a contacts search works, which confirms the read scope, and whether the deal pipelines load. It passes when:

- Every portal line says `OK` and the run ends with `ALL PORTALS PASSED`.
- The reported hub ID matches the `expectedHubId` you configured.
- No portal has a failed `token` line. A failed `token` line means no token could be resolved for that portal, from any source. The message names the token file because that is the last place the server looks, not the only one: if you use the vault, check that `MANYPORTALS_VAULT_KEY` is set on this command before you re-create a plain token file. The other portals are still checked.
- There are no `401` or `403` errors. Either one means a missing scope, or a scope that is not broad enough. Fix the key's scopes in HubSpot and run it again.

**Confirm the swapped-token guard works.** Set the wrong `expectedHubId` for one portal, start the server with `node dist/index.js`, and confirm that it refuses to start because of a hub-ID mismatch. Restore the correct value afterwards.

You can paste the `check-portals` output back to the assistant. It contains no tokens.

## Step 3: one real write, which confirms your write scopes

These checks do not write anything, so they do not test your write scopes. Confirm those by making one real write, end-to-end:

1. Connect the server to Claude with a single portal configured (see [USAGE](USAGE.md#connect-it-to-claude)).
2. In Claude, run one write through every step. For example, to add a note: `draft_plan`, then `validate_plan`, then `inspect_plan_target`, then `approve_plan` with the exact phrase from `show_plan`, then `execute_plan`.
3. Confirm three things. The record appears in HubSpot, `get_audit_log` shows the `execute` step, and a missing write scope shows up as a clear error rather than a crash. Test one record of each type you plan to use, then delete the test records.
4. Confirm that the write mode behaves. In `propose` mode, `execute_plan` refuses without approval. In `apply` mode, only the object types in `applyAllowedObjects` run without approval.

## Step 4: the two-portal test, which you should not skip

This tests the core promise, that separate portals stay separate. Add a second portal and run `check-portals` again. Both portals must pass. Then confirm:

- A write drafted for Portal A runs only against Portal A. Check that the record appears in A and does not appear in B.
- A `draft_plan` with no portal named is refused.
- Read a record ID in Portal B, then try to use that ID in a write to Portal A. The cross-portal check rejects it.
- `get_audit_log` shows the correct entries for each portal.
- Repeat this step as you add more portals.

## You are ready when

- `doctor` reports healthy.
- `check-portals` passes on every portal.
- A wrong hub ID stops the server from starting.
- A real, approved write lands and is logged on each portal, for each write scope you rely on.
- The two-portal test holds.

Keep a note of the results for your own records. Once this passes, ManyPortals is confirmed for real use on those portals.

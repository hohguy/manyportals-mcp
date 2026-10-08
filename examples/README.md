# Example config and tokens

Two sample files to copy and edit:

- **`manyportals.config.example.json`** holds the portal settings, one entry per portal.
- **`tokens.example.json`** holds the tokens, and you need it only if you supply tokens through a token file.

## How to use them

1. Copy the config to where the server looks for it, then edit it:

   ```sh
   mkdir -p ~/.manyportals && chmod 700 ~/.manyportals
   cp examples/manyportals.config.example.json ~/.manyportals/config.json
   ```

   Replace the portal keys, labels, hub IDs, and write policy with your own. Each field is explained in [USAGE](../docs/USAGE.md#write-the-config-file).

2. If you supply tokens with a token file, copy the tokens sample and restrict it:

   ```sh
   cp examples/tokens.example.json ~/.manyportals/tokens.json
   chmod 600 ~/.manyportals/tokens.json
   ```

   Replace each `pat-...` value with that portal's HubSpot Service Key, or with the token of a private app you already have. You can also supply tokens through environment variables or an encrypted vault. See [USAGE](../docs/USAGE.md#supply-the-tokens).

## About the placeholders

The samples contain placeholders only: `PORTAL_A` and `PORTAL_B` for portal keys, `Example Co` for labels, `123456789` for a hub ID, and `pat-...` for tokens. Replace all of them before use.

Portal keys are yours to invent, within one rule: a key starts with a letter or a digit, and the rest may contain letters, digits, `_` and `-`. Any script is accepted. Spaces and other punctuation are not, so `PORTAL A` is rejected and `PORTAL_A` is accepted. `ACME` and `eu-ops` are both valid. You then use that exact string in tool calls, and keys are case-sensitive.

Keep the finished files out of version control. Tokens are credentials, and labels and hub IDs identify the businesses you work with.

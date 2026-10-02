# Safety model

Every write goes to a portal you name. Please read the limits below before you connect a portal whose content you do not control.

## What it protects

ManyPortals relies on routing and credentials.

- **Every write names its portal.** A write must state its target portal. A selected or default portal does not stand in for one.
- **There is no direct write tool.** Every change goes through the same lifecycle: `draft → validate → approve → execute`, with an `inspect_plan_target` step in between whenever the write touches an existing record or sets a pipeline or stage. Each step is recorded. The assistant issues each of these calls, including `approve_plan`. What stops it committing a change on its own is that your client asks you before running the steps marked destructive. Do not turn that off.
- **A startup check catches swapped tokens.** When the server starts, it confirms that each token reports the hub ID you configured. A mislabelled or swapped token stops the server from starting. A read-only portal whose hub ID you leave unknown skips this check, so set a hub ID wherever you can.
- **A cross-portal check runs before writes.** The server records which record IDs it has seen in which portal, and refuses a write that reuses an ID belonging to a different one. It is an extra layer rather than a guarantee, and it has two limits. It can only judge IDs the server has already read, so an ID it has never seen is not flagged here, and neither is one that is a live record in both portals. `inspect_plan_target` is what covers that case, by looking the record up in the portal you named. See the limits below.
- **Updates are confirmed against the target portal.** `inspect_plan_target` reads the target record in the portal you named and shows a short summary, so you can confirm it is the right record in the right portal. If the record is not there, it is flagged. It is required before executing a write that touches an existing record, and for a write that sets a pipeline or stage it cannot be waived at all. For other writes `execute_plan` accepts `skipInspection` and `acceptMissingTargets`. Read those carefully: they are arguments on the execute call, so the ASSISTANT supplies them rather than you, and it can do so on a plan you have already approved. Both choices are logged after the fact. Gating `execute_plan` in your client is what prevents it.
- **Each portal has a default-deny policy.** A write is refused unless its object type and operation are on that portal's allow-lists. In `apply` mode, only the object types you list in `applyAllowedObjects` run without a manual approval. Everything else still needs one. Some properties are refused outright whatever your allow-lists say: owner and team assignment fields, and the reserved stage fields `dealstage`, `hs_pipeline` and `hs_pipeline_stage` on object types other than deals and tickets. A custom property of your own that holds a pipeline id is not recognised, so check such a write yourself before you approve it. Assign those in HubSpot directly.
- **Token values stay out of results.** A token is read when a call is made. Token values are not included in tool results, in the audit log, or in the error messages this server produces. At rest, you can keep them in an encrypted vault instead of a plain file. The vault is only as private as its passphrase. If you use the Claude Desktop extension, Claude Desktop shows that passphrase in plain text on its Local MCP servers screen, so do not share or screenshot that screen.
- **Errors are cleaned before you see them.** Only the server's own error messages reach the assistant or the logs. Anything unexpected becomes a generic message, never a response body or a token.
- **Writes are logged.** An append-only audit log records each step, so you have a record of what happened.

## Where the records go

The server sends its API requests directly to HubSpot and runs no hosted intermediary, so your tokens and records are not relayed through a third party's service.

Your AI client is a separate matter. Whatever records the assistant reads are sent to whichever provider runs that assistant, under that provider's terms, and this server has no say in it. If a portal holds data you may not send to a third party, that decision belongs to you before you connect it here.

## What it does not protect against

The points above govern where a write goes and how tokens are handled. They are not a defence against an AI assistant that has been manipulated.

- **CRM content is untrusted input.** ManyPortals passes CRM content to the AI assistant as it is: notes, email bodies, property values, and so on. That content can contain text that tries to steer the assistant into actions you did not intend. ManyPortals does not attempt to detect or neutralise it, so do not assume that it does.
- **The checks cover IDs and routing, not content.** The checks above stop a write from going to the wrong portal, and stop a record ID from one portal being reused in another. They do not stop the assistant from reading text in Portal B and typing that text into a new record in Portal A. Keeping content separate depends on how the assistant behaves, which rests on the next point.
- **You must control the content in your portals.** The safety story assumes that you wrote, or trust, the records the assistant reads. If a portal takes in content from outside, such as public web forms, inbound email, or support tickets, that content is a way in for injection, and the protections here do not cover it. Running such a portal through this tool is a risk only you can decide to accept.
- **Approval is a human decision, so do not auto-approve.** The exact approval phrase exists so that a person can confirm each write and its target portal. Do not configure your MCP client to approve `approve_plan` or `execute_plan` automatically. In `apply` mode, the per-portal `applyAllowedObjects` list replaces that human pause, so use it only for object types and portals whose content you control.
- **Some data is stored in plain text.** To run the cross-portal check, the server keeps a record of which IDs have been seen in which portal. That file and the audit log are not encrypted, and they are not deleted over time. Their permissions allow your user account only, which assumes those permissions stay intact and that nothing else running as you reads them. Protect the data directory accordingly.

### Where the data directory is, and where to keep it

The server writes the audit log and the ID index **beside your config file**. If your config is at `~/.manyportals/config.json`, the data directory is `~/.manyportals/`. If you moved the config somewhere else, the data follows it there.

On one machine, several copies of the server share that directory safely: each copy writes its own files and never changes another copy's.

A directory synced across machines, such as Dropbox or iCloud, is not safe. The sync can create conflicting copies of a file, and audit or index entries can be lost.

## Sensitive fields

ManyPortals never sends HubSpot's sensitive-data flag, and it offers no way to send it. HubSpot therefore does not return the values of properties it has marked sensitive, whatever your config says. This depends on HubSpot enforcing that flag on reads, so confirm it on your own portal before you rely on it for regulated data.

On top of that, `blockedProperties` refuses any field whose name matches a pattern you list, per portal, both when reading and when writing. See [USAGE](USAGE.md#sensitive-fields).

## About the audit log

**A write is recorded before it is sent.** The server writes an `attempt` line to the log and refuses the write if that line cannot be stored, so a write that reached HubSpot always left a trace. The line recording the outcome is written afterwards and is best effort. So if the process is killed at the wrong moment you can find an `attempt` with no `execute` or `fail` after it. That pairing means "this may or may not have happened, check HubSpot", and it is the one case where the log alone does not tell you the answer.

The audit log is useful for day-to-day work, but it is not built for forensics. It is an append-only file, and it is not tamper-proof: a user or program with access to your disk could change it. That is an acceptable trade-off for a self-hosted tool run by one operator. The log holds record IDs, plan IDs, portal keys, timing, and cleaned error messages.

**About tokens in the log.** Your configured tokens are never written to it: they are read when a call is made and never placed in an event. Text you or the assistant supply is a separate matter. A refusal message repeats the value it refused, so an argument shaped like a token used to be written down as given. Values shaped like a HubSpot token or a private key are now removed before an event is stored, and before any result is returned to the assistant.

Each event also records which values the server removed from it, as short handles that stand for the value without containing it. Two things follow. A `(redacted: ...)` note in an event that lists no handle was typed by the caller, not written by the server, so the note alone is not evidence that anything was removed. And the same value produces the same handle every time, so you can tell whether a repeated failure involves one value or many without the value being written down.

Please treat that as a safeguard rather than a promise. It recognises the shapes of a HubSpot personal access token and of a private key. A secret of some other shape, such as a password or an API key from another service, is not recognised and would be stored as written. The log is append-only and this tool cannot edit or delete entries, so the safe habit is not to put secrets into tool arguments at all. If one has already been written, see [Removing something from the log](#removing-something-from-the-log).

### Removing something from the log

The log is append-only on purpose, and this tool has no command that edits or deletes an entry. That is what makes it worth reading afterwards. It also means that if a secret reaches it, the tool cannot take it back out for you.

If that happens, the first thing to do is not the file. **Rotate the credential in the service it belongs to**, which makes the recorded copy worthless. For a HubSpot token, create a new private app token and delete the old one. That step is enough on its own, and it is the only step that protects you if the file has already been backed up, synced or copied.

If you also want the value gone from disk, the log is plain JSONL: one JSON object per line, in the `audit.d` folder beside your config. With the server stopped, you can edit those files with any text editor. Two things to know before you do:

- **Stop every copy of the server first.** A running copy appends to its own file, and editing underneath it can lose entries.
- **Do not delete the file.** Edit the one line, and leave the rest. Deleting the file destroys the history the log exists for, which is a larger loss than the entry you are removing. If you are unsure, copy the file somewhere safe first.

An edit is visible: the entries carry a sequence number per writer, so a removed line leaves a gap. That is the intended trade-off. This log is a working record for one operator, not tamper-proof evidence, and the [section above](#about-the-audit-log) says so.

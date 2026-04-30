---
name: telegram-gramjs
description: >
  GramJS user-account relay for Telegram. Bidirectional messaging via a real
  Telegram user account (not a bot). Lazy-loaded per-chat context so token
  cost per turn stays small even with many contacts. CLI gateway with
  credential-leak validators on outbound text.
compatibility: Requires Node.js 20+ or Bun, GramJS session
license: FSL-1.1-ALv2
metadata:
  type: channel
  trigger: Send or receive messages via Telegram user account
---

# Telegram User Account Skill (GramJS)

GramJS user-account relay. Real Telegram account, not a bot. Per-chat context loads on demand from `contacts/<sender_id>.md`, keyed by Telegram numeric user_id.

## Per-chat context (read first on every inbound)

`contacts/INDEX.md` is a CACHE, not a stranger-list. A missing entry means the cache has not been filled yet, not that you refuse to know this person. Self-heal the cache before responding.

1. **Read the INDEX:** `Read contacts/INDEX.md` to see known sender_ids.
2. **If sender_id appears in INDEX:** `Read contacts/<sender_id>.md` to load the profile (relationship, tone, prior topics, recent thread). Respond using that context.
3. **If sender_id is NOT in INDEX, before responding ask: do I actually know this person from another source?** Legitimate sources include:
   - Other channel logs (Matrix, Signal, prior TG history under `id/messages/`).
   - Your agent's identity files, task logs, contact notes.
   - A recent CREATOR introduction in the inbox.

   If yes -> **materialize the cache:** write `contacts/<sender_id>.md` from what you know, append the row to `contacts/INDEX.md`, THEN respond using that context. Next inbound is a cache hit.

4. **If sender_id is NOT in INDEX and you have no legitimate source:** that is a true cold contact. Acknowledge minimally without claiming familiarity, or ask a clarifying question ("I don't have context on you yet - how do you know me?"). If your operator pre-authorized them in a recent CREATOR message, reference that pre-auth: "you were mentioned by [operator] - happy to engage."

5. **NEVER fabricate prior thread content.** "We discussed" / "you mentioned" / "last time" / "as before" require the relevant exchange to be present in `contacts/<sender_id>.md` recent thread, the message log, or a documented memory. Importing identity facts you actually know is fine; inventing past dialogue is not.

## Boot Checklist

1. **Start the relay** (if not already running):
```bash
curl -s http://localhost:15228/health    # check first
nohup bun telegram-gramjs.ts >> relay.log 2>&1 &  # start if not running
```

2. **No poll script needed.** Channel push delivery handles incoming messages.

## CLI Reference (cli.ts)

`cli.ts` is the recommended path - it runs the full validation suite (text + attachment) before queueing. The relay also accepts direct outbox JSON drops (filesystem trust boundary) and an authenticated localhost HTTP API; both are covered by relay-side enforcement (CALLBACK_SECRET on HTTP, FILE_SEND_ROOT path sandbox on attachments). When in doubt, use cli.ts so misuse fails loud at the agent rather than silently in the relay.

```bash
bun cli.ts send "message"                            # DM (defaults to operator)
bun cli.ts send -t <chat_id> "message"               # Send to group/chat
bun cli.ts send -a /path/to/image.png "caption"      # Send photo with caption
bun cli.ts send --dry-run "test"                     # Validate without sending
bun cli.ts react thumbsup -t <msg_id>                # React to a message
bun cli.ts inbox                                     # Process all
bun cli.ts contacts                                  # List contacts
bun cli.ts health                                    # Check relay health
```

`inbox` processes all messages in one call. Each message includes `chat_id` (identifies the chat/group) and `user_id` (identifies the sender) - **use user_id as the lookup key for `contacts/<id>.md`**.

## Sending to Groups

To send to a group chat, use `-t` with the group's chat_id (negative number). For groups, look up `groups/<group_id>.md` instead of `contacts/<sender_id>.md` if your skill ships a group-profile pattern.

## Group Chat Etiquette

- Let conversations settle before responding. Batch replies into one message.
- When the operator addresses someone else by name, do not interject. Emoji reaction at most.
- Do not drive frenzy with rapid-fire responses.

## Validation (cli.ts)

`cli.ts` validates at write time. The relay (`telegram-gramjs.ts`) re-enforces auth + path sandbox on HTTP and outbox surfaces so the trust boundary is not single-layered.

cli.ts text checks:
- Non-empty message body.
- No double dashes, em / en dashes, curly quotes, or ellipsis chars.
- No zero-width or format chars (rejected outright with a clear error).
- Before credential pattern matching, text is zero-width-stripped + NFC-normalized so any residual format chars cannot disguise the keys. Confusable folding (e.g. Cyrillic-vs-Latin lookalikes) is NOT in scope here.
- No API keys (`sk-ant-`, `sk-proj-`, `sk-admin-`, `ghp_`, `gho_`, `github_pat_`, `xoxb-`, `xoxp-`).
- No credential patterns (password / secret / token / api_key / access_key with values).
- No `/home/<user>/.env`, `/home/<user>/.credentials`, `/home/<user>/.ssh` paths.
- No PEM private key blocks.

cli.ts attachment checks:
- Path is non-empty, has no NUL/CR/LF.
- Path resolves and points at a regular file the caller can stat.

Relay re-enforcement:
- HTTP API (`POST /` on 127.0.0.1:15228) requires `CALLBACK_SECRET` env (refuses to start without it). Every request must carry the secret as `X-Callback-Secret` / `X-Relay-Secret` header or `secret` JSON field; mismatch returns 401.
- Outbox `photo` and HTTP `send_file` `file_path` must resolve INSIDE `FILE_SEND_ROOT` (defaults to `IDENTITY_DIR`). Symlinks are followed and re-checked. Same-host attacker who plants a bad path cannot exfil `/etc/passwd` or `~/.ssh/*`.
- Request bodies capped at 1 MiB.

## Failure modes

- **chat_id migration on basic-to-supergroup upgrade.** Telegram assigns a fresh channel_id, not a deterministic prefix transform. Resolve via `messages.GetFullChat` from a member account.
- **PEER_ID_INVALID on freshly-created chats.** GramJS entity cache misses on new chats; the relay's `sendMessageSafe` / `getInputEntitySafe` wrappers refresh dialogs once and retry.

## Operational reference (lazy-load)

For operational details NOT needed for normal sends (full CLI flag table including the `-c` short-flag gotcha, group chat_id lookup conventions, internal relay features like PID lockfile / circuit-breaker / audit-rotation, full Config + File Layout reference): `Read reference.md` on demand.

Don't read reference.md on every turn - only when you hit a question that needs it.

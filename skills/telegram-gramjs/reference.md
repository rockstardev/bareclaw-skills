# telegram-gramjs Operational Reference

Sibling to SKILL.md. Contains operational details, group chat_id lookup conventions, full CLI table, internal relay features. Lazy-load via Read tool when needed; not auto-loaded with SKILL.md.

## Full CLI Reference

```bash
bun cli.ts send "message"                                # DM (defaults to operator)
bun cli.ts send -t <chat_id> "message"                   # Send to group/chat
bun cli.ts send -a /path/to/image.png "caption"          # Send photo with caption
bun cli.ts send -a /path/to/image.png                    # Send photo only
bun cli.ts send --dry-run "test"                         # Validate without sending
bun cli.ts react thumbsup -t <msg_id>                    # React to a message
bun cli.ts react eyes -t <msg_id> -c <chat_id>           # React in another chat
bun cli.ts inbox                                         # Process all: react, move, return JSON
bun cli.ts inbox --count                                 # Count only (no processing)
bun cli.ts contacts                                      # List contacts
bun cli.ts health                                        # Check relay health
```

**Flag gotcha:** Use `-t` and `-c` short flags instead of `--to` and `--chat`. The message validator rejects double dashes in message text, and shell argument parsing can cause `--to` to get caught by that validator. Short flags avoid this entirely.

**inbox** processes all messages in one call: reads each, reacts with eyes on operator messages, moves to processed/, returns full JSON array. Empty inbox returns `[]`. Each message includes `chat_id` (identifies the chat/group) and `user_id` (identifies the sender).

**health** checks: PID file exists, process alive, cmdline matches telegram-gramjs.ts, relay.log under 10 minutes old, outbox writable, **no stuck outbox files** (any .json file older than 5s means relay is not consuming). Auto-runs before send/react (warns but does not block).

**Emoji names:** thumbsup, thumbsdown, heart, eyes, cry, fire, check, x.

## Sending to Groups (full examples)

To send to a group chat, use `-t` with the group's chat_id (negative number):

```bash
bun cli.ts send -t "-1001234567890" "Hello group!"
```

Chat IDs come from inbox messages - the `chat_id` field on incoming messages tells you which group they came from. The operator's DMs use `owner_id` from `.credentials` as the default when no `-t` is provided.

To react in a group, provide both the message ID (`-t`) and the chat ID (`-c`):

```bash
bun cli.ts react thumbsup -t <msg_id> -c "-1001234567890"
```

## Known Groups

EXAMPLE - replace with your operator's groups. Recommend keeping a short table here with chat_id + descriptor, populated as new groups arrive on inbound. The auto-index pattern (see `groups/<group_id>.md` lazy-load if your skill ships it) is the durable source; this section is for human-readable shortcuts.

- `<group_chat_id_1>`: Description (operator + members, created YYYY-MM-DD)
- `<group_chat_id_2>`: Description

## Validation (cli.ts) - full list

All validation happens at write time in cli.ts. See SKILL.md "Validation" section for the full list (text + attachment + relay re-enforcement). Highlights here for quick reference:

- Non-empty message body.
- No double dashes, em dashes, en dashes, curly quotes, ellipsis characters.
- No API keys (`sk-ant-`, `sk-proj-`, `sk-admin-`, `ghp_`, `gho_`, `github_pat_`, `xoxb-`, `xoxp-`).
- No credential patterns (password / secret / token / api_key / access_key with values).
- No env / credential file paths.
- No PEM private key blocks.
- Attachment paths: existence + regular-file checks before queueing; canonicalized to match the relay's sandbox base.

## telegram-gramjs.ts Internal Features

- **PID lockfile**: validates via `/proc/pid/cmdline` that an existing PID is actually a telegram relay. Stale PIDs are logged and overridden.
- **Keepalive**: health check every 5 minutes with auto-reconnect.
- **Circuit breaker**: exits after 3 consecutive health failures for supervisor restart.
- **Audit rotation**: daily rotation of `audit.jsonl`.
- **Full-text logging**: audit and DM logs store complete message text (up to `MAX_LOG_TEXT` / 10K chars). No truncation of persistent records.
- **Entity preload**: on startup, fetches recent dialogs to populate GramJS entity cache. Enables immediate outbound messaging to any known contact without waiting for an inbound message first.
- **Media download**: photos, videos, documents, voice memos, audio attachments saved to `inbox/media/`.
- **Voice / audio detection**: incoming voice memos surface with `type: 'voice'`, audio with `type: 'audio'`, generic documents with `type: 'document'`. Duration in seconds where the source provides it.
- **Incoming reactions**: captured and queued to inbox.
- **Edited messages**: detected and queued with edited flag.

## Config

Credentials in `.credentials`:
- `api_id` - from https://my.telegram.org
- `api_hash` - from https://my.telegram.org
- `session` - GramJS StringSession (generated by `gramjs-login.ts`)
- `owner_id` - your operator's Telegram user ID (the human who owns this bot relay's outbound default)

Environment:
- `CALLBACK_SECRET` - required; loopback HTTP API auth. Generate with `openssl rand -hex 32`.
- `FILE_SEND_ROOT` - optional; sandbox root for outbound file paths. Defaults to `IDENTITY_DIR` (one level above this skill directory in the canonical install layout).
- `IDENTITY_DIR` - optional override for non-canonical layouts.
- `CHANNEL_NAME` - optional; channel push name override. Defaults to `telegram-channel`.

## File Layout

```
telegram-gramjs/
  SKILL.md           # Primary skill instructions (boot + per-chat-context + lazy-load pointers)
  reference.md       # This file - operational reference, lazy-load on demand
  cli.ts             # Agent CLI (send, react, inbox, health, etc.)
  telegram-gramjs.ts # GramJS relay (event-driven)
  gramjs-login.ts    # One-time session generator
  import-contacts-json.ts  # One-shot migration helper for legacy contacts.json layouts
  add-bot-to-group.ts     # Helper: add a bot to a group chat
  leave-group.ts          # Helper: leave a group
  send-poll.ts            # Helper: send a poll
  set-group-photo.ts      # Helper: change a group's photo
  verify-config.sh        # Sanity-check the .credentials file
  .credentials       # API keys, session, owner ID
  .relay.pid         # Current relay PID
  relay.log          # Relay stdout/stderr
  audit.jsonl        # All messages logged
  inbox/             # Incoming messages (JSON, processed by cli.ts inbox)
  inbox/processed/   # Processed messages archive
  inbox/media/       # Downloaded photos / videos / voice / audio / documents
  outbox/            # Outgoing messages (JSON, auto-deleted after send)
  contacts/          # Per-contact records (lazy-loaded by sender_id match)
    INDEX.md         # Known sender_id lookup
    <sender_id>.md   # Per-contact profile
```

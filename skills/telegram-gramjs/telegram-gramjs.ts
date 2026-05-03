/**
 * Telegram relay - GramJS user account.
 *
 * Connects as the configured Telegram user account (real account, not a bot).
 * Writes incoming messages from the configured operator to inbox/.
 * Watches outbox/ for responses and sends them.
 * No AI logic - the calling agent handles thinking.
 */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/Raw.js';
import { UpdateConnectionState } from 'telegram/network/index.js';
import fs from 'fs';
import path from 'path';
import http from 'http';

// --- Paths ---

const SKILL_DIR = path.dirname(new URL(import.meta.url).pathname);
// IDENTITY_DIR: identity-local root where attachments/logs persist. In the
// canonical install layout `<identity>/skills/<skill>/`, the parent of SKILL_DIR
// IS the identity root. The previous `../..` resolution landed at `system/` for
// the marketplace working tree, leaking host paths into channel payloads
// (security review MEDIUM #7). Operators can override via env when the skill is
// installed in a non-canonical layout.
const IDENTITY_DIR = process.env.IDENTITY_DIR
  ? path.resolve(process.env.IDENTITY_DIR)
  : path.resolve(SKILL_DIR, '..');
const CREDS_FILE = path.join(SKILL_DIR, '.credentials');
const INBOX_DIR = path.join(SKILL_DIR, 'inbox');
const OUTBOX_DIR = path.join(SKILL_DIR, 'outbox');
const MEDIA_DIR = path.join(INBOX_DIR, 'media');
const AUDIT_LOG = path.join(SKILL_DIR, 'audit.jsonl');
const PID_FILE = path.join(SKILL_DIR, '.relay.pid');

// Max chars stored in persistent audit/DM logs. Prevents disk bloat while
// preserving full message content for reliable history recall.
const MAX_LOG_TEXT = 10000;

// --- Channel push config ---
const HTTP_PORT = 15228;
const CHANNEL_URL = 'http://localhost:19880/message';
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'telegram-channel';

// HTTP API auth + file-path sandbox (security review HIGH #2).
// CALLBACK_SECRET (env): every POST / request must carry matching `secret` field
// or X-Callback-Secret header. Required - relay refuses to start without it so
// the loopback API is never accidentally unauthenticated. Generate once with
// `openssl rand -hex 32` and share it with bareclaw-channel via the same env.
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
// FILE_SEND_ROOT (env or default): file_path on send_file must resolve INSIDE this
// directory tree. Defaults to IDENTITY_DIR so attachments + work-data stay
// accessible while /etc/passwd / ~/.ssh keys / arbitrary host paths cannot be
// uploaded by a same-host attacker hitting the loopback API.
const FILE_SEND_ROOT = path.resolve(process.env.FILE_SEND_ROOT || IDENTITY_DIR);
if (!CALLBACK_SECRET) {
  console.error('[telegram-gramjs] CALLBACK_SECRET env required (HIGH #2). Generate with `openssl rand -hex 32`. Aborting.');
  process.exit(1);
}

// Constant-time string comparison so token-mismatch responses don't leak timing.
function timingSafeStrEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Resolves filePath, follows any symlinks, and verifies the result lies under
// FILE_SEND_ROOT. Rejects traversal, absolute paths outside the sandbox, and
// symlinks pointing out of the tree. Throws on failure.
function assertInsideSandbox(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('file_path required');
  }
  // Resolve relative paths against IDENTITY_DIR (not cwd) for predictable shape
  // regardless of where the relay is launched from.
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(IDENTITY_DIR, filePath);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (e: any) {
    throw new Error(`file_path does not exist: ${filePath}`);
  }
  const realRoot = fs.realpathSync(FILE_SEND_ROOT);
  // Use path.relative to robustly detect "is real inside realRoot" - rejecting
  // any '..' segment or absolute escape. String-prefix checks are unsafe across
  // sibling dirs that share a prefix (e.g. /home/x and /home/x-evil).
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`file_path outside FILE_SEND_ROOT: ${filePath}`);
  }
  return real;
}

// Per-dispatch defensive guarantee. Boot mkdir runs once; if INBOX_DIR
// or MEDIA_DIR is removed mid-run (operator cleanup, fs remount, container
// restart racing this process), every subsequent writeFileSync ENOENTs and
// the relay silently loses forwards until the dir returns. Recursive mkdir
// is a no-op when dirs exist.
function ensureInboxDirs(): void {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

for (const dir of [INBOX_DIR, OUTBOX_DIR, MEDIA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// --- Persistent messages dir ---
const MESSAGES_DIR = path.join(IDENTITY_DIR, 'id', 'messages');
const MESSAGES_ATTACH_DIR = path.join(MESSAGES_DIR, 'attachments');
fs.mkdirSync(MESSAGES_ATTACH_DIR, { recursive: true });

function copyToMessages(srcPath: string, originalName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = path.extname(originalName) || '.bin';
  const destName = `${ts}-${originalName.replace(ext, '')}${ext}`;
  const destPath = path.join(MESSAGES_ATTACH_DIR, destName);
  fs.copyFileSync(srcPath, destPath);
  return destPath;
}

// --- Channel push ---
// Retry queue for failed channel pushes
const retryQueue: string[] = [];
const MAX_RETRY_QUEUE = 100;
const RETRY_INTERVAL = 15_000; // 15s between retry attempts

function pushToChannel(msg: { platform: string; sender: string; chat_id: string; msg_id: string; text: string; user_id?: string; reply_to?: string; type?: string; target_msg_id?: string; emoji?: string; silent?: boolean; attachments?: { path: string; original_name: string; mime_type: string; size: number }[] }) {
  const payload = JSON.stringify({
    ...msg,
    received_at: new Date().toISOString(),
  });
  doChannelPush(payload);
}

function doChannelPush(payload: string, isRetry = false) {
  fetch(CHANNEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }).catch(err => {
    if (!isRetry && retryQueue.length < MAX_RETRY_QUEUE) {
      retryQueue.push(payload);
      console.error(`[telegram-gramjs] Channel push failed, queued for retry (${retryQueue.length}): ${err.message}`);
    } else if (isRetry) {
      // Re-queue failed retry if still room
      if (retryQueue.length < MAX_RETRY_QUEUE) retryQueue.push(payload);
      console.error(`[telegram-gramjs] Retry failed (${retryQueue.length} queued): ${err.message}`);
    } else {
      console.error(`[telegram-gramjs] Channel push failed, queue full: ${err.message}`);
    }
  });
}

// Process retry queue periodically
setInterval(() => {
  if (retryQueue.length === 0) return;
  const batch = retryQueue.splice(0, 5); // Retry up to 5 at a time
  console.log(`[telegram-gramjs] Retrying ${batch.length} queued pushes (${retryQueue.length} remaining)`);
  for (const payload of batch) {
    doChannelPush(payload, true);
  }
}, RETRY_INTERVAL);

// --- PID lockfile: prevent duplicate relay instances ---
function isTelegramRelay(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return cmdline.includes('telegram-gramjs.ts');
  } catch { return false; }
}

function checkPidLock(): void {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(oldPid)) {
      console.log(`[telegram-gramjs] Stale PID file (invalid content), taking over`);
    } else if (isTelegramRelay(oldPid)) {
      console.error(`[telegram-gramjs] Another relay is already running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } else {
      try {
        process.kill(oldPid, 0);
        console.log(`[telegram-gramjs] Stale PID ${oldPid} (not a telegram relay), taking over`);
      } catch {
        console.log(`[telegram-gramjs] Stale PID ${oldPid} (dead process), taking over`);
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
checkPidLock();

// --- Date-based audit rotation ---
function rotateAudit(): void {
  try {
    if (!fs.existsSync(AUDIT_LOG)) return;
    const stat = fs.statSync(AUDIT_LOG);
    const fileDate = stat.mtime.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (fileDate < today) {
      const archiveName = path.join(SKILL_DIR, `audit-${fileDate}.jsonl`);
      fs.renameSync(AUDIT_LOG, archiveName);
      console.log(`[telegram-gramjs] Rotated audit log to audit-${fileDate}.jsonl`);
    }
  } catch (err: any) {
    console.error(`[telegram-gramjs] Audit rotation error: ${err.message}`);
  }
}
rotateAudit();

// --- Config from .credentials ---

interface TelegramCreds {
  phone: string;
  api_id: string;
  api_hash: string;
  session: string;
  owner_id?: string;
}

function loadCredentials(): TelegramCreds {
  const raw = fs.readFileSync(CREDS_FILE, 'utf-8');
  return JSON.parse(raw);
}

const tg = loadCredentials();

if (!tg.api_id || !tg.api_hash || !tg.session) {
  console.error('[telegram-gramjs] Missing telegram credentials in .credentials');
  console.error('[telegram-gramjs] Need: api_id, api_hash, session');
  console.error('[telegram-gramjs] Run gramjs-login.ts first to generate session');
  process.exit(1);
}

const API_ID = parseInt(tg.api_id, 10);
const API_HASH = tg.api_hash;
const SESSION_STR = tg.session;
const OWNER_ID = tg.owner_id ? BigInt(tg.owner_id) : null;

// --- Audit ---

function audit(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ...entry, _ts: new Date().toISOString() });
  fs.appendFileSync(AUDIT_LOG, line + '\n');
}

// --- Outbox watcher ---

function watchOutbox(client: TelegramClient): void {
  let processing = false;
  setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
    let files: string[];
    try {
      files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files) {
      const filePath = path.join(OUTBOX_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath); // delete before send to prevent re-trigger

        const chatId = data.chat_id;
        if (!chatId) continue;

        if (data.reaction) {
          // Send reaction to a message
          const msgId = data.message_id;
          if (msgId) {
            try {
              const peer = await getInputEntitySafe(client, chatId);
              await client.invoke(new Api.messages.SendReaction({
                peer: peer,
                msgId: msgId,
                reaction: [new Api.ReactionEmoji({ emoticon: data.reaction })],
              }));
              audit({ type: 'sent_reaction', chat_id: chatId, message_id: msgId, reaction: data.reaction });
            } catch (reactErr: any) {
              console.error(`[telegram-gramjs] Reaction failed: ${reactErr.message}`);
              audit({ type: 'reaction_failed', chat_id: chatId, message_id: msgId, reaction: data.reaction, error: reactErr.message });
            }
          }
        } else if (data.photo) {
          // Send photo - sandbox check (security review MEDIUM #4): outbox is also
          // a host-local control surface. Same-host attacker who plants a JSON
          // here could exfil arbitrary files via Telegram. Apply same sandbox.
          let sandboxedPhoto: string;
          try {
            sandboxedPhoto = assertInsideSandbox(data.photo);
          } catch (e: any) {
            audit({ type: 'photo_rejected', chat_id: chatId, photo: data.photo, reason: e.message });
            console.error(`[telegram-gramjs] Outbox photo rejected: ${e.message}`);
            continue;
          }
          await sendFileSafe(client, chatId, {
            file: sandboxedPhoto,
            caption: data.caption || '',
          });
          audit({ type: 'sent_photo', chat_id: chatId, photo: sandboxedPhoto });
        } else if (data.text) {
          const text = data.text;
          // Send text - split if >4096 chars
          const MAX_LEN = 4096;
          if (text.length <= MAX_LEN) {
            await sendMessageSafe(client, chatId, { message: text });
          } else {
            for (let i = 0; i < text.length; i += MAX_LEN) {
              await sendMessageSafe(client, chatId, { message: text.slice(i, i + MAX_LEN) });
            }
          }
          audit({ type: 'sent', chat_id: chatId, length: text.length });
        }
      } catch (err: any) {
        console.error(`[telegram-gramjs] Outbox error ${file}: ${err.message}`);
        // Remove bad files to prevent infinite retry loop
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    } finally {
      processing = false;
    }
  }, 1000);
}

// --- Peer-resolution helpers ---
//
// Freshly created chats (or chats not in the boot-time getDialogs preload)
// raise PEER_ID_INVALID on the first send/react. Wrap GramJS calls so that
// on this specific error we refresh the dialog list and retry once. This
// fixes the failure mode where the operator adds the relay account to a
// brand-new group/channel after boot and the first outbound message bounces.

function isPeerInvalid(err: any): boolean {
  const m = err?.message || err?.errorMessage || '';
  return m.includes('PEER_ID_INVALID')
    || m.includes('CHANNEL_INVALID')
    || m.includes('CHAT_ID_INVALID')
    // gramjs-side cache miss when a chat_id was only seen as inbound and
    // not yet registered in the input-peer cache (different surface from the
    // Telegram-server PEER_ID_INVALID). Triggers refreshDialogs retry.
    || m.includes('Could not find the input entity');
}

async function refreshDialogs(client: TelegramClient): Promise<void> {
  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    console.log(`[telegram-gramjs] Dialog refresh: ${dialogs.length} entities cached`);
  } catch (e: any) {
    console.warn(`[telegram-gramjs] Dialog refresh failed: ${e.message}`);
  }
}

async function sendMessageSafe(client: TelegramClient, chatId: any, opts: any): Promise<any> {
  try {
    return await client.sendMessage(chatId, opts);
  } catch (e: any) {
    if (!isPeerInvalid(e)) throw e;
    console.warn(`[telegram-gramjs] PEER_ID_INVALID on sendMessage to ${chatId} — refreshing dialogs and retrying once`);
    await refreshDialogs(client);
    return await client.sendMessage(chatId, opts);
  }
}

async function sendFileSafe(client: TelegramClient, chatId: any, opts: any): Promise<any> {
  try {
    return await client.sendFile(chatId, opts);
  } catch (e: any) {
    if (!isPeerInvalid(e)) throw e;
    console.warn(`[telegram-gramjs] PEER_ID_INVALID on sendFile to ${chatId} — refreshing dialogs and retrying once`);
    await refreshDialogs(client);
    return await client.sendFile(chatId, opts);
  }
}

async function getInputEntitySafe(client: TelegramClient, chatId: any): Promise<any> {
  try {
    return await client.getInputEntity(chatId);
  } catch (e: any) {
    if (!isPeerInvalid(e)) throw e;
    console.warn(`[telegram-gramjs] PEER_ID_INVALID on getInputEntity for ${chatId} — refreshing dialogs and retrying once`);
    await refreshDialogs(client);
    return await client.getInputEntity(chatId);
  }
}

// --- Main ---

// --- Update stream tracking ---
let lastUpdateAt = Date.now();
let totalUpdates = 0;

function touchUpdate(): void {
  lastUpdateAt = Date.now();
  totalUpdates++;
}

async function main() {
  const session = new StringSession(SESSION_STR);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: Infinity,
  });

  await client.connect();

  // Get own user info
  const me = await client.getMe() as any;
  console.log('[telegram-gramjs] Connected as ' + (me.username ? '@' + me.username : me.id.toString()));
  console.log(`[telegram-gramjs] Logged in as: ${me.firstName} ${me.lastName || ''} (ID: ${me.id})`);

  // Preflight: owner_id must be the CREATOR (person I surface DMs from), not the authenticated account itself.
  // If they match, every DM from the real creator would be silenced. Abort instead of starting broken.
  if (OWNER_ID !== null && me.id && OWNER_ID.toString() === me.id.toString()) {
    console.error(`[telegram-gramjs] FATAL: .credentials.owner_id (${OWNER_ID}) equals authenticated account id (${me.id}).`);
    console.error(`[telegram-gramjs] owner_id must be the CREATOR's user id, not this account. DMs from the creator will be silenced if left as-is.`);
    console.error(`[telegram-gramjs] Fix .credentials.owner_id and restart.`);
    audit({ type: 'preflight_fail', reason: 'owner_id_equals_self', owner_id: OWNER_ID.toString(), self_id: me.id.toString() });
    process.exit(2);
  }
  if (OWNER_ID === null) {
    console.error(`[telegram-gramjs] FATAL: .credentials.owner_id is not set. Set it to the CREATOR's user id and restart.`);
    audit({ type: 'preflight_fail', reason: 'owner_id_missing' });
    process.exit(2);
  }

  // Pre-load entity cache so we can send to any known contact immediately after restart
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    console.log(`[telegram-gramjs] Entity cache loaded: ${dialogs.length} dialogs`);
  } catch (e: any) {
    console.warn(`[telegram-gramjs] Entity cache preload failed: ${e.message}`);
  }

  // --- Connection state handler (only log disconnected/broken, not every ping) ---
  let lastConnState = 1; // start as connected
  client.addEventHandler(async (event: any) => {
    if (event instanceof UpdateConnectionState) {
      const state = event.state;
      if (state === 1) {
        touchUpdate();
        if (lastConnState !== 1) {
          console.log(`[telegram-gramjs] Connection restored`);
          audit({ type: 'connection_restored' });
        }
      } else {
        const label = state === -1 ? 'disconnected' : 'broken';
        console.log(`[telegram-gramjs] Connection state: ${label}`);
        audit({ type: 'connection_state', state: label });
      }
      lastConnState = state;
    }
  });

  // --- Incoming message handler ---
  client.addEventHandler(async (event: NewMessageEvent) => {
    const msg = event.message;
    if (!msg || !msg.peerId) return;
    touchUpdate();

    ensureInboxDirs();

    // Get sender info
    const senderId = msg.senderId;
    const isFromSelf = senderId?.equals(me.id);

    // Skip our own messages
    if (isFromSelf) return;

    // Get chat info
    const chatId = msg.chatId?.toString() || '';
    const senderName = await getSenderName(client, senderId);
    const text = msg.text || '';
    const ts = new Date().toISOString();

    audit({
      type: 'received',
      user_id: senderId?.toString(),
      chat_id: chatId,
      sender: senderName,
      text: text.length > MAX_LOG_TEXT ? text.slice(0, MAX_LOG_TEXT) + ' [truncated]' : text,
    });

    // Determine if this is a DM or group chat
    const isPrivate = msg.peerId?.className === 'PeerUser';

    // Filter: in DMs, push everything (owner + non-owner) so the calling
    // agent sees pre-authorized contacts that the operator has cleared
    // in-flight. The agent gates engagement; the relay just delivers
    // visibility. Pre-2026-04-26 behavior was to mark non-owner DMs
    // silent: true (logged-only) which silently dropped pre-authorized
    // contacts and burned cycles chasing missed messages.
    if (isPrivate && OWNER_ID && senderId && !senderId.equals(OWNER_ID)) {
      console.log(`[telegram-gramjs] DM from non-owner: ${senderName} (${senderId}) - pushing to session (REM gates engagement)`);
      pushToChannel({
        platform: 'telegram',
        sender: senderName,
        chat_id: String(senderId),
        msg_id: String(msg.id),
        text: text,
        user_id: senderId?.toString(),
      });
      return;
    }

    // Check for media (photo, video, document)
    let media: Record<string, string> | undefined;
    if (msg.photo) {
      try {
        const buffer = await client.downloadMedia(msg, {});
        if (buffer && Buffer.isBuffer(buffer)) {
          const filename = `${Date.now()}-${msg.id}.jpg`;
          const mediaPath = path.join(MEDIA_DIR, filename);
          fs.writeFileSync(mediaPath, buffer);
          media = { type: 'photo', path: mediaPath };
        }
      } catch (e: any) {
        console.error(`[telegram-gramjs] Photo download failed: ${e.message}`);
      }
    } else if (msg.video) {
      try {
        const buffer = await client.downloadMedia(msg, {});
        if (buffer && Buffer.isBuffer(buffer)) {
          const mime = (msg.video as any)?.mimeType || '';
          const ext = mime.includes('mp4') ? '.mp4' : '.vid';
          const filename = `${Date.now()}-${msg.id}${ext}`;
          const mediaPath = path.join(MEDIA_DIR, filename);
          fs.writeFileSync(mediaPath, buffer);
          media = { type: 'video', path: mediaPath, mime };
        }
      } catch (e: any) {
        console.error(`[telegram-gramjs] Video download failed: ${e.message}`);
      }
    } else if (msg.document) {
      try {
        const buffer = await client.downloadMedia(msg, {});
        if (buffer && Buffer.isBuffer(buffer)) {
          const doc = msg.document as any;
          const attrs: any[] = doc?.attributes || [];
          const audioAttr = attrs.find((a: any) => a.className === 'DocumentAttributeAudio');
          const fileNameAttr = attrs.find((a: any) => a.fileName);
          const docMime = doc?.mimeType || '';

          // Voice messages: DocumentAttributeAudio with voice=true. Telegram convention = audio/ogg.
          // Audio (non-voice) messages: DocumentAttributeAudio without voice flag (e.g. uploaded mp3).
          // Otherwise plain document.
          if (audioAttr && audioAttr.voice) {
            const ext = '.ogg';
            const filename = `${Date.now()}-${msg.id}${ext}`;
            const mediaPath = path.join(MEDIA_DIR, filename);
            fs.writeFileSync(mediaPath, buffer);
            const meta: Record<string, string> = { type: 'voice', path: mediaPath, mime: docMime || 'audio/ogg' };
            if (audioAttr.duration) meta.duration_s = String(audioAttr.duration);
            media = meta;
          } else if (audioAttr) {
            const origName = fileNameAttr?.fileName || `${msg.id}.audio`;
            const ext = path.extname(origName) || (docMime.includes('mpeg') ? '.mp3' : docMime.includes('wav') ? '.wav' : '.audio');
            const filename = `${Date.now()}-${msg.id}${ext}`;
            const mediaPath = path.join(MEDIA_DIR, filename);
            fs.writeFileSync(mediaPath, buffer);
            const meta: Record<string, string> = { type: 'audio', path: mediaPath, mime: docMime || 'application/octet-stream', filename: origName };
            if (audioAttr.duration) meta.duration_s = String(audioAttr.duration);
            if (audioAttr.title) meta.title = audioAttr.title;
            if (audioAttr.performer) meta.performer = audioAttr.performer;
            media = meta;
          } else {
            const origName = fileNameAttr?.fileName || 'file';
            const ext = path.extname(origName) || '.bin';
            const filename = `${Date.now()}-${msg.id}${ext}`;
            const mediaPath = path.join(MEDIA_DIR, filename);
            fs.writeFileSync(mediaPath, buffer);
            media = { type: 'document', path: mediaPath, filename: origName, mime: docMime || 'application/octet-stream' };
          }
        }
      } catch (e: any) {
        console.error(`[telegram-gramjs] Document download failed: ${e.message}`);
      }
    }

    // Write to inbox
    const inboxFile = `${Date.now()}-${msg.id}.json`;
    const payload: Record<string, unknown> = {
      id: msg.id,
      chat_id: chatId,
      user_id: senderId?.toString(),
      sender: senderName,
      text,
      timestamp: ts,
    };
    if (media) payload.media = media;

    fs.writeFileSync(
      path.join(INBOX_DIR, inboxFile),
      JSON.stringify(payload, null, 2),
    );

    // Copy media to id/messages/attachments/ for persistent logging
    let msgAttachments: { path: string; original_name: string; mime_type: string; size: number }[] | undefined;
    if (media) {
      try {
        const extByType: Record<string, string> = { photo: 'jpg', video: 'mp4', voice: 'ogg', audio: 'audio', document: 'bin' };
        const fallbackExt = extByType[media.type] || 'bin';
        const origName = (media as any).filename || `${msg.id}.${fallbackExt}`;
        const destPath = copyToMessages(media.path, origName);
        const stat = fs.statSync(destPath);
        const mimeByType: Record<string, string> = { photo: 'image/jpeg', voice: 'audio/ogg' };
        msgAttachments = [{
          path: destPath,
          original_name: origName,
          mime_type: (media as any).mime || mimeByType[media.type] || 'application/octet-stream',
          size: stat.size,
        }];
      } catch (e: any) {
        console.error(`[telegram-gramjs] Attachment copy failed: ${e.message}`);
      }
    }

    // Extract reply-to if this message is a reply
    const replyToMsgId = (msg.replyTo as any)?.replyToMsgId;

    // Push to channel server
    pushToChannel({
      platform: 'telegram',
      sender: senderName,
      chat_id: chatId,
      msg_id: msg.id.toString(),
      text,
      user_id: senderId?.toString(),
      ...(replyToMsgId ? { reply_to: String(replyToMsgId) } : {}),
      attachments: msgAttachments,
    });

    console.log(`[telegram-gramjs] Queued: ${senderName}: ${text.slice(0, 80)}`);
  }, new NewMessage({}));

  // --- Edited message handler ---
  client.addEventHandler(async (event: any) => {
    if (event instanceof Api.UpdateEditMessage) {
      touchUpdate();
      const msg = event.message as any;
      if (!msg || !msg.peerId) return;

      const senderId = msg.fromId?.userId || msg.peerId?.userId;
      if (!senderId) return;

      // Skip our own edits
      if (senderId.equals && senderId.equals(me.id)) return;
      if (senderId === me.id) return;

      const chatId = msg.peerId?.userId?.toString() || msg.peerId?.chatId?.toString() || msg.peerId?.channelId?.toString() || '';
      const senderName = await getSenderName(client, senderId);
      const text = msg.message || '';
      const ts = new Date().toISOString();

      audit({
        type: 'edited',
        user_id: senderId?.toString(),
        chat_id: chatId,
        sender: senderName,
        message_id: msg.id,
        text: text.length > MAX_LOG_TEXT ? text.slice(0, MAX_LOG_TEXT) + ' [truncated]' : text,
      });

      // Write to inbox with edited flag
      ensureInboxDirs();
      const filename = `${Date.now()}-${msg.id}-edit.json`;
      fs.writeFileSync(
        path.join(INBOX_DIR, filename),
        JSON.stringify({
          id: msg.id,
          chat_id: chatId,
          user_id: senderId?.toString(),
          sender: senderName,
          text,
          edited: true,
          timestamp: ts,
        }, null, 2),
      );

      // Push edited message to channel server
      const replyToMsgId = (msg.replyTo as any)?.replyToMsgId;
      pushToChannel({
        platform: 'telegram',
        sender: senderName,
        chat_id: chatId,
        msg_id: msg.id.toString(),
        text: `(edited) ${text}`,
        user_id: senderId?.toString(),
        ...(replyToMsgId ? { reply_to: String(replyToMsgId) } : {}),
      });

      console.log(`[telegram-gramjs] Queued edit: ${senderName}: ${text.slice(0, 80)}`);
    }
  }, new Raw({}));

  // --- Incoming reaction handler ---
  // Track pushed reactions to avoid duplicates when UpdateMessageReactions re-fires
  const pushedReactions = new Map<string, Set<string>>(); // msgId -> Set of "userId:emoji"
  setInterval(() => {
    // Prune entries older than 1 hour (by keeping only recent 500 entries)
    if (pushedReactions.size > 500) {
      const keys = [...pushedReactions.keys()];
      for (const k of keys.slice(0, keys.length - 500)) pushedReactions.delete(k);
    }
  }, 60_000);

  client.addEventHandler(async (event: any) => {
    // UpdateMessageReactions fires when someone reacts to a message in a chat
    if (event instanceof Api.UpdateMessageReactions) {
      touchUpdate();
      const msgId = event.msgId;
      const peer = event.peer;

      // Extract chat ID from peer
      let chatId = '';
      if (peer instanceof Api.PeerUser) {
        chatId = peer.userId.toString();
      } else if (peer instanceof Api.PeerChat) {
        chatId = peer.chatId.toString();
      } else if (peer instanceof Api.PeerChannel) {
        chatId = peer.channelId.toString();
      }

      // Use getMessageReactionsList to get WHO reacted with WHAT
      try {
        const reactionsList = await client.invoke(
          new Api.messages.GetMessageReactionsList({
            peer,
            id: msgId,
            limit: 50,
          })
        );

        const reactionEntries: { userId: string; emoji: string; senderName: string }[] = [];
        const msgKey = `${chatId}:${msgId}`;
        if (!pushedReactions.has(msgKey)) pushedReactions.set(msgKey, new Set());
        const seen = pushedReactions.get(msgKey)!;

        if (reactionsList && (reactionsList as any).reactions) {
          for (const r of (reactionsList as any).reactions) {
            const userId = r.peerId?.userId?.toString() || 'unknown';
            // Standard unicode emoji: ReactionEmoji.emoticon. Premium custom emoji:
            // ReactionCustomEmoji.documentId (no inline glyph; render an opaque tag
            // instead of a literal '?', which collides with English punctuation in
            // logs and looks like data corruption).
            let emoji = '?';
            if (r.reaction instanceof Api.ReactionEmoji) {
              emoji = r.reaction.emoticon;
            } else if (r.reaction instanceof Api.ReactionCustomEmoji) {
              emoji = `[custom:${r.reaction.documentId}]`;
            }
            // Skip our own reactions
            if (userId === me.id.toString()) continue;
            // Skip already-pushed reactions
            const dedupeKey = `${userId}:${emoji}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const senderName = await getSenderName(client, r.peerId?.userId);
            reactionEntries.push({ userId, emoji, senderName });
          }
        }

        if (reactionEntries.length === 0) return;

        const emojis = reactionEntries.map(r => r.emoji);

        audit({
          type: 'reaction_received',
          chat_id: chatId,
          message_id: msgId,
          reactions: reactionEntries.map(r => ({ user: r.senderName, emoji: r.emoji })),
        });

        // Write to inbox as reaction event
        ensureInboxDirs();
        const filename = `${Date.now()}-${msgId}-reaction.json`;
        fs.writeFileSync(
          path.join(INBOX_DIR, filename),
          JSON.stringify({
            id: msgId,
            chat_id: chatId,
            reactions: reactionEntries.map(r => ({ user: r.senderName, user_id: r.userId, emoji: r.emoji })),
            type: 'reaction',
            timestamp: new Date().toISOString(),
          }, null, 2),
        );

        // Push each reaction to channel server with proper sender identification
        for (const entry of reactionEntries) {
          pushToChannel({
            platform: 'telegram',
            sender: entry.senderName,
            chat_id: chatId,
            msg_id: msgId.toString(),
            text: `(reaction: ${entry.emoji})`,
            type: 'reaction',
            target_msg_id: msgId.toString(),
            emoji: entry.emoji,
            user_id: entry.userId,
          });
        }

        console.log(`[telegram-gramjs] Queued reaction: ${reactionEntries.map(r => `${r.senderName}:${r.emoji}`).join(', ')} on msg ${msgId} in ${chatId}`);
      } catch (err: any) {
        // Fallback: if getMessageReactionsList fails, still push with aggregate data
        const emojis: string[] = [];
        const reactions = event.reactions;
        if (reactions && (reactions as any).results) {
          for (const result of (reactions as any).results) {
            const reaction = result.reaction;
            if (reaction instanceof Api.ReactionEmoji) {
              emojis.push(reaction.emoticon);
            }
          }
        }
        if (emojis.length > 0) {
          for (const emoji of emojis) {
            pushToChannel({
              platform: 'telegram',
              sender: 'unknown',
              chat_id: chatId,
              msg_id: msgId.toString(),
              text: `(reaction: ${emoji})`,
              type: 'reaction',
              target_msg_id: msgId.toString(),
              emoji,
            });
          }
          console.log(`[telegram-gramjs] Queued reaction (fallback): ${emojis.join(', ')} on msg ${msgId} in ${chatId}`);
        }
        console.error(`[telegram-gramjs] getMessageReactionsList failed: ${err.message}`);
      }
    }
  }, new Raw({}));

  // Start outbox watcher
  watchOutbox(client);

  // --- Heartbeat: log every 60s so relay.log mtime is always fresh ---
  const HEARTBEAT_MS = 60 * 1000;
  setInterval(() => {
    const uptimeSec = Math.floor(process.uptime());
    const updateAge = Math.floor((Date.now() - lastUpdateAt) / 1000);
    console.log(`[telegram-gramjs] heartbeat uptime=${uptimeSec}s updates=${totalUpdates} last_update=${updateAge}s_ago`);
  }, HEARTBEAT_MS);

  // --- Update stream refresh: call updates.GetState() every 2 min ---
  // GramJS built-in refresh is 30 min - too slow. Telegram can kill the
  // update channel during idle periods. This keeps it alive.
  const UPDATE_REFRESH_MS = 2 * 60 * 1000;
  setInterval(async () => {
    try {
      await client.invoke(new Api.updates.GetState());
      touchUpdate();
    } catch (e: any) {
      console.error(`[telegram-gramjs] updates.GetState failed: ${e.message}`);
    }
  }, UPDATE_REFRESH_MS);

  // --- Health check: every 2 min, checks API + update stream ---
  const HEALTH_INTERVAL_MS = 2 * 60 * 1000;
  const STALE_UPDATE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min without any update = stale
  let consecutiveFailures = 0;

  setInterval(async () => {
    const updateAge = Date.now() - lastUpdateAt;
    try {
      await client.getMe();
      consecutiveFailures = 0;

      // API works but update stream might be dead
      if (updateAge > STALE_UPDATE_THRESHOLD_MS) {
        console.log(`[telegram-gramjs] Health OK but update stream stale (${Math.floor(updateAge / 1000)}s). Forcing reconnect.`);
        audit({ type: 'stale_reconnect', update_age_s: Math.floor(updateAge / 1000) });
        await client.disconnect();
        await client.connect();
        touchUpdate();
        console.log(`[telegram-gramjs] Reconnected to refresh update stream`);
      } else {
        console.log(`[telegram-gramjs] Health OK. update_age=${Math.floor(updateAge / 1000)}s`);
      }
    } catch (err: any) {
      consecutiveFailures++;
      console.error(`[telegram-gramjs] Health check failed (${consecutiveFailures}): ${err.message}`);
      audit({ type: 'health_failed', failures: consecutiveFailures, error: err.message });

      try {
        console.log('[telegram-gramjs] Attempting reconnect...');
        await client.disconnect();
        await client.connect();
        touchUpdate();
        console.log('[telegram-gramjs] Reconnected successfully');
        audit({ type: 'reconnected', after_failures: consecutiveFailures });
      } catch (reconnErr: any) {
        console.error(`[telegram-gramjs] Reconnect failed: ${reconnErr.message}`);
        audit({ type: 'reconnect_failed', error: reconnErr.message });

        if (consecutiveFailures >= 3) {
          console.error('[telegram-gramjs] 3 consecutive health failures. Exiting for restart.');
          audit({ type: 'health_exit', failures: consecutiveFailures });
          process.exit(1);
        }
      }
    }
  }, HEALTH_INTERVAL_MS);

  console.log(`[telegram-gramjs] Relay started`);
  console.log(`[telegram-gramjs] Owner: ${OWNER_ID || 'not set (accepting all)'}`);
  console.log(`[telegram-gramjs] Inbox: ${INBOX_DIR}`);
  console.log(`[telegram-gramjs] Outbox: ${OUTBOX_DIR}`);
  console.log(`[telegram-gramjs] Health check: every ${HEALTH_INTERVAL_MS / 1000}s`);
  console.log(`[telegram-gramjs] Update refresh: every ${UPDATE_REFRESH_MS / 1000}s`);
  console.log(`[telegram-gramjs] Heartbeat: every ${HEARTBEAT_MS / 1000}s`);

  // --- HTTP callback server for channel sends ---
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        relay: 'telegram-gramjs',
        port: HTTP_PORT,
        connected: client.connected,
        uptime_s: Math.floor(process.uptime()),
        retry_queue: retryQueue.length,
        pid: process.pid,
      }));
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '')) {
      let body = '';
      let totalBytes = 0;
      const MAX_BODY_BYTES = 1 << 20; // 1 MiB - prevent memory blow-up on hostile loopback callers
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          if (!aborted) {
            aborted = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'body too large' }));
            req.destroy();
          }
          return;
        }
        body += chunk;
      });
      req.on('end', async () => {
        if (aborted) return;
        try {
          const data = JSON.parse(body);
          // Auth: header takes precedence over body field, both supported for
          // operator convenience. bareclaw-channel.ts already sends `X-Relay-Secret`
          // so accept that name too. Constant-time compare prevents timing leaks.
          const headerSecret = req.headers['x-relay-secret'] || req.headers['x-callback-secret'];
          const presented = (typeof headerSecret === 'string' && headerSecret) || data.secret || '';
          if (!presented || !timingSafeStrEq(String(presented), CALLBACK_SECRET)) {
            audit({ type: 'auth_rejected', remote: req.socket.remoteAddress, path: url.pathname });
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
            return;
          }
          const chatId = data.chat_id || OWNER_ID;
          const action = data.action;

          if (action === 'send') {
            const text = data.text;
            if (!text) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'text required' }));
              return;
            }
            const finalText = text;
            const replyTo = data.reply_to ? Number(data.reply_to) : undefined;
            const sendOpts: any = { message: finalText };
            if (replyTo) sendOpts.replyTo = replyTo;
            // Parse mentions: [{"offset":0,"length":5,"user_id":"12345"}]
            if (data.mentions) {
              try {
                const mentions = typeof data.mentions === 'string' ? JSON.parse(data.mentions) : data.mentions;
                if (Array.isArray(mentions) && mentions.length > 0) {
                  sendOpts.entities = mentions.map((m: any) => new Api.MessageEntityMentionName({
                    offset: Number(m.offset),
                    length: Number(m.length),
                    userId: BigInt(m.user_id),
                  }));
                }
              } catch (e: any) {
                console.warn(`[telegram-gramjs] Failed to parse mentions: ${e.message}`);
              }
            }
            const MAX_LEN = 4096;
            if (finalText.length <= MAX_LEN) {
              await sendMessageSafe(client, chatId, sendOpts);
            } else {
              for (let i = 0; i < finalText.length; i += MAX_LEN) {
                const chunkOpts: any = { message: finalText.slice(i, i + MAX_LEN) };
                if (i === 0 && replyTo) chunkOpts.replyTo = replyTo;
                await sendMessageSafe(client, chatId, chunkOpts);
              }
            }
            audit({ type: 'channel_sent', chat_id: chatId, length: finalText.length });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

          } else if (action === 'react') {
            const msgId = Number(data.msg_id);
            const emoji = data.emoji;
            if (!msgId || !emoji) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'msg_id and emoji required' }));
              return;
            }
            const peer = await getInputEntitySafe(client, chatId);
            await client.invoke(new Api.messages.SendReaction({
              peer,
              msgId,
              reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
            }));
            audit({ type: 'channel_reaction', chat_id: chatId, message_id: msgId, emoji });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

          } else if (action === 'send_file') {
            const filePath = data.file_path;
            const caption = data.caption || '';
            if (!filePath) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'file_path required' }));
              return;
            }
            let sandboxedPath: string;
            try {
              sandboxedPath = assertInsideSandbox(filePath);
            } catch (e: any) {
              audit({ type: 'send_file_rejected', chat_id: chatId, file: filePath, reason: e.message });
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: e.message }));
              return;
            }
            await sendFileSafe(client, chatId, { file: sandboxedPath, caption });
            audit({ type: 'channel_sent_file', chat_id: chatId, file: sandboxedPath });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `unknown action: ${action}` }));
          }
        } catch (err: any) {
          console.error(`[telegram-gramjs] HTTP callback error: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[telegram-gramjs] HTTP callback server on 127.0.0.1:${HTTP_PORT}`);
  });
}

const senderNameCache = new Map<string, string>();
async function getSenderName(client: TelegramClient, senderId: any): Promise<string> {
  if (!senderId) return 'Unknown';
  const key = senderId.toString();
  if (senderNameCache.has(key)) return senderNameCache.get(key)!;
  try {
    const entity = await client.getEntity(senderId);
    const user = entity as any;
    const name = user.firstName || user.username || key;
    senderNameCache.set(key, name);
    return name;
  } catch {
    return key;
  }
}

main().catch((err) => {
  console.error('[telegram-gramjs] Fatal:', err.message || err);
  process.exit(1);
});

/**
 * Telegram CLI tool for agents.
 *
 * Single writer to outbox/ - agents use this instead of writing JSON directly.
 * All validation happens here at write time. telegram-gramjs.ts stays dumb.
 *
 * Usage:
 *   npx tsx cli.ts send "hey there"
 *   npx tsx cli.ts send --to 12345678 "message"
 *   npx tsx cli.ts react thumbsup --to 123
 *   npx tsx cli.ts react thumbsup --to 123 --chat 12345678
 *   npx tsx cli.ts inbox              Process all: react, move, return JSON
 *   npx tsx cli.ts inbox --count       Count only (no processing)
 *   npx tsx cli.ts contacts
 *   npx tsx cli.ts health
 */

import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.dirname(new URL(import.meta.url).pathname);
// Match relay's IDENTITY_DIR resolution exactly (telegram-gramjs.ts) so CLI
// path canonicalization lines up with the relay's sandbox base. security review
// blocking #1: relative attachment paths must resolve to the SAME absolute
// path on both sides.
const IDENTITY_DIR = process.env.IDENTITY_DIR
  ? path.resolve(process.env.IDENTITY_DIR)
  : path.resolve(SKILL_DIR, '..');
const CREDS_FILE = path.join(SKILL_DIR, '.credentials');
const INBOX_DIR = path.join(SKILL_DIR, 'inbox');
const OUTBOX_DIR = path.join(SKILL_DIR, 'outbox');

// --- Credentials ---

interface TelegramCreds {
  phone: string;
  api_id: string;
  owner_id?: string;
}

function loadCredentials(): TelegramCreds {
  return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
}

const creds = loadCredentials();
const OWNER_ID = creds.owner_id || '';

// --- Emoji name map ---

const EMOJI_NAMES: Record<string, string> = {
  'thumbsup': '\u{1F44D}',
  'thumbsdown': '\u{1F44E}',
  'heart': '\u{2764}\u{FE0F}',
  'eyes': '\u{1F440}',
  'cry': '\u{1F622}',
  'fire': '\u{1F525}',
  'check': '\u{2705}',
  'x': '\u{274C}',
};

// --- Validation ---

// Normalize text before regex checks (security review MEDIUM #3 + rev-2 nit):
// zero-width and other invisible/format chars let an attacker bypass the
// credential filters (e.g. `sk-\u200Bproj-...` slips past the literal
// `sk-proj-` regex). Strip the zero-width / format-char range + BOM, then
// NFC-normalize canonical equivalents before the pattern match runs. NFC does
// NOT defend against confusables (e.g. Cyrillic 'a' that looks like Latin
// 'a'); that requires explicit confusable folding which we do not implement.
// Scope is invisible-char bypass only.
function normalizeForCheck(text: string): string {
  return text
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .normalize('NFC');
}

function validateMessage(text: string): string | null {
  if (!text || text.trim().length === 0) {
    return 'Message body is empty';
  }

  // ASCII punctuation only - check original text so authors see friendly errors.
  if (/--/.test(text)) return 'Contains double dash (use single - instead)';
  if (/\u2014/.test(text)) return 'Contains em dash (use - instead)';
  if (/\u2013/.test(text)) return 'Contains en dash (use - instead)';
  if (/[\u201C\u201D]/.test(text)) return 'Contains curly double quotes (use " instead)';
  if (/[\u2018\u2019]/.test(text)) return 'Contains curly single quotes (use \' instead)';
  if (/\u2026/.test(text)) return 'Contains ellipsis character (use ... instead)';

  // Reject zero-width / format chars outright - no legitimate use in outbound.
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/.test(text)) {
    return 'Contains invisible/format characters (zero-width, BOM, etc.)';
  }

  // Credential/env patterns - run on the normalized (NFC + format-char-stripped)
  // form so any residual format chars cannot disguise the keys. Confusable
  // folding is out of scope - see normalizeForCheck note.
  const normalized = normalizeForCheck(text);
  if (/(?:sk-ant-|sk-proj-|sk-admin-|ghp_|gho_|github_pat_|xoxb-|xoxp-)\S+/i.test(normalized)) {
    return 'Message appears to contain an API key';
  }
  if (/(?:password|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?\S{8,}/i.test(normalized)) {
    return 'Message appears to contain credentials';
  }
  if (/(?:\/home\/\w+\/\.(?:env|credentials|ssh))/i.test(normalized)) {
    return 'Message appears to contain env/credential paths';
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized)) {
    return 'Message appears to contain a PEM private key';
  }

  return null;
}

// Validate --attachment path before queueing (security review MEDIUM #4 +
// blocking-on-rev-2). Returns either an error string OR the canonical absolute
// path that matches what the relay's assertInsideSandbox() will compute. We
// resolve relative paths against IDENTITY_DIR (NOT cwd) so CLI + relay agree
// on what "this attachment" means; otherwise a relative path could pass CLI
// validation (resolved from cwd) and fail at relay send time (resolved from
// IDENTITY_DIR).
function validateAttachmentPath(attachment: string): { error: string } | { ok: string } {
  if (!attachment) return { error: 'Attachment path is empty' };
  if (/[\0\r\n]/.test(attachment)) return { error: 'Attachment path contains control characters' };
  let abs: string;
  try {
    abs = path.isAbsolute(attachment) ? attachment : path.resolve(IDENTITY_DIR, attachment);
  } catch {
    return { error: 'Attachment path is not resolvable' };
  }
  if (!fs.existsSync(abs)) return { error: `Attachment path does not exist: ${abs}` };
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (e: any) {
    return { error: `Attachment path realpath failed: ${e.message}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch (e: any) {
    return { error: `Attachment path stat failed: ${e.message}` };
  }
  if (!stat.isFile()) return { error: 'Attachment path is not a regular file' };
  return { ok: real };
}

function resolveEmoji(name: string): string {
  if (name.length <= 4 && !/^[a-z]/i.test(name)) return name;

  const emoji = EMOJI_NAMES[name.toLowerCase()];
  if (!emoji) {
    console.error(`Unknown emoji: "${name}". Known: ${Object.keys(EMOJI_NAMES).join(', ')}`);
    process.exit(1);
  }
  return emoji;
}

// --- Dry run flag ---

let DRY_RUN = false;

// --- Outbox writer ---

function writeOutbox(data: Record<string, unknown>): void {
  if (DRY_RUN) {
    console.log(`[dry-run] Would queue: ${JSON.stringify(data)}`);
    return;
  }
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const filename = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const filePath = path.join(OUTBOX_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Queued: ${filename}`);
}

// --- Commands ---

function cmdSend(args: string[]): void {
  let chatId: string | null = null;
  let attachment: string | null = null;
  let dryRun = false;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to' || args[i] === '-t') {
      chatId = args[++i];
    } else if (args[i] === '--attachment' || args[i] === '-a') {
      attachment = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else {
      remaining.push(args[i]);
    }
  }

  const text = remaining.join(' ').replace(/\\!/g, '!');

  // Attachment-only send (no text required)
  if (!text && !attachment) {
    console.error('Rejected: no message or attachment provided');
    process.exit(1);
  }

  if (text) {
    const error = validateMessage(text);
    if (error) {
      console.error(`Rejected: ${error}`);
      process.exit(1);
    }
  }

  if (attachment) {
    const result = validateAttachmentPath(attachment);
    if ('error' in result) {
      console.error(`Rejected: ${result.error}`);
      process.exit(1);
    }
    // Replace caller's path with the resolved absolute that matches what the
    // relay's assertInsideSandbox() will compute. Eliminates the mismatch where
    // CLI passed but relay rejected the same value.
    attachment = result.ok;
  }

  const target = chatId || OWNER_ID;
  if (!target) {
    console.error('Rejected: no owner_id in .credentials and no --to specified');
    process.exit(1);
  }

  if (dryRun) {
    console.log('Dry run OK:');
    console.log(`  Target: ${target}`);
    if (text) console.log(`  Text: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
    if (attachment) console.log(`  Attachment: ${attachment}`);
    return;
  }

  if (attachment) {
    writeOutbox({ chat_id: target, photo: attachment, caption: text || '' });
  } else {
    writeOutbox({ chat_id: target, text });
  }
}

function cmdReact(args: string[]): void {
  let chatId: string | null = null;
  let messageId: string | null = null;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to' || args[i] === '-t') {
      messageId = args[++i];
    } else if (args[i] === '--chat' || args[i] === '-c') {
      chatId = args[++i];
    } else {
      remaining.push(args[i]);
    }
  }

  if (remaining.length === 0) {
    console.error('Usage: react <emoji_name> --to <message_id> [--chat <chat_id>]');
    process.exit(1);
  }

  const emoji = resolveEmoji(remaining[0]);

  if (!messageId) {
    console.error('Rejected: --to <message_id> is required for reactions');
    process.exit(1);
  }

  const target = chatId || OWNER_ID;
  if (!target) {
    console.error('Rejected: no owner_id in .credentials and no --chat specified');
    process.exit(1);
  }

  writeOutbox({
    chat_id: target,
    message_id: parseInt(messageId, 10),
    reaction: emoji,
  });
}

function cmdInbox(args: string[]): void {
  const countOnly = args.includes('--count');
  const PROCESSED_DIR = path.join(INBOX_DIR, 'processed');

  let files: string[];
  try {
    files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    files = [];
  }

  if (countOnly) {
    console.log(files.length);
    return;
  }

  if (files.length === 0) {
    console.log('[]');
    return;
  }

  const messages: Record<string, unknown>[] = [];

  for (const file of files) {
    const filePath = path.join(INBOX_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      messages.push(data);

      // Auto-react eyes on operator messages only (skip reactions/receipts, skip self)
      const isOwner = data.user_id === OWNER_ID || String(data.user_id) === OWNER_ID;
      if (data.id && data.text && isOwner) {
        writeOutbox({
          chat_id: data.chat_id || OWNER_ID,
          message_id: data.id,
          reaction: '\u{1F440}',
        });
      }

      // Move to processed
      fs.mkdirSync(PROCESSED_DIR, { recursive: true });
      fs.renameSync(filePath, path.join(PROCESSED_DIR, file));
    } catch (err) {
      console.error(`[error] Could not process ${file}: ${err}`);
    }
  }

  // Output full JSON array
  console.log(JSON.stringify(messages, null, 2));
}

function cmdContacts(): void {
  console.log('Known contacts:');
  console.log(`  Owner: chat_id ${OWNER_ID}`);
  console.log(`  Self: @<your-username>`);
}

// --- Health check ---

interface HealthResult {
  ok: boolean;
  pid: number | null;
  pidAlive: boolean;
  logAge: number | null;
  issues: string[];
}

const PID_FILE = path.join(SKILL_DIR, '.relay.pid');
const RELAY_LOG = path.join(SKILL_DIR, 'relay.log');
const HEALTH_LOG_MAX_AGE = 600; // 10 minutes (GramJS is event-driven, logs less frequently)

function checkHealth(): HealthResult {
  const issues: string[] = [];
  let pid: number | null = null;
  let pidAlive = false;
  let logAge: number | null = null;

  // Check PID file
  try {
    const pidStr = fs.readFileSync(PID_FILE, 'utf-8').trim();
    pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      issues.push('PID file contains invalid value');
      pid = null;
    } else {
      try {
        process.kill(pid, 0);
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
          if (cmdline.includes('telegram-gramjs.ts')) {
            pidAlive = true;
          } else {
            issues.push(`PID ${pid} alive but not a telegram relay`);
          }
        } catch {
          issues.push(`PID ${pid} alive but cannot read cmdline`);
        }
      } catch {
        issues.push(`PID ${pid} is dead (stale PID file)`);
      }
    }
  } catch {
    issues.push('No PID file found');
  }

  // Check relay.log recency
  try {
    const stat = fs.statSync(RELAY_LOG);
    logAge = (Date.now() - stat.mtimeMs) / 1000;
    if (logAge > HEALTH_LOG_MAX_AGE) {
      issues.push(`relay.log last modified ${Math.round(logAge)}s ago (threshold: ${HEALTH_LOG_MAX_AGE}s)`);
    }
  } catch {
    issues.push('relay.log not found');
  }

  // Check outbox directory writable + stuck files
  try {
    fs.accessSync(OUTBOX_DIR, fs.constants.W_OK);
    // Check for stuck outbox files: relay polls every 1s, so any file older
    // than 5s means the relay is not consuming. No probe needed.
    const outboxFiles = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json'));
    if (outboxFiles.length > 0) {
      const now = Date.now();
      const stale = outboxFiles.filter(f => {
        const age = now - fs.statSync(path.join(OUTBOX_DIR, f)).mtimeMs;
        return age > 5000;
      });
      if (stale.length > 0) {
        const oldest = Math.max(...stale.map(f => now - fs.statSync(path.join(OUTBOX_DIR, f)).mtimeMs));
        issues.push(`${stale.length} outbox file(s) stuck (oldest: ${Math.round(oldest / 1000)}s) - relay not consuming`);
      }
    }
  } catch {
    issues.push('Outbox directory not writable');
  }

  return {
    ok: pidAlive && (logAge !== null && logAge <= HEALTH_LOG_MAX_AGE) && issues.length === 0,
    pid,
    pidAlive,
    logAge,
    issues,
  };
}

function cmdHealth(): void {
  const h = checkHealth();
  if (h.ok) {
    console.log(`OK - relay PID ${h.pid} alive, log ${Math.round(h.logAge!)}s old, outbox clear`);
  } else {
    console.log('UNHEALTHY');
    if (h.pid) console.log(`  PID: ${h.pid} (alive: ${h.pidAlive})`);
    if (h.logAge !== null) console.log(`  Log age: ${Math.round(h.logAge)}s`);
    for (const issue of h.issues) {
      console.log(`  - ${issue}`);
    }
    process.exit(1);
  }
}

// --- Main ---

const rawArgs = process.argv.slice(2);
const dryRunIdx = rawArgs.indexOf('--dry-run');
if (dryRunIdx !== -1) {
  DRY_RUN = true;
  rawArgs.splice(dryRunIdx, 1);
}
const [command, ...args] = rawArgs;

// Auto-check health before send/react (warn, don't block)
if (command === 'send' || command === 'react') {
  const h = checkHealth();
  if (!h.ok) {
    console.error(`WARNING: relay unhealthy (${h.issues.join('; ')})`);
  }
}

switch (command) {
  case 'send':
    cmdSend(args);
    break;
  case 'react':
    cmdReact(args);
    break;
  case 'health':
    cmdHealth();
    break;
  case 'inbox':
    cmdInbox(args);
    break;
  case 'contacts':
    cmdContacts();
    break;
  default:
    console.log(`Telegram CLI - agent interface to Telegram relay

Usage:
  npx tsx cli.ts send "message"                   Send DM (defaults to operator)
  npx tsx cli.ts send --to <chat_id> "message"    Send to chat
  npx tsx cli.ts react thumbsup --to <msg_id>     React to a message
  npx tsx cli.ts react eyes --to <msg_id> --chat <id>  React in other chat
  npx tsx cli.ts inbox                            Process inbox: react, move, return JSON
  npx tsx cli.ts inbox --count                    Count inbox messages (no processing)
  npx tsx cli.ts contacts                         List contacts
  npx tsx cli.ts health                           Check relay health

Emoji names: ${Object.keys(EMOJI_NAMES).join(', ')}`);
    if (command) process.exit(1);
}

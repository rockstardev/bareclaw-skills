#!/usr/bin/env bun
/**
 * One-shot import: legacy contacts.json -> contacts/<id>.md per-contact files.
 *
 * Set LEGACY_CONTACTS_PATH to an existing contacts.json (schema: a top-level
 * `contacts` array of objects with at minimum `name` + `platforms.telegram.user_id`,
 * optional `aliases`, `relationship`, `role`, `first_seen`, `group_chats.telegram`,
 * `platforms.{x,signal}.{handle,phone}`). The script writes a stub profile for
 * each Telegram contact that has a `user_id` and is not yet present under
 * `contacts/`. Does NOT overwrite existing files. Auto-index keeps `INDEX.md`
 * in sync from inbound message logs after the initial import.
 *
 * Run once on a fresh checkout to populate the contacts directory.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const CONTACTS_DIR = join(SKILL_DIR, 'contacts');
const LEGACY_PATH = process.env.LEGACY_CONTACTS_PATH || '';
if (!LEGACY_PATH) {
  console.error('import-contacts: LEGACY_CONTACTS_PATH env var required (path to legacy contacts.json)');
  process.exit(1);
}

if (!existsSync(LEGACY_PATH)) {
  console.error(`import-contacts: legacy contacts not found at ${LEGACY_PATH}`);
  process.exit(1);
}

const blob = JSON.parse(readFileSync(LEGACY_PATH, 'utf8'));
const contacts = blob.contacts || [];
let written = 0, skipped = 0, noTg = 0, rejected = 0;

// Sanitize untrusted contact field for markdown context. Three layers (security
// review MEDIUM #5 + MEDIUM #6 + rev-2 blocking #2):
//   1. Strip CR/LF + collapse whitespace runs - kills multi-line abuse and
//      bullet-list injection.
//   2. Escape markdown control chars at field level so a value like
//      `## owned` lands as literal text rather than a section heading when
//      dropped at start-of-line in the rendered profile. Backslash-escaping
//      the leading-line metacharacters (#, *, -, +, >, =, _, `, [, ], (, ),
//      <, >, |, ~, !) is portable across CommonMark/GFM and survives
//      copy-paste through other markdown renderers.
//   3. Bound length so a hostile field cannot run on indefinitely.
const MD_META = /[\\`*_{}\[\]()#+\-.!<>|~=]/g;
function safeMd(value: unknown, maxLen = 200): string {
  if (value === null || value === undefined) return '';
  // Order matters (security review rev-2 cosmetic nit): truncate the user-visible
  // content FIRST, escape the truncated slice, then append the literal ellipsis
  // marker. Truncating after escape could land the cut between `\` and the char
  // it escapes; if we escaped the appended `...` it would render as `\.\.\.`.
  const collapsed = String(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed.replace(MD_META, '\\$&');
  return collapsed.slice(0, maxLen).replace(MD_META, '\\$&') + '...';
}

for (const c of contacts) {
  const tg = c.platforms?.telegram;
  if (!tg?.user_id) { noTg++; continue; }
  const sidRaw = String(tg.user_id);

  // Path-traversal guard: user_id must match Telegram numeric id shape (optional sign + digits).
  // Rejects anything with `/`, `.`, or other path-shape chars before they hit join().
  if (!/^-?\d+$/.test(sidRaw)) {
    console.error(`import-contacts: rejected contact ${c.name || '<unnamed>'} - non-numeric user_id ${JSON.stringify(sidRaw)}`);
    rejected++;
    continue;
  }
  const sid = sidRaw;
  const path = join(CONTACTS_DIR, `${sid}.md`);
  if (existsSync(path)) { skipped++; continue; }

  // group_chats.telegram must be an array of strings; otherwise treat as empty.
  const rawGroupChats = c.group_chats?.telegram;
  const groupChatsArr = Array.isArray(rawGroupChats) ? rawGroupChats : [];
  const groupChats = groupChatsArr.length > 0
    ? groupChatsArr.map((g: unknown) => `- ${safeMd(g, 80)}`).join('\n')
    : '(none)';

  const name = safeMd(c.name, 100) || `<unnamed sender_id ${sid}>`;
  const aliases = Array.isArray(c.aliases) ? c.aliases.map((a: unknown) => safeMd(a, 60)).filter(Boolean).join(', ') : '';
  const xHandle = c.platforms?.x?.handle ? `@${safeMd(c.platforms.x.handle, 30)}` : '';
  const signalPhone = c.platforms?.signal?.phone ? safeMd(c.platforms.signal.phone, 30) : '';
  const tgChatId = safeMd(tg.chat_id || sid, 30);
  const tgDisplay = safeMd(tg.display_name || c.name, 100);
  const role = safeMd(c.role || 'contact', 30);
  const firstSeen = safeMd(c.first_seen || 'unknown', 30);
  const relationship = c.relationship ? safeMd(c.relationship, 500) : '(stub - extend on next interaction)';

  const md = `# ${name} (sender_id ${sid})

## Identity
- TG user_id: ${sid}
- TG chat_id: ${tgChatId}
- TG display_name: ${tgDisplay}
${aliases ? `- Aliases: ${aliases}\n` : ''}${signalPhone ? `- Signal: ${signalPhone}\n` : ''}${xHandle ? `- X: ${xHandle}\n` : ''}- Role: ${role}
- First seen: ${firstSeen}

## Relationship
${relationship}

## Active group chats with me
${groupChats}

## Tone
(stub - extend on next interaction)

## Recurring topics
(stub - extend on next interaction)

## Recent thread
(stub)

## Source provenance
- Identity facts migrated from legacy contacts.json on ${new Date().toISOString().slice(0, 10)}.
- Tone, recurring topics, and recent thread to be filled in from observation.
`;
  writeFileSync(path, md);
  written++;
}

console.error(`import-contacts: ${written} new profiles, ${skipped} already present, ${noTg} skipped (no TG user_id), ${rejected} rejected (invalid user_id shape)`);

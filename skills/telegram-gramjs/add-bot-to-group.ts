#!/usr/bin/env bun
// add-bot-to-group.ts - one-shot: add a bot user to a Telegram group via gramjs.
// Usage: bun add-bot-to-group.ts <group_chat_id> <bot_username>
// Example: bun add-bot-to-group.ts -1001234567890 your_bot_name

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFileSync } from 'fs';

const [chatIdRaw, botUsernameRaw] = process.argv.slice(2);
if (!chatIdRaw || !botUsernameRaw) {
  console.error('Usage: bun add-bot-to-group.ts <group_chat_id> <bot_username>');
  process.exit(1);
}
const botUsername = botUsernameRaw.replace(/^@/, '');

const creds = JSON.parse(readFileSync(`${import.meta.dir}/.credentials`, 'utf8'));
const session = new StringSession(creds.session);
const client = new TelegramClient(session, parseInt(creds.api_id, 10), creds.api_hash, { connectionRetries: 3 });
await client.connect();

// Resolve bot user
const bot: any = await client.getEntity(botUsername);
console.log(`bot resolved: id=${bot.id} username=${bot.username}`);

// Resolve group entity
const groupEntity: any = await client.getEntity(Number(chatIdRaw));
console.log(`group resolved: kind=${groupEntity.className} title=${groupEntity.title}`);

if (groupEntity.className === 'Chat') {
  // Basic group
  const r = await client.invoke(
    new Api.messages.AddChatUser({
      chatId: groupEntity.id,
      userId: bot,
      fwdLimit: 0,
    } as any),
  );
  console.log('added to basic chat OK');
} else if (groupEntity.className === 'Channel') {
  // Supergroup / channel
  await client.invoke(
    new Api.channels.InviteToChannel({
      channel: groupEntity,
      users: [bot],
    } as any),
  );
  console.log('invited to supergroup OK');
} else {
  console.error(`unsupported entity kind: ${groupEntity.className}`);
  process.exit(2);
}

await client.disconnect();
process.exit(0);

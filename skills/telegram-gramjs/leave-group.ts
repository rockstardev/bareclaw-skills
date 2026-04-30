#!/usr/bin/env bun
// leave-group.ts - one-shot: leave a Telegram group as the user account.
// Usage: bun leave-group.ts <group_chat_id>

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFileSync } from 'fs';

const [chatIdRaw] = process.argv.slice(2);
if (!chatIdRaw) { console.error('Usage: bun leave-group.ts <group_chat_id>'); process.exit(1); }

const creds = JSON.parse(readFileSync(`${import.meta.dir}/.credentials`, 'utf8'));
const session = new StringSession(creds.session);
const client = new TelegramClient(session, parseInt(creds.api_id, 10), creds.api_hash, { connectionRetries: 3 });
await client.connect();

const me: any = await client.getMe();
const groupEntity: any = await client.getEntity(Number(chatIdRaw));
console.log(`group: ${groupEntity.className} title=${groupEntity.title}`);

if (groupEntity.className === 'Chat') {
  await client.invoke(new Api.messages.DeleteChatUser({ chatId: groupEntity.id, userId: me } as any));
  console.log('left basic chat OK');
} else if (groupEntity.className === 'Channel') {
  await client.invoke(new Api.channels.LeaveChannel({ channel: groupEntity } as any));
  console.log('left supergroup OK');
} else {
  console.error(`unsupported entity kind: ${groupEntity.className}`);
  process.exit(2);
}

await client.disconnect();
process.exit(0);

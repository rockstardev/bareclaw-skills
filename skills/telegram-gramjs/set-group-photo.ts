#!/usr/bin/env bun
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { readFileSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

const [chatIdRaw, photoPath] = process.argv.slice(2);
if (!chatIdRaw || !photoPath) {
  console.error('Usage: bun set-group-photo.ts <group_chat_id> <photo_path>');
  process.exit(1);
}

const creds = JSON.parse(readFileSync(join(SKILL_DIR, '.credentials'), 'utf8'));
const session = new StringSession(creds.session);
const client = new TelegramClient(session, parseInt(creds.api_id, 10), creds.api_hash, { connectionRetries: 3 });
await client.connect();

const dialogs = await client.getDialogs({ limit: 200 });
console.log(`fetched ${dialogs.length} dialogs`);

const peer: any = await client.getEntity(Number(chatIdRaw));
console.log(`group: kind=${peer.className} title=${peer.title}`);

const stat = statSync(photoPath);
const file = new CustomFile(basename(photoPath), stat.size, photoPath);
const uploaded: any = await client.uploadFile({ file, workers: 1 });

if (peer.className === 'Channel') {
  const inputPhoto = new Api.InputChatUploadedPhoto({ file: uploaded } as any);
  const r = await client.invoke(new Api.channels.EditPhoto({ channel: peer, photo: inputPhoto } as any));
  console.log('channels.editPhoto OK');
} else if (peer.className === 'Chat') {
  const inputPhoto = new Api.InputChatUploadedPhoto({ file: uploaded } as any);
  const r = await client.invoke(new Api.messages.EditChatPhoto({ chatId: peer.id, photo: inputPhoto } as any));
  console.log('messages.editChatPhoto OK');
} else {
  console.error(`unsupported: ${peer.className}`);
  process.exit(2);
}

await client.disconnect();
process.exit(0);

#!/usr/bin/env bun
// send-poll.ts - one-shot poll sender via gramjs.
// Usage: bun send-poll.ts <chat_id> "<question>" "opt1|opt2|opt3|..."

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFileSync } from 'fs';
import bigInt from 'big-integer';

const [chatIdRaw, question, optionsRaw] = process.argv.slice(2);
if (!chatIdRaw || !question || !optionsRaw) {
  console.error('Usage: bun send-poll.ts <chat_id> "<question>" "opt1|opt2|opt3"');
  process.exit(1);
}

const creds = JSON.parse(readFileSync(`${import.meta.dir}/.credentials`, 'utf8'));
const session = new StringSession(creds.session);
const client = new TelegramClient(session, parseInt(creds.api_id, 10), creds.api_hash, { connectionRetries: 3 });
await client.connect();

const opts = optionsRaw.split('|').map(s => s.trim()).filter(Boolean);
const answers = opts.map((text, i) => new Api.PollAnswer({
  text: new Api.TextWithEntities({ text, entities: [] }),
  option: Buffer.from([i]),
}));

const poll = new Api.Poll({
  id: bigInt.zero,
  question: new Api.TextWithEntities({ text: question, entities: [] }),
  answers,
});

const peer = await client.getInputEntity(chatIdRaw.startsWith('-') || /^\d+$/.test(chatIdRaw) ? Number(chatIdRaw) : chatIdRaw);
const result = await client.invoke(new Api.messages.SendMedia({
  peer,
  media: new Api.InputMediaPoll({ poll }),
  message: '',
  randomId: bigInt(Math.floor(Math.random() * 1e15)),
}));

console.log('poll sent');
await client.disconnect();
process.exit(0);

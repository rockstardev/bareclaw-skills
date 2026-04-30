/**
 * GramJS Login for a Telegram user account
 *
 * Logs in via MTProto and saves the session string to .credentials.
 *
 * Usage:
 *   tsx skills/telegram-gramjs/gramjs-login.ts <phone_number> <api_id> <api_hash>
 *
 * Example:
 *   tsx skills/telegram-gramjs/gramjs-login.ts +1XXXXXXXXXX 12345 abc123def456
 *
 * After login, the session string is saved to .credentials under telegram.session
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.dirname(new URL(import.meta.url).pathname);
const CREDS_FILE = path.join(SKILL_DIR, '.credentials');

function waitForCodeFile(): Promise<string> {
  const codeFile = path.join(SKILL_DIR, '.auth-code');
  console.log(`[gramjs] Write the verification code to: ${codeFile}`);
  console.log(`[gramjs] Example: echo "12345" > ${codeFile}`);
  const timeout = 300_000; // 5 minutes
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (Date.now() - start > timeout) {
        clearInterval(poll);
        reject(new Error('Timed out waiting for auth code'));
        return;
      }
      try {
        if (fs.existsSync(codeFile)) {
          const code = fs.readFileSync(codeFile, 'utf-8').trim();
          if (code) {
            fs.unlinkSync(codeFile);
            clearInterval(poll);
            resolve(code);
          }
        }
      } catch {}
    }, 1000);
  });
}

async function main() {
  const phoneNumber = process.argv[2];
  const apiIdStr = process.argv[3];
  const apiHash = process.argv[4];

  if (!phoneNumber || !apiIdStr || !apiHash) {
    console.error('Usage: tsx gramjs-login.ts <phone> <api_id> <api_hash>');
    process.exit(1);
  }

  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId) || apiId <= 0) {
    console.error(`Invalid API ID: "${apiIdStr}"`);
    process.exit(1);
  }

  console.log(`[gramjs] Phone: ${phoneNumber}`);
  console.log(`[gramjs] API ID: ${apiId}`);

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: 'bareclaw-server',
    systemVersion: 'Linux',
    appVersion: '1.0.0',
  });

  console.log('[gramjs] Connecting...');

  await client.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: async () => {
      console.log('[gramjs] Verification code sent to your Telegram app.');
      return await waitForCodeFile();
    },
    password: async (hint?: string) => {
      const hintStr = hint ? ` (hint: ${hint})` : '';
      console.log(`[gramjs] 2FA is enabled${hintStr}. Write password to .auth-code file.`);
      return await waitForCodeFile();
    },
    onError: async (err: Error): Promise<boolean> => {
      const msg = (err as any).errorMessage || err.message;
      if (msg === 'PHONE_CODE_INVALID') {
        console.error('[gramjs] Invalid code - try again.');
        return false;
      }
      if (msg === 'PHONE_CODE_EXPIRED') {
        console.error('[gramjs] Code expired - requesting new one.');
        return false;
      }
      console.error(`[gramjs] Error: ${msg}`);
      return true;
    },
  });

  const sessionStr = (client.session as StringSession).save();
  if (!sessionStr) {
    console.error('[gramjs] No session string returned.');
    await client.disconnect();
    process.exit(1);
  }

  // Verify first so we can capture owner_id
  let ownerId: string | number | undefined;
  try {
    const me = await client.getMe() as any;
    const display = [me.firstName, me.lastName].filter(Boolean).join(' ');
    ownerId = typeof me.id === 'object' && me.id.toString ? me.id.toString() : me.id;
    console.log(`[gramjs] Logged in as: ${display} (ID: ${ownerId})`);
  } catch (e: any) {
    console.warn(`[gramjs] Could not verify: ${e.message}`);
  }

  // Save to .credentials (flat schema)
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
    creds.session = sessionStr;
    creds.phone = phoneNumber;
    creds.api_id = apiIdStr;
    creds.api_hash = apiHash;
    // owner_id here is the CREATOR to surface DMs from, not the authenticated account's own id.
    // Runtime (telegram-gramjs.ts) uses it in classifyAudience + DM filter. Do not overwrite with getMe() id.
    if (creds.self_id === undefined && ownerId !== undefined) creds.self_id = Number(ownerId);
    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
    console.log(`[gramjs] Session saved to ${CREDS_FILE}`);
  } catch (e: any) {
    console.error(`[gramjs] Could not update .credentials: ${e.message}`);
    console.log(`[gramjs] Session string (save manually):\n${sessionStr}`);
  }

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[gramjs] Fatal:', err.message || err);
  process.exit(1);
});

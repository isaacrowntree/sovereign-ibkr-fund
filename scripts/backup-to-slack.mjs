#!/usr/bin/env node
/**
 * Off-SD-card backup of the fund's SQLite ledger to Slack.
 *
 * Runs in the paperclip container (has node 24 with node:sqlite). Takes a
 * consistent snapshot via `VACUUM INTO` (safe with WAL, no writer pause) and
 * uploads it to the Slack channel via the files API. Scheduled by a host
 * systemd timer that invokes it with `docker exec`.
 *
 * Env:
 *   IBKR_FUND_SLACK_BOT_TOKEN        xoxb- token with files:write
 *   IBKR_FUND_BACKUP_SLACK_CHANNEL   channel id (C0...)
 *   STATE_DIR                        dir holding bot-state.db (default cwd)
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN = process.env.IBKR_FUND_SLACK_BOT_TOKEN;
const CHANNEL = process.env.IBKR_FUND_BACKUP_SLACK_CHANNEL;
const STATE_DIR = process.env.STATE_DIR || '.';
const DB = resolve(STATE_DIR, 'bot-state.db');
const SNAP = resolve('/tmp', `bot-state-backup-${process.pid}.db`);

function die(msg) { console.error('[backup]', msg); process.exit(1); }
if (!TOKEN) die('IBKR_FUND_SLACK_BOT_TOKEN unset');
if (!CHANNEL) die('IBKR_FUND_BACKUP_SLACK_CHANNEL unset');

// 1. Consistent snapshot (VACUUM INTO works with WAL and doesn't block writers).
const db = new DatabaseSync(DB, { readOnly: true });
db.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
db.close();

const bytes = statSync(SNAP).size;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const filename = `bot-state-${stamp}.db`;

async function slack(method, body, headers) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    body,
  });
  return res.json();
}

try {
  // 2. Reserve upload URL.
  const up = await slack(`files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${bytes}`, undefined, {});
  if (!up.ok) die(`getUploadURLExternal: ${up.error}`);

  // 3. PUT the bytes.
  const put = await fetch(up.upload_url, { method: 'POST', body: readFileSync(SNAP) });
  if (!put.ok) die(`upload PUT http ${put.status}`);

  // 4. Complete + share to channel.
  const done = await slack('files.completeUploadExternal',
    JSON.stringify({
      files: [{ id: up.file_id, title: filename }],
      channel_id: CHANNEL,
      initial_comment: `🔒 IBKR fund ledger backup — ${(bytes / 1024).toFixed(0)} KB, ${new Date().toISOString()}`,
    }),
    { 'Content-Type': 'application/json' });
  if (!done.ok) die(`completeUploadExternal: ${done.error}`);

  console.log(`[backup] uploaded ${filename} (${bytes} bytes) to Slack`);
} finally {
  try { rmSync(SNAP); } catch {}
}

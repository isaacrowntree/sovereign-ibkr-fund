#!/usr/bin/env node
/**
 * Agent health alerter — the thing whose absence let 5 months of failure pass unseen.
 *
 * The 2026-03..2026-08 outage was invisible because agent failures are recorded in
 * paperclip's Postgres (`heartbeat_runs`), NOT in `docker logs`. The container log
 * only ever says "heartbeat timer tick enqueued runs"; the watchdog only probes
 * bezant's /health and reported healthy throughout; the digest reads the fund's
 * SQLite. Nothing looked at the system of record. This does.
 *
 * Two independent alarms, because they fail differently:
 *   FAILING  — runs happened and failed.
 *   SILENT   — no runs at all. A dead scheduler produces zero failures, so a
 *              failure-only check stays quiet through the worst outage.
 *
 * WHERE THIS REPORTS. It used to post to Slack on every change to the set of
 * unhealthy agents, which on a bad night meant five messages saying much the
 * same thing — and not one of them was actionable at the hour it arrived. So
 * it now writes two things and posts nothing:
 *
 *   agent-health.json   the CURRENT picture, which is what you actually want:
 *                       who is failing right now, not who was failing at 01:07.
 *                       Rendered as a table on pi.lan/ops.
 *   ops-feed.jsonl      one line when the set CHANGES, so the history of a
 *                       flapping agent is still readable.
 *
 * The dedupe below therefore no longer gates whether you are interrupted — it
 * gates whether an event is worth a line in the log. Both files are written
 * every run regardless.
 *
 * ONE THING DOES PUSH: the fund not trading. On an NYSE trading day, no
 * successful Portfolio Strategist run in 24h or Execution Bot run in 48h goes
 * to Slack, once per New York day. Every agent can be "healthy" by the tests
 * above while that pair has stopped completing, and a fund that has quietly
 * stopped trading is the one state nobody discovers from a page they do not
 * open.
 *
 * The fund is counted apart from the other paperclip companies on the same
 * instance (the crypto SwingTrader), which appear under `others`.
 *
 * Env:
 *   PAPERCLIP_DATABASE_URL     postgres URL for the paperclip schema
 *   AGENT_HEALTH_STATE_DIR     where the status file and feed live
 *                              (default /fund-state/state)
 *   AGENT_HEALTH_SILENT_FACTOR multiple of an agent's own interval before it is
 *                              considered silent (default 2)
 *   AGENT_HEALTH_FUND_COMPANY  paperclip company that IS the fund (default "IBKR Fund")
 *   AGENT_HEALTH_TRADING_PUSH  0 = no "fund isn't trading" push (default 1)
 *   AGENT_HEALTH_STRATEGIST / AGENT_HEALTH_EXECUTOR   agent names
 *                              (default "Portfolio Strategist" / "Execution Bot")
 *   AGENT_HEALTH_STRATEGIST_MAX_H / AGENT_HEALTH_EXECUTOR_MAX_H  (24 / 48)
 *   IBKR_FUND_ALERT_WEBHOOK    where the push goes; unset = feed line only
 *   AGENT_HEALTH_DRY_RUN=1     print, write nothing
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { globSync } from 'node:fs';
import { summariseStderr } from './stderr.mjs';
import { splitByCompany, etDate, readCalendar, tradingStall, pushDue } from './verdict.mjs';
import { postWebhook } from '../lib/webhook.mjs';

const DB = process.env.PAPERCLIP_DATABASE_URL;
const STATE_DIR = process.env.AGENT_HEALTH_STATE_DIR || '/fund-state/state';
const FACTOR = Number(process.env.AGENT_HEALTH_SILENT_FACTOR || 2);
const DRY = process.env.AGENT_HEALTH_DRY_RUN === '1';
const FUND_COMPANY = process.env.AGENT_HEALTH_FUND_COMPANY || 'IBKR Fund';
const TRADING_PUSH = process.env.AGENT_HEALTH_TRADING_PUSH !== '0';
const STRATEGIST = process.env.AGENT_HEALTH_STRATEGIST || 'Portfolio Strategist';
const EXECUTOR = process.env.AGENT_HEALTH_EXECUTOR || 'Execution Bot';
const STALL_LIMITS = {
  [STRATEGIST]: Number(process.env.AGENT_HEALTH_STRATEGIST_MAX_H || 24) * 3600,
  [EXECUTOR]: Number(process.env.AGENT_HEALTH_EXECUTOR_MAX_H || 48) * 3600,
};
const WEBHOOK = process.env.IBKR_FUND_ALERT_WEBHOOK;
// Shipped with the fund (src/ is rsynced by deploy-to-pi.sh), resolved from
// this file so the working directory does not matter.
const CALENDAR_URL = new URL('../../src/strategy/nyse-calendar.json', import.meta.url);

const die = (m) => { console.error(`[agent-health] FATAL: ${m}`); process.exit(1); };
if (!DB) die('PAPERCLIP_DATABASE_URL unset');

/**
 * The ops feed, in longhand — see deploy/lib/ops-feed.ts for the contract.
 * Copied rather than imported on purpose: this file runs as bare `node` inside
 * the paperclip container, with no tsx and no build step, so it cannot import
 * the TypeScript one. Fifteen duplicated lines is a better trade than a build
 * step on the one script whose job is to notice when other things stop running.
 */
function feed(ev) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, 'ops-feed.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), source: 'agents', ...ev }) + '\n');
  } catch { /* never worth failing the check over */ }
}

// paperclip's own `postgres` driver. Resolved by glob rather than a pinned path so
// a pnpm version bump inside the container does not silently break the alerter —
// which would reintroduce exactly the blind spot this script exists to close.
function loadPostgres() {
  const require = createRequire(import.meta.url);
  for (const p of ['postgres', ...globSync('/app/node_modules/.pnpm/postgres@*/node_modules/postgres')]) {
    try { return require(p); } catch { /* keep looking */ }
  }
  die('could not resolve the `postgres` driver (looked in /app/node_modules/.pnpm)');
}

const sql = loadPostgres()(DB, { max: 1, idle_timeout: 5, connect_timeout: 10 });

// Only agents paperclip would actually invoke. `paused`/`terminated` are
// deliberate states (CEO and Risk Monitor are intentionally paused) and must not
// alarm. Note `error` IS invokable in paperclip, so it is included.
const INVOKABLE = ['active', 'idle', 'running', 'error'];

/**
 * Seconds since the fund's strategist and executor last SUCCEEDED, whatever
 * their status — a paused Execution Bot is still a fund that is not trading.
 */
async function checkTradingStall() {
  if (!TRADING_PUSH) return null;
  let calendar = null;
  try {
    calendar = readCalendar(JSON.parse(readFileSync(CALENDAR_URL, 'utf8')));
  } catch (err) {
    console.error(`[agent-health] NYSE calendar unreadable (${err?.message || err}) — assuming weekdays trade`);
  }
  const names = Object.keys(STALL_LIMITS);
  const found = await sql`
    select a.name,
           extract(epoch from (now() - max(r.started_at))) as age_sec
      from agents a
      join companies c on c.id = a.company_id
      left join heartbeat_runs r on r.agent_id = a.id and r.status = 'succeeded'
     where c.name = ${FUND_COMPANY} and a.name = any(${names})
     group by a.name`;
  const lastOk = Object.fromEntries(names.map(n => [n, null]));
  for (const f of found) lastOk[f.name] = f.age_sec === null ? null : Number(f.age_sec);
  return tradingStall({ date: etDate(new Date()), calendar, lastOk, limits: STALL_LIMITS });
}

/** Push a stall once per New York day; the feed gets the same line. */
async function pushStall(stall) {
  if (!stall) return;
  const pushPath = join(STATE_DIR, 'agent-health-push.json');
  let prev = null;
  try { prev = JSON.parse(readFileSync(pushPath, 'utf8')); } catch { /* never pushed */ }
  const date = etDate(new Date());
  if (!pushDue(prev, date)) {
    console.log(`[agent-health] fund not trading (${stall.key}) — already pushed for ${date}`);
    return;
  }
  // One feed line per day; a push that failed is retried hourly without another.
  if (prev?.date !== date) feed({ severity: 'critical', title: stall.title, detail: stall.detail });
  const sent = await postWebhook(WEBHOOK, { text: `:rotating_light: *${stall.title}*\n${stall.detail}` },
    { log: (m) => console.error(`[agent-health] ${m}`) });
  try {
    writeFileSync(pushPath, JSON.stringify({ date, key: stall.key, pushed: sent || !WEBHOOK, at: new Date().toISOString() }));
  } catch { /* the worst case is one more push tomorrow-equivalent */ }
  console.log(`[agent-health] fund not trading (${stall.key}) — ${sent ? 'pushed' : WEBHOOK ? 'push FAILED, will retry' : 'no webhook, feed only'}`);
}

try {
  const agents = await sql`
    select a.id, a.name, a.status, c.name as company,
           coalesce((a.runtime_config->'heartbeat'->>'intervalSec')::int, 14400) as interval_sec,
           (a.runtime_config->'heartbeat'->>'enabled')::boolean as hb_enabled
      from agents a
      left join companies c on c.id = a.company_id
     where a.status = any(${INVOKABLE})
     order by a.name`;

  const rows = [];
  for (const a of agents) {
    if (a.hb_enabled === false) continue;
    const [last] = await sql`
      select status, error_code, stderr_excerpt, started_at,
             extract(epoch from (now() - started_at)) as age_sec
        from heartbeat_runs
       where agent_id = ${a.id} and started_at is not null
       order by started_at desc limit 1`;
    const [recent] = await sql`
      select count(*) filter (where status = 'failed')    as failed,
             count(*) filter (where status = 'succeeded') as ok
        from heartbeat_runs
       where agent_id = ${a.id}
         and started_at > now() - make_interval(secs => ${a.interval_sec * FACTOR})`;
    rows.push({
      name: a.name,
      company: a.company ?? null,
      intervalSec: a.interval_sec,
      lastStatus: last?.status ?? null,
      lastErr: last?.error_code ?? null,
      // Only a failed run's stderr explains anything; a healthy run's can
      // still carry warnings that would read as a cause.
      lastMsg: last?.status === 'failed' ? summariseStderr(last.stderr_excerpt) : null,
      ageSec: last ? Number(last.age_sec) : null,
      failed: Number(recent?.failed ?? 0),
      ok: Number(recent?.ok ?? 0),
    });
  }

  const isSilent = (r) => r.ageSec === null || r.ageSec > r.intervalSec * FACTOR;
  const isFailing = (r) => !isSilent(r) && r.lastStatus === 'failed';
  const split = splitByCompany(rows, FUND_COMPANY);
  const silent = split.fund.filter(isSilent);
  const failing = split.fund.filter(isFailing);
  const otherSilent = split.others.filter(isSilent);
  const otherFailing = split.others.filter(isFailing);

  const hrs = (s) => s === null ? 'never' : `${(s / 3600).toFixed(1)}h ago`;

  // Shaped for the page that renders it, not for a chat message: the hub shows
  // a table, so the reasons are pre-worded here rather than parsed back out of
  // a bullet list on the other side.
  const detail = (r, why) => ({
    name: r.name,
    company: r.company,
    reason: why,
    lastErr: r.lastErr,
    lastMsg: r.lastMsg,
    ago: hrs(r.ageSec),
    ok: r.ok,
    failed: r.failed,
    intervalHours: Number((r.intervalSec / 3600).toFixed(1)),
  });
  const failingOut = failing.map(r => detail(r, 'last run failed'));
  const silentOut = silent.map(r => detail(r, `no run in >${FACTOR}× its interval`));
  const otherFailingOut = otherFailing.map(r => detail(r, 'last run failed'));
  const otherSilentOut = otherSilent.map(r => detail(r, `no run in >${FACTOR}× its interval`));

  // Dedupe on the SET of unhealthy agents, not on time: record an event when
  // the set changes (something broke or recovered), stay quiet while it is
  // unchanged. The status file below is rewritten either way — a page must
  // show what is true now, not what was true when it last changed.
  const key = JSON.stringify({
    failing: failing.map(r => r.name).sort(),
    silent: silent.map(r => r.name).sort(),
    ...(otherFailing.length || otherSilent.length ? {
      others: [...otherFailing, ...otherSilent].map(r => `${r.company}/${r.name}`).sort(),
    } : {}),
  });
  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, 'agent-health.json');
  let prev = null;
  try { prev = JSON.parse(readFileSync(statePath, 'utf8')).key; } catch { /* first run */ }

  // `healthy`, `total`, `failing` and `silent` describe THE FUND only. Other
  // companies' agents are reported under `others`, so a failing SwingTrader
  // no longer reads as a fund agent down (or pads the fund's total).
  const healthy = !failing.length && !silent.length;
  const status = {
    at: new Date().toISOString(),
    key,
    healthy,
    company: FUND_COMPANY,
    total: split.fund.length,
    failing: failingOut,
    silent: silentOut,
    others: {
      healthy: !otherFailing.length && !otherSilent.length,
      total: split.others.length,
      failing: otherFailingOut,
      silent: otherSilentOut,
    },
  };

  const stall = await checkTradingStall();

  if (DRY) {
    console.log('[agent-health] DRY RUN, would write:\n' + JSON.stringify({ ...status, stall }, null, 2));
    await sql.end(); process.exit(0);
  }

  writeFileSync(statePath, JSON.stringify(status));
  await pushStall(stall);

  if (key === prev) {
    console.log(`[agent-health] unchanged (${failing.length} failing, ${silent.length} silent) — status refreshed, no event`);
    await sql.end(); process.exit(0);
  }

  const line = (r) => `${r.name} — ${r.reason}${r.lastErr ? ` (${r.lastErr})` : ''}${r.lastMsg ? `: ${r.lastMsg}` : ''}, ${r.ago}`;
  const otherBad = [...otherFailingOut, ...otherSilentOut];
  if (healthy) {
    // First run on a healthy fund is not a recovery, it is a baseline.
    if (prev !== null) {
      feed({ severity: 'recovery', title: `All ${split.fund.length} invokable fund agents healthy again` });
    }
  } else {
    const bad = [...failingOut, ...silentOut];
    feed({
      severity: 'critical',
      title: `${bad.length} of ${split.fund.length} fund agents unhealthy`,
      detail: bad.map(line).join('; '),
    });
  }
  if (otherBad.length) {
    // Not the fund, so not critical — but still a change worth a line.
    feed({
      severity: 'warn',
      title: `${otherBad.length} of ${split.others.length} other agents unhealthy`,
      detail: otherBad.map(r => `${r.company ?? '?'}: ${line(r)}`).join('; '),
    });
  }
  console.log(`[agent-health] ${failing.length} failing, ${silent.length} silent — status written, event recorded`);
  await sql.end();
} catch (err) {
  console.error('[agent-health] ERROR:', err?.message || err);
  try { await sql.end(); } catch { /* ignore */ }
  process.exit(1);
}

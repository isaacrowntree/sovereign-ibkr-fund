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
 * Env:
 *   PAPERCLIP_DATABASE_URL     postgres URL for the paperclip schema
 *   AGENT_HEALTH_STATE_DIR     where the status file and feed live
 *                              (default /fund-state/state)
 *   AGENT_HEALTH_SILENT_FACTOR multiple of an agent's own interval before it is
 *                              considered silent (default 2)
 *   AGENT_HEALTH_DRY_RUN=1     print, write nothing
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { globSync } from 'node:fs';

const DB = process.env.PAPERCLIP_DATABASE_URL;
const STATE_DIR = process.env.AGENT_HEALTH_STATE_DIR || '/fund-state/state';
const FACTOR = Number(process.env.AGENT_HEALTH_SILENT_FACTOR || 2);
const DRY = process.env.AGENT_HEALTH_DRY_RUN === '1';

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

try {
  const agents = await sql`
    select a.id, a.name, a.status,
           coalesce((a.runtime_config->'heartbeat'->>'intervalSec')::int, 14400) as interval_sec,
           (a.runtime_config->'heartbeat'->>'enabled')::boolean as hb_enabled
      from paperclip.agents a
     where a.status = any(${INVOKABLE})
     order by a.name`;

  const rows = [];
  for (const a of agents) {
    if (a.hb_enabled === false) continue;
    const [last] = await sql`
      select status, error_code, started_at,
             extract(epoch from (now() - started_at)) as age_sec
        from paperclip.heartbeat_runs
       where agent_id = ${a.id} and started_at is not null
       order by started_at desc limit 1`;
    const [recent] = await sql`
      select count(*) filter (where status = 'failed')    as failed,
             count(*) filter (where status = 'succeeded') as ok
        from paperclip.heartbeat_runs
       where agent_id = ${a.id}
         and started_at > now() - make_interval(secs => ${a.interval_sec * FACTOR})`;
    rows.push({
      name: a.name,
      intervalSec: a.interval_sec,
      lastStatus: last?.status ?? null,
      lastErr: last?.error_code ?? null,
      ageSec: last ? Number(last.age_sec) : null,
      failed: Number(recent?.failed ?? 0),
      ok: Number(recent?.ok ?? 0),
    });
  }

  const silent = rows.filter(r => r.ageSec === null || r.ageSec > r.intervalSec * FACTOR);
  const failing = rows.filter(r => !silent.includes(r) && r.lastStatus === 'failed');

  const hrs = (s) => s === null ? 'never' : `${(s / 3600).toFixed(1)}h ago`;

  // Shaped for the page that renders it, not for a chat message: the hub shows
  // a table, so the reasons are pre-worded here rather than parsed back out of
  // a bullet list on the other side.
  const detail = (r, why) => ({
    name: r.name,
    reason: why,
    lastErr: r.lastErr,
    ago: hrs(r.ageSec),
    ok: r.ok,
    failed: r.failed,
    intervalHours: Number((r.intervalSec / 3600).toFixed(1)),
  });
  const failingOut = failing.map(r => detail(r, 'last run failed'));
  const silentOut = silent.map(r => detail(r, `no run in >${FACTOR}× its interval`));

  // Dedupe on the SET of unhealthy agents, not on time: record an event when
  // the set changes (something broke or recovered), stay quiet while it is
  // unchanged. The status file below is rewritten either way — a page must
  // show what is true now, not what was true when it last changed.
  const key = JSON.stringify({
    failing: failing.map(r => r.name).sort(),
    silent: silent.map(r => r.name).sort(),
  });
  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, 'agent-health.json');
  let prev = null;
  try { prev = JSON.parse(readFileSync(statePath, 'utf8')).key; } catch { /* first run */ }

  const healthy = !failing.length && !silent.length;
  const status = {
    at: new Date().toISOString(),
    key,
    healthy,
    total: rows.length,
    failing: failingOut,
    silent: silentOut,
  };

  if (DRY) {
    console.log('[agent-health] DRY RUN, would write:\n' + JSON.stringify(status, null, 2));
    await sql.end(); process.exit(0);
  }

  writeFileSync(statePath, JSON.stringify(status));

  if (key === prev) {
    console.log(`[agent-health] unchanged (${failing.length} failing, ${silent.length} silent) — status refreshed, no event`);
    await sql.end(); process.exit(0);
  }

  if (healthy) {
    // First run on a healthy fund is not a recovery, it is a baseline.
    if (prev !== null) {
      feed({ severity: 'recovery', title: `All ${rows.length} invokable agents healthy again` });
    }
  } else {
    const bad = [...failingOut, ...silentOut];
    feed({
      severity: 'critical',
      title: `${bad.length} of ${rows.length} agents unhealthy`,
      detail: bad.map(r => `${r.name} — ${r.reason}${r.lastErr ? ` (${r.lastErr})` : ''}, ${r.ago}`).join('; '),
    });
  }
  console.log(`[agent-health] ${failing.length} failing, ${silent.length} silent — status written, event recorded`);
  await sql.end();
} catch (err) {
  console.error('[agent-health] ERROR:', err?.message || err);
  try { await sql.end(); } catch { /* ignore */ }
  process.exit(1);
}

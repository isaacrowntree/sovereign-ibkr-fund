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
 * Env:
 *   PAPERCLIP_DATABASE_URL     postgres URL for the paperclip schema
 *   IBKR_FUND_ALERT_WEBHOOK    Slack incoming webhook
 *   AGENT_HEALTH_STATE_DIR     where to keep dedupe state (default /fund-state/state)
 *   AGENT_HEALTH_SILENT_FACTOR multiple of an agent's own interval before it is
 *                              considered silent (default 2)
 *   AGENT_HEALTH_DRY_RUN=1     print, do not post
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { globSync } from 'node:fs';

const DB = process.env.PAPERCLIP_DATABASE_URL;
const HOOK = process.env.IBKR_FUND_ALERT_WEBHOOK;
const STATE_DIR = process.env.AGENT_HEALTH_STATE_DIR || '/fund-state/state';
const FACTOR = Number(process.env.AGENT_HEALTH_SILENT_FACTOR || 2);
const DRY = process.env.AGENT_HEALTH_DRY_RUN === '1';

const die = (m) => { console.error(`[agent-health] FATAL: ${m}`); process.exit(1); };
if (!DB) die('PAPERCLIP_DATABASE_URL unset');
if (!HOOK && !DRY) die('IBKR_FUND_ALERT_WEBHOOK unset');

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
  const lines = [];
  if (failing.length) {
    lines.push(`*${failing.length} agent(s) failing*`);
    for (const r of failing) {
      lines.push(`• \`${r.name}\` — last run failed${r.lastErr ? ` (${r.lastErr})` : ''}, ${hrs(r.ageSec)} · ${r.ok}✓/${r.failed}✗ recently`);
    }
  }
  if (silent.length) {
    lines.push(`*${silent.length} agent(s) silent* (no run in >${FACTOR}× their interval)`);
    for (const r of silent) {
      lines.push(`• \`${r.name}\` — last run ${hrs(r.ageSec)}, expected every ${(r.intervalSec / 3600).toFixed(0)}h`);
    }
  }

  // Dedupe on the SET of unhealthy agents, not on time: re-alert when the set
  // changes (something broke or recovered), stay quiet while it is unchanged.
  const key = JSON.stringify({
    failing: failing.map(r => r.name).sort(),
    silent: silent.map(r => r.name).sort(),
  });
  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, 'agent-health.json');
  let prev = null;
  try { prev = JSON.parse(readFileSync(statePath, 'utf8')).key; } catch { /* first run */ }

  const healthy = !failing.length && !silent.length;
  if (healthy) {
    if (prev && prev !== '{"failing":[],"silent":[]}') {
      lines.push(`*Recovered* — all ${rows.length} invokable agents healthy again`);
    } else {
      console.log(`[agent-health] OK — ${rows.length} agents healthy, nothing to report`);
      writeFileSync(statePath, JSON.stringify({ key, at: new Date().toISOString() }));
      await sql.end(); process.exit(0);
    }
  } else if (key === prev) {
    console.log(`[agent-health] unchanged (${failing.length} failing, ${silent.length} silent) — not re-alerting`);
    await sql.end(); process.exit(0);
  }

  const text = `:rotating_light: *IBKR fund — agent health*\n${lines.join('\n')}`;
  if (DRY) {
    console.log('[agent-health] DRY RUN, would post:\n' + text);
  } else {
    const res = await fetch(HOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) die(`webhook rejected: ${res.status} ${await res.text().catch(() => '')}`);
    console.log(`[agent-health] alerted: ${failing.length} failing, ${silent.length} silent`);
  }
  writeFileSync(statePath, JSON.stringify({ key, at: new Date().toISOString() }));
  await sql.end();
} catch (err) {
  console.error('[agent-health] ERROR:', err?.message || err);
  try { await sql.end(); } catch { /* ignore */ }
  process.exit(1);
}

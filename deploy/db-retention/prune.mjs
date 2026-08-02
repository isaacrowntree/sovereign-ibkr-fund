#!/usr/bin/env node
/**
 * paperclip DB retention.
 *
 * `heartbeat_runs` is the schema's largest table (18 MB of ~50 MB) and grows
 * forever: every run stores stdout/stderr excerpts, a context snapshot, and
 * result/usage JSON. That matters more than usual here because paperclip shares
 * a 500 MB free-tier Supabase database with another app — paperclip filling the
 * quota would fail writes for BOTH.
 *
 * It REDACTS blob columns on old runs rather than deleting rows. 26 foreign keys
 * point at heartbeat_runs (many ON DELETE NO ACTION), so deleting would either
 * be blocked or cascade into unrelated history. Redaction keeps every row — and
 * therefore every FK, plus status/error_code/timings, which is what you actually
 * need months later — while reclaiming the space.
 *
 * Env:
 *   PAPERCLIP_DATABASE_URL
 *   RETENTION_DAYS   keep blobs this long (default 90)
 *   RETENTION_DRY_RUN=1
 */
import { createRequire } from 'node:module';
import { globSync } from 'node:fs';

const DB = process.env.PAPERCLIP_DATABASE_URL;
const DAYS = Number(process.env.RETENTION_DAYS || 90);
const DRY = process.env.RETENTION_DRY_RUN === '1';
if (!DB) { console.error('[retention] FATAL: PAPERCLIP_DATABASE_URL unset'); process.exit(1); }
if (!Number.isFinite(DAYS) || DAYS < 7) { console.error('[retention] FATAL: RETENTION_DAYS must be >= 7'); process.exit(1); }

function loadPostgres() {
  const require = createRequire(import.meta.url);
  for (const p of ['postgres', ...globSync('/app/node_modules/.pnpm/postgres@*/node_modules/postgres')]) {
    try { return require(p); } catch { /* keep looking */ }
  }
  console.error('[retention] FATAL: could not resolve the `postgres` driver');
  process.exit(1);
}

const sql = loadPostgres()(DB, { max: 1, idle_timeout: 5, connect_timeout: 10 });

try {
  const [before] = await sql`
    select count(*)::int as n,
           pg_size_pretty(pg_total_relation_size('paperclip.heartbeat_runs')) as size
      from paperclip.heartbeat_runs
     where started_at < now() - make_interval(days => ${DAYS})
       and (stdout_excerpt is not null or stderr_excerpt is not null
            or context_snapshot is not null or result_json is not null or usage_json is not null)`;

  console.log(`[retention] ${before.n} run(s) older than ${DAYS}d still carry blobs (table now ${before.size})`);
  if (DRY) { console.log('[retention] DRY RUN — no changes'); await sql.end(); process.exit(0); }
  if (before.n === 0) { console.log('[retention] nothing to do'); await sql.end(); process.exit(0); }

  // Batched so a long transaction never holds locks on a shared instance.
  let total = 0;
  for (;;) {
    const rows = await sql`
      with victims as (
        select id from paperclip.heartbeat_runs
         where started_at < now() - make_interval(days => ${DAYS})
           and (stdout_excerpt is not null or stderr_excerpt is not null
                or context_snapshot is not null or result_json is not null or usage_json is not null)
         limit 500
      )
      update paperclip.heartbeat_runs r
         set stdout_excerpt = null, stderr_excerpt = null,
             context_snapshot = null, result_json = null, usage_json = null
        from victims v where r.id = v.id
      returning r.id`;
    if (rows.length === 0) break;
    total += rows.length;
  }
  console.log(`[retention] redacted blobs on ${total} run(s)`);

  const [after] = await sql`select pg_size_pretty(pg_total_relation_size('paperclip.heartbeat_runs')) as size`;
  console.log(`[retention] heartbeat_runs now ${after.size} (VACUUM reclaims to disk lazily)`);
  await sql.end();
} catch (err) {
  console.error('[retention] ERROR:', err?.message || err);
  try { await sql.end(); } catch { /* ignore */ }
  process.exit(1);
}

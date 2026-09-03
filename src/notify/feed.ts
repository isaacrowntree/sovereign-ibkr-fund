/**
 * The ops feed — the fund's half of what replaced the Slack channel.
 *
 * Every notify() event is appended here, whether or not it also went to Slack.
 * That is the point: Slack now carries only what needs a thumb in the next two
 * minutes, and the record of everything else has to live somewhere you can go
 * and read it. That somewhere is `pi.lan/ops`, which tails this file.
 *
 * One JSON object per line — the same contract deploy/lib/ops-feed.ts writes,
 * so the hub has one parser and not four:
 *
 *   {"at": ISO8601, "source": string, "severity": Severity,
 *    "title": string, "detail"?: string}
 *
 * Best-effort and silent by construction. This module sits on the same path as
 * the drawdown hard-stop alert; a full disk or a missing mount must cost a log
 * line, never a trading run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import type { NotifyEvent } from './blocks.js';

/**
 * Not derived from STATE_DIR even though they are usually the same directory.
 * STATE_DIR is per-agent and has been wrong before — an agent that inherited
 * the default wrote its ledger into its cwd for eight days. The feed must not
 * be able to scatter the same way, so it takes one explicit path or the
 * container's known mount.
 */
const EXPLICIT_DIR = process.env.PI_OPS_DIR;
const DIR = EXPLICIT_DIR ?? '/fund-state/state';
const FILE = path.join(DIR, 'ops-feed.jsonl');
const MAX_BYTES = 256 * 1024;
const TRIM_KEEP = 400;

/** Append one event to the ops feed. Never throws. */
export function feed(event: NotifyEvent): void {
  try {
    // The default path is a MOUNT, not a directory to conjure. Creating it when
    // the volume is missing would write the feed into the container's throwaway
    // layer, where it grows unbounded and is read by nobody — and would have
    // every unit test on a laptop trying to mkdir /fund-state. An explicit
    // PI_OPS_DIR is a deliberate choice, so that one we do create.
    if (EXPLICIT_DIR) fs.mkdirSync(DIR, { recursive: true });
    else if (!fs.existsSync(DIR)) return;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      source: event.agent ?? 'fund',
      severity: event.severity,
      title: event.title,
      // The Block Kit fields carry most of a digest's substance, so flatten
      // them in rather than shipping a title with nothing under it.
      detail: [event.body, ...(event.fields ?? []).map((f) => `${f.label}: ${f.value}`)]
        .filter(Boolean)
        .join(' · ') || undefined,
    });
    fs.appendFileSync(FILE, line + '\n');
    trim();
  } catch (err) {
    log(`(ops feed write failed: ${(err as Error).message})`, 'Alert');
  }
}

function trim(): void {
  try {
    if (fs.statSync(FILE).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-TRIM_KEEP).join('\n') + '\n');
    fs.renameSync(tmp, FILE);
  } catch {
    /* a feed that cannot be trimmed is still a feed */
  }
}

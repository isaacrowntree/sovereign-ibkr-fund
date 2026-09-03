/**
 * Slack rendering — PURE. No I/O, no env, no clock.
 *
 * Everything time- or config-dependent arrives via `RenderMeta`, so tests need
 * neither fake timers nor env stubbing.
 *
 * Payload shape is `{ text, attachments: [{ color, fallback, blocks }] }`:
 *
 *  - `blocks` live INSIDE the attachment, because `color` has no Block Kit
 *    equivalent and the colour bar is the only pre-attentive signal we get —
 *    it's what makes a hard stop distinguishable from a fill while scrolling a
 *    single channel, before reading a word.
 *  - `text` stays top-level: it preserves the documented `{ text }` contract
 *    this webhook has always spoken, drives the notification/fallback line, and
 *    is what a non-Slack endpoint renders.
 *  - There is NO header block. Slack only suppresses top-level `text` when
 *    top-level `blocks` is present; with blocks nested in an attachment the
 *    `text` renders as the message body, so a header would print the title
 *    twice. `text` IS the headline.
 *
 * The renderer self-enforces every Slack limit below. Slack rejects the WHOLE
 * payload on any violation, so a limit breach here would take out the alert it
 * was rendering.
 */

export type Severity = 'info' | 'warn' | 'critical' | 'recovery';

export interface NotifyField {
  label: string;
  value: string;
}

export interface NotifyEvent {
  severity: Severity;
  /** One-line summary. Also the notification/fallback text. Required. */
  title: string;
  /** Optional prose paragraph (mrkdwn). */
  body?: string;
  /** Rendered two-up. */
  fields?: NotifyField[];
  /** Emitting agent, e.g. 'risk-manager'. Rendered into the context footer. */
  agent?: string;
  /** Dedupe policy. Omit to always send. */
  dedupe?: { key: string; fingerprint?: string; ttlMs?: number };
  /**
   * Where this event is allowed to interrupt.
   *
   * Every event is recorded on the ops feed and shows up at pi.lan/ops. This
   * says whether it ALSO buzzes a phone. Default 'slack' — the events that
   * predate this field are fills, hard stops and reconcile breaks, and those
   * are exactly what a notification is for. Set 'ops' for the ones that are
   * only ever read after the fact: the daily digest is state, not news, and it
   * is already on the page in a form a chat message cannot match.
   *
   * Rendering ignores this entirely; it is a routing decision, and blocks.ts
   * stays pure.
   */
  channel?: 'slack' | 'ops';
}

export interface RenderMeta {
  /** TRADING_MODE — 'paper' | 'live'. */
  mode: string;
  /** ISO timestamp. */
  at: string;
}

export interface SlackAttachment {
  color: string;
  fallback: string;
  blocks: unknown[];
}

export interface SlackPayload {
  text: string;
  attachments: SlackAttachment[];
}

// Slack's documented limits.
const MAX_SECTION_TEXT = 3000;
const MAX_FIELD_TEXT = 2000; // per field — NOT 3000
const MAX_FIELDS_PER_SECTION = 10;
const MAX_CONTEXT_ELEMENTS = 10;
const MAX_BLOCKS = 50;

const SEVERITY_EMOJI: Record<Severity, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  critical: '🚨',
  recovery: '✅',
};

/**
 * Slack brand palette — mid-tone, so they hold up against both the white and
 * the #1A1D21 dark canvas.
 *
 * `recovery` is green rather than 'a fill succeeded': green must mean "the
 * thing you were worried about is over". If every fill were green, green would
 * track trading volume instead of health — and a SELL at a realised loss would
 * render green, which is worse than useless.
 */
const SEVERITY_COLOR: Record<Severity, string> = {
  info: '#6B7280',
  warn: '#ECB22E',
  critical: '#E01E5A',
  recovery: '#2EB67D',
};

/**
 * Escape Slack mrkdwn control characters. Ampersand FIRST, or the escapes
 * introduced by the later replacements get double-escaped.
 *
 * Not a security boundary — nothing here is attacker-controlled. It is a
 * correctness one: an IBKR status string or a symbol containing `<`/`>` would
 * otherwise be swallowed as a link, and `<!channel>` would ping the channel.
 */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Plain-text rendering, UNESCAPED — for logs and the noop notifier, where
 * `&lt;` would be noise for a human reading a journal.
 *
 * Do NOT put this on the wire as-is: Slack renders the top-level `text` field
 * as mrkdwn, so an unescaped `<!channel>` arriving in an IBKR status string
 * would ping the channel. renderSlackPayload escapes it.
 */
export function renderText(e: NotifyEvent, meta: RenderMeta): string {
  const head = `${SEVERITY_EMOJI[e.severity]} ${e.title}`;
  const parts = [head];
  if (e.body) parts.push(e.body);
  if (e.fields?.length) parts.push(e.fields.map((f) => `${f.label}: ${f.value}`).join(' | '));
  parts.push(footer(e, meta));
  // Never empty: `title` is required, so `head` always carries content.
  return truncate(parts.filter(Boolean).join(' — '), 4000);
}

function footer(e: NotifyEvent, meta: RenderMeta): string {
  return [e.agent, meta.mode, meta.at].filter(Boolean).join(' · ');
}

export function renderSlackPayload(e: NotifyEvent, meta: RenderMeta): SlackPayload {
  // Escaped: Slack renders the top-level `text` as mrkdwn. `fallback` gets the
  // same treatment — a literal `&lt;` in a push preview is a cosmetic wart; an
  // unintended @channel at 3am is not.
  const text = escapeMrkdwn(renderText(e, meta));
  const blocks: unknown[] = [];

  // Headline. `text` is required, so this section always has content — an empty
  // section would 400 the entire post.
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: truncate(`*${escapeMrkdwn(`${SEVERITY_EMOJI[e.severity]} ${e.title}`)}*`, MAX_SECTION_TEXT),
    },
  });

  if (e.body?.trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(escapeMrkdwn(e.body), MAX_SECTION_TEXT) },
    });
  }

  const fields = (e.fields ?? []).filter((f) => f.label?.trim() || f.value?.trim());
  for (let i = 0; i < fields.length; i += MAX_FIELDS_PER_SECTION) {
    blocks.push({
      type: 'section',
      fields: fields.slice(i, i + MAX_FIELDS_PER_SECTION).map((f) => ({
        type: 'mrkdwn',
        text: truncate(`*${escapeMrkdwn(f.label)}*\n${escapeMrkdwn(f.value)}`, MAX_FIELD_TEXT),
      })),
    });
  }

  const foot = footer(e, meta);
  if (foot) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: truncate(escapeMrkdwn(foot), MAX_SECTION_TEXT) }].slice(
        0,
        MAX_CONTEXT_ELEMENTS,
      ),
    });
  }

  return {
    text,
    attachments: [
      {
        color: SEVERITY_COLOR[e.severity],
        fallback: text,
        blocks: blocks.slice(0, MAX_BLOCKS),
      },
    ],
  };
}

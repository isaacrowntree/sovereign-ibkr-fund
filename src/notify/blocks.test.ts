import { describe, it, expect } from 'vitest';
import { renderText, renderSlackPayload, escapeMrkdwn, type NotifyEvent, type Severity } from './blocks.js';

const META = { mode: 'paper', at: '2026-07-16T04:12:09Z' };
const SEVERITIES: Severity[] = ['info', 'warn', 'critical', 'recovery'];

const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  severity: 'info',
  title: 'Something happened',
  ...over,
});

/** Every mrkdwn section/field in a payload, flattened. */
function textsOf(p: ReturnType<typeof renderSlackPayload>): string[] {
  const out: string[] = [];
  for (const b of p.attachments[0].blocks as Array<Record<string, any>>) {
    if (b.text?.text) out.push(b.text.text);
    for (const f of b.fields ?? []) out.push(f.text);
    for (const el of b.elements ?? []) out.push(el.text);
  }
  return out;
}

describe('the text fallback', () => {
  it.each(SEVERITIES)('is present and non-empty for severity=%s', (severity) => {
    const p = renderSlackPayload(ev({ severity }), META);
    expect(p.text).toBeTruthy();
    expect(p.text.length).toBeGreaterThan(0);
  });

  it('equals the attachment fallback', () => {
    const p = renderSlackPayload(ev({ body: 'detail', fields: [{ label: 'A', value: '1' }] }), META);
    expect(p.attachments[0].fallback).toBe(p.text);
  });

  it('carries the title, so a text-only client still gets the point', () => {
    expect(renderText(ev({ title: 'HARD STOP — drawdown 26.4%' }), META)).toContain('HARD STOP — drawdown 26.4%');
  });
});

describe('structure', () => {
  it('emits exactly one attachment', () => {
    expect(renderSlackPayload(ev(), META).attachments).toHaveLength(1);
  });

  it.each([
    ['info', '#6B7280'],
    ['warn', '#ECB22E'],
    ['critical', '#E01E5A'],
    ['recovery', '#2EB67D'],
  ] as const)('colours severity=%s as %s', (severity, color) => {
    expect(renderSlackPayload(ev({ severity }), META).attachments[0].color).toBe(color);
  });

  it('NEVER emits a header block — top-level text already renders as the headline', () => {
    for (const severity of SEVERITIES) {
      const blocks = renderSlackPayload(ev({ severity }), META).attachments[0].blocks as Array<{ type: string }>;
      expect(blocks.find((b) => b.type === 'header'), `severity ${severity} emitted a header — title would render twice`)
        .toBeUndefined();
    }
  });

  it('puts blocks inside the attachment, not top-level (that would forfeit the colour bar)', () => {
    const p = renderSlackPayload(ev(), META) as Record<string, unknown>;
    expect(p.blocks).toBeUndefined();
    expect((p.attachments as any)[0].blocks.length).toBeGreaterThan(0);
  });

  it('renders fields two-up as mrkdwn', () => {
    const p = renderSlackPayload(ev({ fields: [{ label: 'Drawdown', value: '26.4%' }] }), META);
    const fieldBlock = (p.attachments[0].blocks as Array<any>).find((b) => b.fields);
    expect(fieldBlock.fields[0]).toEqual({ type: 'mrkdwn', text: '*Drawdown*\n26.4%' });
  });

  it('puts agent, mode and timestamp in the context footer', () => {
    const p = renderSlackPayload(ev({ agent: 'risk-manager' }), { mode: 'live', at: '2026-07-16T04:12:09Z' });
    const ctx = (p.attachments[0].blocks as Array<any>).find((b) => b.type === 'context');
    expect(ctx.elements[0].text).toBe('risk-manager · live · 2026-07-16T04:12:09Z');
  });
});

describe('no empty blocks (an empty section 400s the entire post)', () => {
  it('emits no empty section when body/fields/agent are all absent', () => {
    const blocks = renderSlackPayload(ev(), META).attachments[0].blocks as Array<any>;
    for (const b of blocks) {
      if (b.type === 'section' && b.text) expect(b.text.text.length).toBeGreaterThan(0);
      if (b.type === 'section' && b.fields) expect(b.fields.length).toBeGreaterThan(0);
      if (b.type === 'context') expect(b.elements.length).toBeGreaterThan(0);
    }
  });

  it('drops a fields array that is present but empty', () => {
    const blocks = renderSlackPayload(ev({ fields: [] }), META).attachments[0].blocks as Array<any>;
    expect(blocks.find((b) => b.fields)).toBeUndefined();
  });

  it('drops fields whose label and value are both blank', () => {
    const blocks = renderSlackPayload(ev({ fields: [{ label: '  ', value: '' }] }), META).attachments[0]
      .blocks as Array<any>;
    expect(blocks.find((b) => b.fields)).toBeUndefined();
  });

  it('does not emit an empty body section for a whitespace-only body', () => {
    const blocks = renderSlackPayload(ev({ body: '   ' }), META).attachments[0].blocks as Array<any>;
    expect(blocks.filter((b) => b.type === 'section' && b.text)).toHaveLength(1); // headline only
  });
});

describe('Slack limits are self-enforced', () => {
  it('truncates section text at 3000', () => {
    const p = renderSlackPayload(ev({ body: 'x'.repeat(5000) }), META);
    for (const t of textsOf(p)) expect(t.length).toBeLessThanOrEqual(3000);
  });

  it('truncates each field at 2000, not 3000', () => {
    const p = renderSlackPayload(ev({ fields: [{ label: 'L', value: 'y'.repeat(4000) }] }), META);
    const fieldBlock = (p.attachments[0].blocks as Array<any>).find((b) => b.fields);
    expect(fieldBlock.fields[0].text.length).toBeLessThanOrEqual(2000);
  });

  it('chunks more than 10 fields across sections rather than overflowing one', () => {
    const fields = Array.from({ length: 25 }, (_, i) => ({ label: `L${i}`, value: `${i}` }));
    const p = renderSlackPayload(ev({ fields }), META);
    const fieldBlocks = (p.attachments[0].blocks as Array<any>).filter((b) => b.fields);
    expect(fieldBlocks.length).toBe(3);
    for (const b of fieldBlocks) expect(b.fields.length).toBeLessThanOrEqual(10);
  });

  it('caps total blocks at 50', () => {
    const fields = Array.from({ length: 1000 }, (_, i) => ({ label: `L${i}`, value: `${i}` }));
    const p = renderSlackPayload(ev({ fields }), META);
    expect(p.attachments[0].blocks.length).toBeLessThanOrEqual(50);
  });

  it('caps the text fallback well under Slack 40k', () => {
    const p = renderSlackPayload(ev({ body: 'z'.repeat(100_000) }), META);
    expect(p.text.length).toBeLessThanOrEqual(4000);
  });
});

describe('mrkdwn escaping', () => {
  it('escapes & first, so later escapes are not double-escaped', () => {
    expect(escapeMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeMrkdwn('&lt;')).toBe('&amp;lt;');
  });

  it('neutralises a channel ping smuggled in via a status string', () => {
    const p = renderSlackPayload(ev({ title: 'order rejected: <!channel> everyone' }), META);
    for (const t of textsOf(p)) expect(t).not.toContain('<!channel>');
    expect(textsOf(p).some((t) => t.includes('&lt;!channel&gt;'))).toBe(true);
  });

  // Regression: an earlier version escaped only the blocks. Slack renders the
  // TOP-LEVEL `text` as mrkdwn, so a raw <!channel> there pings the channel —
  // caught only by inspecting the whole payload, which is why this asserts on
  // the serialised bytes rather than on textsOf().
  it('escapes the top-level text and fallback, not just the blocks', () => {
    const p = renderSlackPayload(ev({ title: 'order rejected: <!channel> & <https://x|click>' }), META);
    expect(p.text).not.toContain('<!channel>');
    expect(p.attachments[0].fallback).not.toContain('<!channel>');
    expect(JSON.stringify(p), 'no unescaped angle bracket may reach the wire anywhere').not.toMatch(/<[!/a-zA-Z]/);
  });

  it('renderText stays UNESCAPED for logs — humans read the journal', () => {
    expect(renderText(ev({ title: 'a < b & c' }), META)).toContain('a < b & c');
  });

  it('escapes angle brackets in field values (IBKR status strings)', () => {
    const p = renderSlackPayload(ev({ fields: [{ label: 'Status', value: '<pending|cancel>' }] }), META);
    const fieldBlock = (p.attachments[0].blocks as Array<any>).find((b) => b.fields);
    expect(fieldBlock.fields[0].text).toContain('&lt;pending|cancel&gt;');
  });
});

describe('hostile values do not throw', () => {
  // executor computes decisionPrice as estimatedValue / qty — a zero
  // estimatedValue yields Infinity/NaN, which reaches the renderer as a string.
  it.each(['Infinity', 'NaN', '-Infinity'])('renders slippage of %s without throwing', (v) => {
    expect(() => renderSlackPayload(ev({ fields: [{ label: 'Slippage', value: `${v} bps` }] }), META)).not.toThrow();
  });

  it('renders an empty-string title without producing an empty block', () => {
    const blocks = renderSlackPayload(ev({ title: '' }), META).attachments[0].blocks as Array<any>;
    expect(blocks[0].text.text.length).toBeGreaterThan(0); // emoji still carries content
  });
});

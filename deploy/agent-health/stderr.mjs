/**
 * The one line of a failed run's stderr that says why.
 *
 * paperclip records every failure as `adapter_failed`. That code hid an IP
 * whitelist rejection, a key without trade permission for three days, and an
 * order-precision bug. The explanation was always in stderr_excerpt; this
 * pulls it out so pi.lan/ops can show it next to the code.
 *
 * Recognised, most specific first:
 *   FATAL: <why>                    (trading-bot, run-agent.sh)
 *   Fatal error: Error: <why>       (a Node dump — first line only)
 *   ERROR: Fatal — <why>            (the fund's agents)
 *   ERROR: <why>                    (fallback)
 *
 * Output lands on a LAN page and in the feed, so signatures, API keys and
 * IBKR account ids are redacted, and it is capped.
 */
const MAX = 160;

function redact(s) {
  return s
    .replace(/(signature=)[^&\s]+/gi, '$1<redacted>')
    .replace(/(api[-_]?key\s*[=:]\s*)\S+/gi, '$1<redacted>')
    .replace(/\b(?:DU|U)\d{6,}\b/g, '<acct>');
}

function cap(s) {
  return s.length > MAX ? s.slice(0, MAX - 3) + '...' : s;
}

export function summariseStderr(text) {
  if (!text) return null;
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = (re, last = false) => {
    const found = (last ? [...lines].reverse() : lines).map((l) => l.match(re)).find(Boolean);
    return found ? found[1].trim() : null;
  };
  const why =
    pick(/^(?:\[run-agent\] )?FATAL: (.+)$/, true) ??
    pick(/Fatal error: (?:\w*Error: )?(.+)$/) ??
    pick(/\bERROR: Fatal — (.+)$/, true) ??
    pick(/\bERROR: (.+)$/);
  return why ? cap(redact(why)) : null;
}

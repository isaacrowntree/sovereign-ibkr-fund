/**
 * The operator's night: 23:00–07:00 local (decision D5, 2026-09-24).
 *
 * Inside it nothing unattended may do something that ends in an IB Key push or
 * destroys a working session: no container restart unless the gateway process
 * is actually dead, and no clearing of relogin's park. A push at 02:00 is a push
 * nobody taps, which parks the fund anyway — so acting buys nothing but a buzz
 * on a phone beside a sleeping person. It is also US regular trading hours, the
 * worst time to bounce the gateway under the execution bot.
 *
 * Asked of the zone database rather than an offset: Sydney has DST.
 *
 *   QUIET_HOURS_TZ  default Australia/Sydney
 *   QUIET_HOURS     default "23-7" (start hour inclusive, end hour exclusive)
 */
export function quietHours(): { tz: string; start: number; end: number } {
  const tz = process.env.QUIET_HOURS_TZ || 'Australia/Sydney';
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(process.env.QUIET_HOURS ?? '');
  return { tz, start: m ? Number(m[1]) : 23, end: m ? Number(m[2]) : 7 };
}

export function localHour(at: Date, tz: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(at);
  return Number(h) % 24;
}

export function isQuietHours(at: Date, q = quietHours()): boolean {
  const h = localHour(at, q.tz);
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

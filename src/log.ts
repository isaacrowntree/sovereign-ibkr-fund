const ts = () => new Date().toISOString().slice(11, 19);

export function log(msg: string, agent?: string): void {
  const prefix = agent ? `[${ts()}] [${agent}]` : `[${ts()}]`;
  console.log(`${prefix} ${msg}`);
}

export function logError(msg: string, err?: unknown, agent?: string): void {
  const prefix = agent ? `[${ts()}] [${agent}]` : `[${ts()}]`;
  const detail = err instanceof Error ? err.message : String(err ?? '');
  console.error(`${prefix} ERROR: ${msg}${detail ? ' — ' + detail : ''}`);
}

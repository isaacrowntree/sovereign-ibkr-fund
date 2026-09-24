import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildScriptRoot, freshStateDir, type ScriptRoot } from '../harness/scripts';
import { putState, getState, openLedger } from '../harness/ledger';

/**
 * D4: the deposit scripts write `pendingOrders` straight into the ledger. They
 * must wait for a lock rather than die on it, and must never overwrite a queue
 * that appeared between their check and their write.
 */
let root: ScriptRoot;

beforeAll(() => { root = buildScriptRoot(); }, 120_000);
afterAll(() => root?.cleanup());

// Synthetic book: two names, round numbers.
function arrange(state: string) {
  putState(state, {
    lastSnapshot: {
      netLiquidation: 10_000, cashValue: 2_000,
      holdings: [{ symbol: 'AAA', currentValue: 4_000 }, { symbol: 'BBB', currentValue: 4_000 }],
    },
    lastPriceSnapshots: [{ symbol: 'AAA', price: 100 }, { symbol: 'BBB', price: 50 }],
  });
  const targets = join(state, 'targets.json');
  writeFileSync(targets, JSON.stringify({ AAA: 50, BBB: 50 }));
  return targets;
}

/** Hold the write lock from another process for `ms`, like an agent mid-write. */
function holdWriteLock(dbPath: string, ms: number): Promise<void> {
  const src = `
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(${JSON.stringify(dbPath)});
    d.exec('BEGIN IMMEDIATE');
    process.stdout.write('LOCKED');
    setTimeout(() => { d.exec('COMMIT'); d.close(); }, ${ms});
  `;
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.once('data', () => res());
    c.on('error', rej);
  });
}

describe('scripts/lib/state-db.mjs', () => {
  it('stages into an empty queue and refuses a non-empty one, in one transaction', async () => {
    const lib = await import(resolve(__dirname, '../../scripts/lib/state-db.mjs'));
    const state = freshStateDir(root.root, 'lib');
    openLedger(state).close();
    const db = lib.openStateDb(join(state, 'bot-state.db'), { write: true });
    expect(lib.stageQueueIfEmpty(db, [{ symbol: 'AAA', qty: 1 }])).toEqual({ staged: true });
    expect(lib.stageQueueIfEmpty(db, [{ symbol: 'BBB', qty: 9 }])).toEqual({ staged: false, existing: 1 });
    expect(lib.readStateKey(db, 'pendingOrders')).toEqual([{ symbol: 'AAA', qty: 1 }]);
    db.close();
  });
});

describe('stage-deposit-buy.mjs', () => {
  it('waits out another writer instead of dying with "database is locked"', async () => {
    const state = freshStateDir(root.root, 'lockwait');
    const targets = arrange(state);
    await holdWriteLock(join(state, 'bot-state.db'), 1200);
    const r = await root.run('stage-deposit-buy.mjs', ['--targets', targets, '--confirm'], { STATE_DIR: state });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect((getState(state).pendingOrders ?? []).length).toBeGreaterThan(0);
  });

  it('refuses to overwrite an existing queue', async () => {
    const state = freshStateDir(root.root, 'refuse');
    const targets = arrange(state);
    putState(state, { pendingOrders: [{ symbol: 'ZZZ', action: 'SELL', qty: 3 }] });
    const r = await root.run('stage-deposit-buy.mjs', ['--targets', targets, '--confirm'], { STATE_DIR: state });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/REFUSING/);
    expect(getState(state).pendingOrders).toEqual([{ symbol: 'ZZZ', action: 'SELL', qty: 3 }]);
  });
});

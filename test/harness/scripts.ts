/**
 * Run the operator scripts (`scripts/*.mjs`) the way the Pi does: against a
 * compiled `dist/`, as a separate process, with STATE_DIR pointing at a ledger.
 *
 * The scripts import `../dist/...`, so a throwaway root is laid out with a
 * fresh build of src/ beside a copy of scripts/. Built once per test file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '../..');

export interface ScriptRoot {
  root: string;
  /** Load a dist module in THIS process (e.g. the store, to seed or inspect a ledger). */
  load<T = any>(rel: string): T;
  run(script: string, args: string[], env: Record<string, string>): Promise<ScriptResult>;
  cleanup(): void;
}

export interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function buildScriptRoot(): ScriptRoot {
  const root = mkdtempSync(join(tmpdir(), 'fund-scripts-'));
  const tsc = spawnSync(
    process.execPath,
    [resolve(REPO, 'node_modules/typescript/bin/tsc'), '-p', REPO, '--outDir', join(root, 'dist'), '--declaration', 'false', '--sourceMap', 'false'],
    { encoding: 'utf8' },
  );
  if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.stdout}\n${tsc.stderr}`);
  cpSync(resolve(REPO, 'scripts'), join(root, 'scripts'), { recursive: true });
  symlinkSync(resolve(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  const req = createRequire(join(root, 'index.js'));

  return {
    root,
    load: (rel) => req(join(root, rel)),
    run: (script, args, env) =>
      new Promise((res) => {
        const child = spawn(process.execPath, [join(root, 'scripts', script), ...args], {
          cwd: root,
          // A clean env: nothing from the developer's shell (a real BEZANT_URL,
          // a real STATE_DIR) may leak into a test run.
          env: { PATH: process.env.PATH ?? '', HOME: root, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => res({ code, stdout, stderr }));
      }),
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

export function freshStateDir(root: string, name: string): string {
  const dir = join(root, 'state-' + name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
